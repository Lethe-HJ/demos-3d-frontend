/// <reference lib="webworker" />

import type { PerformanceTracker } from "@/common/performance";

// 动态导入性能追踪器（Worker 环境）
let tracker: PerformanceTracker | null = null;
let sessionId: string | null = null;

type ChunkRequestMessage = {
  type: "fetch-chunk";
  taskId: string;
  chunkIndex: number;
  start: number;
  length: number;
  sessionId?: string; // 性能追踪会话 ID
  workerIndex?: number; // Worker 索引，用于标识线程
};

type ChunkResponseMessage =
  | {
      type: "chunk";
      chunkIndex: number;
      start: number;
      length: number;
      buffer: ArrayBuffer;
      min: number;
      max: number;
      timings: {
        fetchMs: number;
      };
    }
  | {
    type: "error";
    chunkIndex: number;
    error: string;
  };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

self.addEventListener("message", async (event: MessageEvent<ChunkRequestMessage>) => {
  if (event.data.type !== "fetch-chunk") {
    return;
  }

  const { taskId, chunkIndex, start, length, sessionId: newSessionId, workerIndex } = event.data;
  
  // 初始化 tracker（如果 sessionId 变化或 tracker 未初始化）
  if (newSessionId && newSessionId !== sessionId) {
    sessionId = newSessionId;
    try {
      // 动态导入 tracker（Worker 环境）
      const { createTracker } = await import('../../common/performance/tracker');
      tracker = createTracker({
        enabled: true,
        sessionId: newSessionId,
      });
    } catch (err) {
      console.error('[ChunkLoader Worker] 初始化 tracker 失败:', err);
    }
  }
  
  // 使用 worker线程标识作为 channelIndex
  const workerThreadId = workerIndex !== undefined ? `chunk请求线程${workerIndex}` : `chunk请求线程${chunkIndex}`;
  const url = `/api/voxel-grid/chunk?task_id=${encodeURIComponent(taskId)}&chunk_index=${chunkIndex}${sessionId ? `&session_id=${encodeURIComponent(sessionId!)}` : ''}`;

  try {
    const tFetchStart = Date.now();
    
    // 记录网络请求开始
    if (tracker) {
      tracker.startEvent(`fetch_chunk_${chunkIndex}`, 'network', workerThreadId, `Worker 请求 Chunk ${chunkIndex}`);
    }
    
    // 重试逻辑：如果收到 202 Accepted，说明 chunk 还在解析中，需要重试
    let response: Response;
    let retryCount = 0;
    const maxRetries = 10; // 最多重试 10 次
    const baseDelay = 100; // 基础延迟 100ms，使用指数退避
    
    while (true) {
      response = await fetch(url);
      
      // 如果 chunk 就绪（200 OK），跳出循环
      if (response.status === 200) {
        break;
      }
      
      // 如果 chunk 未就绪（202 Accepted），进行重试
      if (response.status === 202) {
        if (retryCount >= maxRetries) {
          throw new Error(`chunk ${chunkIndex} 在 ${maxRetries} 次重试后仍未就绪`);
        }
        
        // 指数退避：100ms, 200ms, 400ms, 800ms, ...
        const delay = baseDelay * Math.pow(2, retryCount);
        await new Promise(resolve => setTimeout(resolve, delay));
        retryCount++;
        continue;
      }
      
      // 其他错误状态码，直接抛出错误
      const message = await response
        .json()
        .catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(message.error ?? `HTTP ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    const fetchEndTime = Date.now();
    const fetchMs = fetchEndTime - tFetchStart;
    
    // 记录网络请求完成
    if (tracker) {
      tracker.endEvent(`fetch_chunk_${chunkIndex}`);
    }

    // 解析二进制数据为 Float64Array 并计算 min/max
    const parseStartTime = Date.now();
    const data = new Float64Array(buffer);
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const parseEndTime = Date.now();
    
    // 记录解析时间
    if (tracker) {
      tracker.recordEvent(
        'compute',
        workerThreadId,
        `Worker 解析 Chunk ${chunkIndex} 数据`,
        parseStartTime,
        parseEndTime,
      );
    }

    const msg: ChunkResponseMessage = {
      type: "chunk",
      chunkIndex,
      start,
      length,
      buffer,
      min,
      max,
      timings: { fetchMs },
    };
    ctx.postMessage(msg, [buffer]);
  } catch (error) {
    ctx.postMessage({
      type: "error",
      chunkIndex,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ChunkResponseMessage);
  }
});

