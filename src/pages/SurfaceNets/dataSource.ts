/**
 * 数据源管理器
 * 负责处理数据获取逻辑，包括缓存检查、预处理请求、chunk 加载等
 */

import ChunkLoaderWorker from "./chunkLoader.worker.ts?worker";
import { indexedDBManager } from "./indexedDB";
import { recordPerformanceFromResponse } from "@/common/performance";

const SHAPE_CACHE_KEY_PREFIX = "voxel-grid-shape_";

function getShapeCacheKey(filename: string, chunkSize: number): string {
  return `${SHAPE_CACHE_KEY_PREFIX}${filename}_${chunkSize}`;
}

// Worker 数量固定为 5 个
const THREAD_COUNT = 5;

// 预处理响应类型
export interface PreprocessResponse {
  task_id: string;
  file: string;
  file_size: number;
  shape: [number, number, number];
  data_length: number;
  chunk_size: number;
  chunks: Array<{ index: number; start: number; end: number }>;
}

// Chunk 数据结果
export interface ChunkResult {
  chunkIndex: number;
  buffer: ArrayBuffer;
  min: number;
  max: number;
  fromCache: boolean;
}

// 数据加载结果
export interface DataLoadResult {
  chunks: ChunkResult[];
  shape: [number, number, number];
  dataLength: number;
  taskId: string | null;
  allFromCache: boolean; // 是否全部来自缓存
}

/**
 * 数据源管理器类
 */
export class DataSource {
  /**
   * 检查所有 chunk 是否都已缓存
   */
  async checkAllChunksCached(
    filename: string,
    chunkSize: number,
    chunks: Array<{ index: number; start: number; end: number }>
  ): Promise<boolean> {
    const cachePromises = chunks.map((chunk) =>
      indexedDBManager.getChunk(filename, chunkSize, chunk.index)
    );
    const cacheResults = await Promise.all(cachePromises);

    const allCached = cacheResults.every((cached) => cached !== null);

    return allCached;
  }

  /**
   * 从缓存加载所有 chunk
   * 返回结果和时间统计
   */
  async loadChunksFromCache(
    filename: string,
    chunkSize: number,
    chunks: Array<{ index: number; start: number; end: number }>
  ): Promise<ChunkResult[]> {
    const cachePromises = chunks.map(async (chunk) => {
      const cached = await indexedDBManager.getChunk(
        filename,
        chunkSize,
        chunk.index
      );
      if (!cached) {
        throw new Error(`Chunk ${chunk.index} 缓存不存在`);
      }
      return {
        chunkIndex: chunk.index,
        buffer: cached.buffer,
        min: cached.min,
        max: cached.max,
        fromCache: true,
      };
    });

    // 等待所有缓存加载完成（从第一个开始到最后一个完成）
    const results = await Promise.all(cachePromises);
    return results;
  }

  /**
   * 从后端加载数据
   */
  async loadDataFromBackend(
    filename: string,
    chunkSize: number,
    preprocessResponse: PreprocessResponse
  ): Promise<ChunkResult[]> {
    const taskId = preprocessResponse.task_id;
    const chunks = preprocessResponse.chunks;
    const chunkLoaders: Worker[] = [];
    const chunkPromises: Promise<ChunkResult>[] = [];

    // Worker 数量固定为 5 个（不超过 chunks 数量）
    const activeWorkerCount = Math.min(THREAD_COUNT, chunks.length);

    // 先查询所有 chunk 的缓存
    const cacheQueries = chunks.map(async (chunk) => {
      const cached = await indexedDBManager.getChunk(
        filename,
        chunkSize,
        chunk.index
      );
      return { chunk, cached };
    });

    const cacheResults = await Promise.all(cacheQueries);
    for (let i = 0; i < cacheResults.length; i++) {
      const { chunk, cached } = cacheResults[i];

      // 如果缓存存在，直接使用缓存
      if (cached) {
        const promise = Promise.resolve({
          chunkIndex: chunk.index,
          buffer: cached.buffer,
          min: cached.min,
          max: cached.max,
          fromCache: true,
        });
        chunkPromises.push(promise);
        continue;
      }

      // 缓存不存在，使用 Worker 请求
      const workerIndex = i % activeWorkerCount;

      // 复用 worker 或创建新的
      if (chunkLoaders.length <= workerIndex) {
        const worker = new ChunkLoaderWorker();
        chunkLoaders.push(worker);
      }

      const worker = chunkLoaders[workerIndex];

      const promise = new Promise<ChunkResult>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          if (e.data.type === "chunk" && e.data.chunkIndex === chunk.index) {
            worker.removeEventListener("message", handler);

            resolve({
              chunkIndex: chunk.index,
              buffer: e.data.buffer,
              min: e.data.min,
              max: e.data.max,
              fromCache: false,
            });
          } else if (
            e.data.type === "error" &&
            e.data.chunkIndex === chunk.index
          ) {
            worker.removeEventListener("message", handler);
            reject(new Error(e.data.error));
          }
        };
        worker.addEventListener("message", handler);

        worker.postMessage({
          type: "fetch-chunk",
          taskId: taskId,
          chunkIndex: chunk.index,
          start: chunk.start,
          length: chunk.end - chunk.start,
          sessionId: tracker.getSessionId(), // 传递 sessionId 给 Worker
          workerIndex: workerIndex, // 传递 worker 索引，用于标识
        });
      });

      chunkPromises.push(promise);
    }

    // 等待所有 chunk 加载完成
    const results = await Promise.all(chunkPromises);

    // 发送 pre-close 消息给所有 worker，等待它们完成性能追踪
    const closePromises = chunkLoaders.map((worker) => {
      return new Promise<void>((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data.type === "close-ok") {
            worker.removeEventListener("message", handler);
            resolve();
          }
        };
        worker.addEventListener("message", handler);

        // 发送 pre-close 消息
        worker.postMessage({ type: "pre-close" });

        // 设置超时，避免无限等待
        setTimeout(() => {
          worker.removeEventListener("message", handler);
          console.warn("[DataSource] Worker 关闭超时，强制终止");
          resolve();
        }, 5000); // 5 秒超时
      });
    });

    // 等待所有 worker 完成性能追踪
    await Promise.all(closePromises);

    // 现在可以安全地终止所有 worker
    chunkLoaders.forEach((w) => w.terminate());

    return results;
  }

  /**
   * 主加载方法：统一处理数据获取逻辑
   */
  async loadData(filename: string, chunkSize: number): Promise<DataLoadResult> {
    // 1. 先尝试从缓存获取 shape 和 chunks 信息
    let preprocessResponse: PreprocessResponse | null = null;
    let chunks: Array<{ index: number; start: number; end: number }>;
    let shape: [number, number, number];
    let dataLength: number;
    let taskId: string | null = null;

    const cachedShape = this.getShapeFromCache(filename, chunkSize);

    // 2. 检查是否所有 chunk 都已缓存
    let allCached = false;
    if (cachedShape) {
      chunks = cachedShape.chunks;
      shape = cachedShape.shape;
      dataLength = cachedShape.dataLength;
      allCached = await this.checkAllChunksCached(filename, chunkSize, chunks);
    }

    let chunkResults: ChunkResult[];

    if (allCached) {
      // 全部来自缓存：从第一个缓存开始到最后一个缓存完成的时间
      chunkResults = await this.loadChunksFromCache(
        filename,
        chunkSize,
        chunks!
      );
    } else {
      const sessionId = tracker ? tracker.getSessionId() : undefined;
      const preprocessRes = await fetch("/api/voxel-grid/preprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: filename,
          chunk_size: chunkSize,
          session_id: sessionId, // 传递 sessionId 给后端
        }),
      });

      // 解析响应头中的性能数据
      if (tracker) {
        const sessionId = tracker.getSessionId();
        await recordPerformanceFromResponse(
          preprocessRes.clone(),
          sessionId
        ).catch(() => {
          // 忽略解析错误
        });
      }

      if (!preprocessRes.ok) {
        const errorData = await preprocessRes
          .json()
          .catch(() => ({ error: `HTTP ${preprocessRes.status}` }));
        throw new Error(
          errorData.error || `预处理失败: HTTP ${preprocessRes.status}`
        );
      }

      preprocessResponse = await preprocessRes.json();

      if (!preprocessResponse) {
        throw new Error("预处理响应为空");
      }

      taskId = preprocessResponse.task_id;
      chunks = preprocessResponse.chunks;
      shape = preprocessResponse.shape;
      dataLength = preprocessResponse.data_length;

      this.saveShapeToCache(filename, chunkSize, shape, chunks, dataLength);

      // 从后端加载数据：从预处理请求开始到最后一个 chunk 完成的时间
      chunkResults = await this.loadDataFromBackend(
        filename,
        chunkSize,
        preprocessResponse
      );
    }

    chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);

    // 在空闲时间保存非缓存的 chunk 到 IndexedDB
    const chunksToSave = chunkResults.filter((r) => !r.fromCache);
    if (chunksToSave.length > 0) {
      const saveChunksToCache = () => {
        chunksToSave.forEach((result) => {
          const bufferCopy = result.buffer.slice(0);
          indexedDBManager
            .saveChunk(
              filename,
              chunkSize,
              result.chunkIndex,
              bufferCopy,
              result.min,
              result.max
            )
            .catch((err) => {
              console.error(
                `[IndexedDB] 保存 chunk ${result.chunkIndex} 失败:`,
                err
              );
            });
        });
      };

      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(saveChunksToCache, { timeout: 5000 });
      } else {
        setTimeout(saveChunksToCache, 1000);
      }
    }

    return {
      chunks: chunkResults,
      shape: shape!,
      dataLength: dataLength!,
      taskId,
      allFromCache: allCached,
    };
  }

  getShapeFromCache(
    filename: string,
    chunkSize: number
  ): {
    shape: [number, number, number];
    chunks: Array<{ index: number; start: number; end: number }>;
    dataLength: number;
  } | null {
    try {
      const key = getShapeCacheKey(filename, chunkSize);
      const cached = localStorage.getItem(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      console.warn("[DataSource] 读取 shape 缓存失败:", err);
    }
    return null;
  }

  /**
   * 缓存 shape 信息到 localStorage 的工具函数
   * @param filename - 文件名
   * @param chunkSize - 分块大小
   * @param shape - 形状
   * @param chunks - 分块
   * @param dataLength - 数据长度
   */
  saveShapeToCache(
    filename: string,
    chunkSize: number,
    shape: [number, number, number],
    chunks: Array<{ index: number; start: number; end: number }>,
    dataLength: number
  ): void {
    try {
      const key = getShapeCacheKey(filename, chunkSize);
      const data = { shape, chunks, dataLength };
      localStorage.setItem(key, JSON.stringify(data));
    } catch (err) {
      console.warn("[DataSource] 保存 shape 缓存失败:", err);
    }
  }
}

// 导出单例
export const dataSource = new DataSource();

declare global {
  interface Window {
    dataSource: DataSource;
  }
}

window.dataSource = dataSource;
