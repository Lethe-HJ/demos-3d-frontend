/**
 * 数据源管理器
 * 负责处理数据获取逻辑，包括缓存检查、预处理请求、chunk 加载等
 */

import ChunkLoaderWorker from "./chunkLoader.worker.ts?worker";
import { indexedDBManager } from "./indexedDB";
import type { PerformanceTracker } from "@/common/performance";
import { recordPerformanceFromResponse } from "@/common/performance";

// 缓存 shape 信息到 localStorage 的工具函数
const SHAPE_CACHE_KEY_PREFIX = 'voxel-grid-shape_';

function getShapeCacheKey(filename: string, chunkSize: number): string {
  return `${SHAPE_CACHE_KEY_PREFIX}${filename}_${chunkSize}`;
}

function saveShapeToCache(filename: string, chunkSize: number, shape: [number, number, number], chunks: Array<{ index: number; start: number; end: number }>, dataLength: number): void {
  try {
    const key = getShapeCacheKey(filename, chunkSize);
    const data = { shape, chunks, dataLength };
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.warn('[DataSource] 保存 shape 缓存失败:', err);
  }
}

function getShapeFromCache(filename: string, chunkSize: number): { shape: [number, number, number]; chunks: Array<{ index: number; start: number; end: number }>; dataLength: number } | null {
  try {
    const key = getShapeCacheKey(filename, chunkSize);
    const cached = localStorage.getItem(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn('[DataSource] 读取 shape 缓存失败:', err);
  }
  return null;
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
  fetchMs: number; // 数据获取总耗时
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
    chunks: Array<{ index: number; start: number; end: number }>,
    tracker?: PerformanceTracker
  ): Promise<boolean> {
    if (tracker) {
      tracker.startEvent('check_cache', 'cache', 0, '检查缓存完整性');
    }

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
    chunks: Array<{ index: number; start: number; end: number }>,
    tracker?: PerformanceTracker
  ): Promise<ChunkResult[]> {
    if (tracker) {
      tracker.startEvent('load_from_cache_all', 'cache', 0, `从缓存加载所有chunk (${chunks.length}个)`);
    }

    const cachePromises = chunks.map(async (chunk) => {
      const chunkStartTime = Date.now();
      const cached = await indexedDBManager.getChunk(filename, chunkSize, chunk.index);
      const chunkEndTime = Date.now();
      
      if (tracker) {
        tracker.recordEvent(
          'loader',
          chunk.index,
          `加载缓存 Chunk ${chunk.index}`,
          chunkStartTime,
          chunkEndTime,
        );
      }
      
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
    
    if (tracker) {
      tracker.endEvent('load_from_cache_all');
    }
    
    return results;
  }

  /**
   * 从后端加载数据
   */
  async loadDataFromBackend(
    filename: string,
    chunkSize: number,
    preprocessResponse: PreprocessResponse,
    tracker?: PerformanceTracker
  ): Promise<ChunkResult[]> {
    const taskId = preprocessResponse.task_id;
    const chunks = preprocessResponse.chunks;
    const chunkLoaders: Worker[] = [];
    const chunkPromises: Promise<ChunkResult>[] = [];

    // Worker 数量固定为 5 个（不超过 chunks 数量）
    const activeWorkerCount = Math.min(THREAD_COUNT, chunks.length);

    if (tracker) {
      tracker.startEvent('query_chunk_cache', 'cache', 0, '查询chunk缓存');
    }

    // 先查询所有 chunk 的缓存
    const cacheQueries = chunks.map(async (chunk) => {
      const cacheStartTime = Date.now();
      const cached = await indexedDBManager.getChunk(filename, chunkSize, chunk.index);
      const cacheEndTime = Date.now();
      
      if (tracker && cached) {
        tracker.recordEvent(
          'loader',
          chunk.index,
          `查询缓存 Chunk ${chunk.index}`,
          cacheStartTime,
          cacheEndTime,
        );
      }
      
      return { chunk, cached };
    });

    const cacheResults = await Promise.all(cacheQueries);
    
    if (tracker) {
      tracker.endEvent('query_chunk_cache');
    }

    if (tracker) {
      tracker.startEvent('assign_workers', 'worker', 0, `分配Worker加载chunk (${activeWorkerCount}个Worker, ${chunks.length}个chunk)`);
    }

    for (let i = 0; i < cacheResults.length; i++) {
      const { chunk, cached } = cacheResults[i];

      // 如果缓存存在，直接使用缓存
      if (cached) {
        if (tracker) {
          const useCacheTime = Date.now();
          tracker.recordEvent(
            'loader',
            chunk.index,
            `加载缓存 Chunk ${chunk.index}`,
            useCacheTime,
            useCacheTime,
          );
        }
        
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
        
        if (tracker) {
          const createWorkerTime = Date.now();
          tracker.recordEvent(
            'worker',
            workerIndex,
            `创建 Worker ${workerIndex}`,
            createWorkerTime,
            createWorkerTime,
          );
        }
      }

      const worker = chunkLoaders[workerIndex];
      const requestStartTime = Date.now();
      
      const promise = new Promise<ChunkResult>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const receiveTime = Date.now();
          
          if (e.data.type === "chunk" && e.data.chunkIndex === chunk.index) {
            worker.removeEventListener("message", handler);
            
            if (tracker) {
              const networkTime = e.data.timings?.fetchMs || 0;
              tracker.recordEvent(
                'worker',
                workerIndex,
                `Worker ${workerIndex} 加载 Chunk ${chunk.index} (网络: ${networkTime}ms)`,
                requestStartTime,
                receiveTime,
              );
            }
            
            resolve({
              chunkIndex: chunk.index,
              buffer: e.data.buffer,
              min: e.data.min,
              max: e.data.max,
              fromCache: false,
            });
          } else if (e.data.type === "error" && e.data.chunkIndex === chunk.index) {
            worker.removeEventListener("message", handler);
            reject(new Error(e.data.error));
          }
        };
        worker.addEventListener("message", handler);
        
        if (tracker) {
          tracker.recordEvent(
            'network',
            workerIndex,
            `发送请求 Chunk ${chunk.index} (Worker ${workerIndex})`,
            requestStartTime,
            requestStartTime,
          );
        }
        
    // 获取 sessionId（如果 tracker 存在）
    const workerSessionId = tracker ? tracker.getSessionId() : undefined;
    
    worker.postMessage({
      type: "fetch-chunk",
      taskId: taskId,
      chunkIndex: chunk.index,
      start: chunk.start,
      length: chunk.end - chunk.start,
      sessionId: workerSessionId, // 传递 sessionId 给 Worker
      workerIndex: workerIndex, // 传递 worker 索引，用于标识
    });
      });

      chunkPromises.push(promise);
    }

    if (tracker) {
      tracker.endEvent('assign_workers');
      tracker.startEvent('wait_chunks', 'worker', 0, '等待所有chunk完成');
    }

    // 等待所有 chunk 加载完成
    const results = await Promise.all(chunkPromises);
    
    if (tracker) {
      tracker.endEvent('wait_chunks');
    }
    
    chunkLoaders.forEach((w) => w.terminate());

    return results;
  }

  /**
   * 主加载方法：统一处理数据获取逻辑
   */
  async loadData(
    filename: string,
    chunkSize: number,
    tracker?: PerformanceTracker
  ): Promise<DataLoadResult> {
    const tStart = Date.now();

    if (tracker) {
      tracker.startEvent('data_load_start', 'network', 0, '数据加载开始');
    }

    // 1. 先尝试从缓存获取 shape 和 chunks 信息
    let preprocessResponse: PreprocessResponse | null = null;
    let chunks: Array<{ index: number; start: number; end: number }>;
    let shape: [number, number, number];
    let dataLength: number;
    let taskId: string | null = null;

    let shapeCacheStartTime: number | null = null;
    if (tracker) {
      shapeCacheStartTime = Date.now();
      tracker.startEvent('query_shape_cache', 'cache', 0, '查询shape缓存');
    }

    const cachedShape = getShapeFromCache(filename, chunkSize);
    
    if (tracker) {
      const shapeCacheEndTime = Date.now();
      tracker.endEvent('query_shape_cache');
      if (cachedShape && shapeCacheStartTime) {
        tracker.recordEvent(
          'loader',
          0,
          'Shape缓存命中',
          shapeCacheStartTime,
          shapeCacheEndTime,
        );
      }
    }

    // 2. 检查是否所有 chunk 都已缓存
    let allCached = false;
    if (cachedShape) {
      chunks = cachedShape.chunks;
      shape = cachedShape.shape;
      dataLength = cachedShape.dataLength;
      allCached = await this.checkAllChunksCached(filename, chunkSize, chunks, tracker);
    }

    let chunkResults: ChunkResult[];
    let fetchMs: number;

    if (allCached) {
      // 全部来自缓存：从第一个缓存开始到最后一个缓存完成的时间
      chunkResults = await this.loadChunksFromCache(filename, chunkSize, chunks!, tracker);
      fetchMs = performance.now() - tStart;
    } else {
      // 需要发送预处理请求获取 shape 和 chunks 信息
      let preprocessStartTime: number | null = null;
      if (tracker) {
        preprocessStartTime = Date.now();
        tracker.startEvent('send_preprocess', 'network', 0, `发送预处理请求: ${filename}`);
      }

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

      const preprocessReceiveTime = Date.now();
      
      // 解析响应头中的性能数据
      if (tracker && preprocessStartTime) {
        const sessionId = tracker.getSessionId();
        await recordPerformanceFromResponse(preprocessRes.clone(), sessionId).catch(() => {
          // 忽略解析错误
        });
        
        tracker.recordEvent(
          'network',
          0,
          '预处理请求网络时间',
          preprocessStartTime,
          preprocessReceiveTime,
        );
        tracker.startEvent('process_preprocess', 'network', 0, '处理预处理响应');
      }

      if (!preprocessRes.ok) {
        const errorData = await preprocessRes.json().catch(() => ({ error: `HTTP ${preprocessRes.status}` }));
        throw new Error(errorData.error || `预处理失败: HTTP ${preprocessRes.status}`);
      }

      preprocessResponse = await preprocessRes.json();
      
      if (!preprocessResponse) {
        throw new Error('预处理响应为空');
      }

      if (tracker) {
        const processEndTime = Date.now();
        tracker.endEvent('process_preprocess');
        tracker.recordEvent(
          'network',
          0,
          `预处理完成 (taskId: ${preprocessResponse.task_id}, ${preprocessResponse.chunks.length} chunks)`,
          preprocessReceiveTime,
          processEndTime,
        );
      }

      taskId = preprocessResponse.task_id;
      chunks = preprocessResponse.chunks;
      shape = preprocessResponse.shape;
      dataLength = preprocessResponse.data_length;

      // 保存 shape 信息到缓存
      if (tracker) {
        tracker.startEvent('save_shape_cache', 'cache', 0, '保存shape到缓存');
      }
      saveShapeToCache(filename, chunkSize, shape, chunks, dataLength);
      if (tracker) {
        tracker.endEvent('save_shape_cache');
      }

      // 从后端加载数据：从预处理请求开始到最后一个 chunk 完成的时间
      chunkResults = await this.loadDataFromBackend(filename, chunkSize, preprocessResponse, tracker);
      fetchMs = performance.now() - tStart;
    }

    // 按 chunkIndex 排序
    if (tracker) {
      tracker.startEvent('sort_chunks', 'compute', 0, '排序chunk数据');
    }
    chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (tracker) {
      tracker.endEvent('sort_chunks');
    }

    // 在空闲时间保存非缓存的 chunk 到 IndexedDB
    const chunksToSave = chunkResults.filter((r) => !r.fromCache);
    if (chunksToSave.length > 0) {
      const saveChunksToCache = () => {
        chunksToSave.forEach((result) => {
          const bufferCopy = result.buffer.slice(0);
          indexedDBManager.saveChunk(
            filename,
            chunkSize,
            result.chunkIndex,
            bufferCopy,
            result.min,
            result.max
          ).catch((err) => {
            console.error(`[IndexedDB] 保存 chunk ${result.chunkIndex} 失败:`, err);
          });
        });
      };

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(saveChunksToCache, { timeout: 5000 });
      } else {
        setTimeout(saveChunksToCache, 1000);
      }
    }

    const loadEndTime = Date.now();
    if (tracker) {
      tracker.endEvent('data_load_start'); // 结束"数据加载开始"
      
      // 构建请求信息（用于性能分析）
      let requestInfo = '';
      if (allCached) {
        // 全部来自缓存
        requestInfo = `全部来自缓存，未发送网络请求`;
      } else if (preprocessResponse && chunks) {
        // 如果有预处理请求，记录请求信息
        // 注意：chunks 在 preprocessResponse 处理时已赋值（第449行）
        const sessionId = tracker.getSessionId();
        const chunksCount = chunks.length;
        requestInfo = `请求: POST /api/voxel-grid/preprocess, 参数: { file: "${filename}", chunk_size: ${chunkSize}, session_id: "${sessionId}" }`;
        if (taskId && chunksCount > 0) {
          requestInfo += `; 后续请求: GET /api/voxel-grid/chunk?task_id=${taskId}&chunk_index={0..${chunksCount - 1}}&session_id=${sessionId}`;
        }
      } else {
        requestInfo = `请求信息不可用`;
      }
      
      tracker.recordEvent(
        'network',
        0,
        `数据加载完成 - ${requestInfo}`,
        tStart,
        loadEndTime,
      );
    }

    return {
      chunks: chunkResults,
      shape: shape!,
      dataLength: dataLength!,
      taskId,
      fetchMs,
      allFromCache: allCached,
    };
  }
}

// 导出单例
export const dataSource = new DataSource();

