/// <reference lib="webworker" />

// @ts-expect-error - surfacenets.js 没有类型定义
import { surfaceNets } from './surfacenets.js';
import { openDB, type IDBPDatabase } from 'idb';

// Worker 消息类型
type WorkerInputMessage =
  | { type: 'load'; filename: string; level?: number; min?: number; max?: number };

type WorkerOutputMessage =
  | { type: 'result'; positionsData: ArrayBuffer; positionsLength: number; cellsData: ArrayBuffer; cellsLength: number; shape: [number, number, number]; min: number; max: number; level: number }
  | { type: 'error'; error: string };

// 为 postMessage 提供更精确的类型
const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

interface NetworkTimings {
  fetchMs?: number;
  decompressMs?: number;
  parseBinaryMs?: number;
  rangeMs?: number;
  backendParseMs?: number;
  backendCompressMs?: number;
  backendTotalMs?: number;
}

interface ResultTimings extends NetworkTimings {
  cacheSource: 'memory' | 'idb' | 'network';
  surfaceMs: number;
  packMs: number;
  totalWorkerMs: number;
}

// ================= VoxelResource 缓存 =================

type VoxelRecord = {
  shape: [number, number, number];
  dataBuffer: ArrayBuffer; // Float64Array.buffer
  min: number;
  max: number;
};

type CacheGetResult = { record: VoxelRecord; source: 'memory' | 'idb' } | null;

class VoxelResource {
  private memoryCache: Map<string, VoxelRecord> = new Map();
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private getDB(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB('voxel-cache', 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('volumes')) {
            db.createObjectStore('volumes');
          }
        },
      });
    }
    return this.dbPromise;
  }

  async get(filename: string): Promise<CacheGetResult> {
    // 1) 先查内存
    const mem = this.memoryCache.get(filename);
    if (mem) return { record: mem, source: 'memory' };

    // 2) 再查 IndexedDB
    const db = await this.getDB();
    const rec = await db.get('volumes', filename);
    if (rec) {
      const record = rec as VoxelRecord;
      this.memoryCache.set(filename, record);
      return { record, source: 'idb' };
    }
    return null;
  }

  putIntoMemory(filename: string, record: VoxelRecord) {
    this.memoryCache.set(filename, record);
  }

  async putIntoIDB(filename: string, record: VoxelRecord): Promise<void> {
    const db = await this.getDB();
    await db.put('volumes', record, filename);
  }
}

const voxelResource = new VoxelResource();

// ================= 处理来自主线程的消息 =================

self.addEventListener('message', async (event: MessageEvent<WorkerInputMessage>) => {
  if (event.data.type === 'load') {
    try {
      const { filename } = event.data;

      // 优先使用缓存（1. 内存 2. IndexedDB）
      let shape: [number, number, number];
      let data: Float64Array;
      let min: number;
      let max: number;
      let cacheSource: 'memory' | 'idb' | 'network' = 'network';

      const tStart = performance.now();
      const cached = await voxelResource.get(filename);
      if (cached) {
        cacheSource = cached.source;
        shape = cached.record.shape;
        data = new Float64Array(cached.record.dataBuffer);
        min = cached.record.min;
        max = cached.record.max;
      } else {
        const tFetchStart = performance.now();
        // 1. 网络请求压缩体素数据
        const response = await fetch(`/api/voxel-grid?file=${encodeURIComponent(filename)}`);
        if (!response.ok) {
          try {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
          } catch {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        }
        const tFetchEnd = performance.now();
        const fetchMs = tFetchEnd - tFetchStart;

        // 读取后端时延头
        const backendParseMs = Number(response.headers.get('X-Parse-Duration-ms') || '0');
        const backendCompressMs = Number(response.headers.get('X-Compress-Duration-ms') || '0');
        const backendTotalMs = Number(response.headers.get('X-Total-Duration-ms') || '0');

        const tDecompStart = performance.now();
        // 2. 读取 ArrayBuffer 并解压（gzip）
        const compressedArrayBuffer = await response.arrayBuffer();
        const decompressionStream = new DecompressionStream('gzip');
        const writer = decompressionStream.writable.getWriter();
        const reader = decompressionStream.readable.getReader();
        const readPromise = (async () => {
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
            return chunks;
          } finally {
            reader.releaseLock();
          }
        })();
        try {
          await writer.write(new Uint8Array(compressedArrayBuffer));
          await writer.close();
        } catch (error) {
          writer.abort();
          throw error;
        }
        const chunks = await readPromise;
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const decompressed = new Uint8Array(totalLength);
        {
          let offset = 0;
          for (const chunk of chunks) {
            decompressed.set(chunk, offset);
            offset += chunk.length;
          }
        }
        const tDecompEnd = performance.now();
        const decompressMs = tDecompEnd - tDecompStart;

        const tParseStart = performance.now();
        // 3. 解析二进制头 + 数据
        const dataView = new DataView(decompressed.buffer);
        let offsetBytes = 0;
        const shape0 = Number(dataView.getBigUint64(offsetBytes, true)); offsetBytes += 8;
        const shape1 = Number(dataView.getBigUint64(offsetBytes, true)); offsetBytes += 8;
        const shape2 = Number(dataView.getBigUint64(offsetBytes, true)); offsetBytes += 8;
        // 跳过 file_size（8 bytes）
        offsetBytes += 8;
        const data_length = Number(dataView.getBigUint64(offsetBytes, true)); offsetBytes += 8;

        shape = [shape0, shape1, shape2];
        data = new Float64Array(decompressed.buffer, offsetBytes, data_length);
        const tParseEnd = performance.now();
        const parseBinaryMs = tParseEnd - tParseStart;

        const tRangeStart = performance.now();
        // 4. 计算范围（或复用传入的 min/max）
        if (event.data.min !== undefined && event.data.max !== undefined) {
          min = event.data.min;
          max = event.data.max;
        } else {
          min = data[0];
          max = data[0];
          for (let i = 1; i < data.length; i++) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
          }
        }
        const tRangeEnd = performance.now();
        const rangeMs = tRangeEnd - tRangeStart;

        cacheSource = 'network';

        // 写入内存+异步 IDB
        const arrayBufferForMemory = (data.buffer as ArrayBuffer).slice(0);
        voxelResource.putIntoMemory(filename, {
          shape,
          dataBuffer: arrayBufferForMemory,
          min,
          max,
        });
        queueMicrotask(() => {
          const arrayBufferForIDB = (data.buffer as ArrayBuffer).slice(0);
          voxelResource.putIntoIDB(filename, {
            shape,
            dataBuffer: arrayBufferForIDB,
            min,
            max,
          }).catch(() => {});
        });

        // 将临时时延写入本地变量帧（供后续汇总）
        (self as unknown as { __lastNetworkTimings?: NetworkTimings }).__lastNetworkTimings = { fetchMs, decompressMs, parseBinaryMs, rangeMs, backendParseMs, backendCompressMs, backendTotalMs };
      }

      // 5. 使用 level 生成等值面
      const tSurfaceStart = performance.now();
      const selectedLevel = event.data.level !== undefined ? event.data.level : (min + max) / 2;
      const [xm, ym, zm] = shape;
      const potential = (x: number, y: number, z: number): number => {
        const i = Math.floor(x) - 1;
        const j = Math.floor(y) - 1;
        const k = Math.floor(z) - 1;
        const idx = ((i + xm) % xm + xm) % xm;
        const idy = ((j + ym) % ym + ym) % ym;
        const idz = ((k + zm) % zm + zm) % zm;
        const index = idz * xm * ym + idy * xm + idx;
        return data[index] - selectedLevel;
      };
      const extendedShape: [number, number, number] = [shape[0] + 2, shape[1] + 2, shape[2] + 2];
      const result = surfaceNets(extendedShape, potential, undefined);
      const tSurfaceEnd = performance.now();
      const surfaceMs = tSurfaceEnd - tSurfaceStart;

      // 6. 回传结果
      const tPackStart = performance.now();
      const flatPositions = new Float32Array(result.positions.length * 3);
      for (let i = 0; i < result.positions.length; i++) {
        flatPositions[i * 3] = result.positions[i][0];
        flatPositions[i * 3 + 1] = result.positions[i][1];
        flatPositions[i * 3 + 2] = result.positions[i][2];
      }
      const flatCells = new Uint32Array(result.cells.flat());
      const tPackEnd = performance.now();
      const packMs = tPackEnd - tPackStart;

      const timingsContainer = (self as unknown as { __lastNetworkTimings?: NetworkTimings });
      const timings: NetworkTimings = timingsContainer.__lastNetworkTimings || {};

      const message: WorkerOutputMessage & { timings: ResultTimings } = {
        type: 'result',
        positionsData: flatPositions.buffer,
        positionsLength: result.positions.length,
        cellsData: flatCells.buffer,
        cellsLength: result.cells.length,
        shape,
        min,
        max,
        level: selectedLevel,
        timings: {
          cacheSource,
          surfaceMs,
          packMs,
          ...timings,
          totalWorkerMs: performance.now() - tStart,
        },
      };
      ctx.postMessage(message, [flatPositions.buffer, flatCells.buffer]);
    } catch (error) {
      const errorMessage: WorkerOutputMessage = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(errorMessage);
    }
  }
});
