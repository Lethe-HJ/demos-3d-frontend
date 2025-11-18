/// <reference lib="webworker" />

type ChunkRequestMessage = {
  type: "fetch-chunk";
  taskId: string;
  chunkIndex: number;
  start: number;
  length: number;
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

  const { taskId, chunkIndex, start, length } = event.data;
  const url = `/api/voxel-grid/chunk?task_id=${encodeURIComponent(taskId)}&chunk_index=${chunkIndex}`;

  try {
    const tFetchStart = performance.now();
    
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
    const fetchMs = performance.now() - tFetchStart;

    // 解析二进制数据为 Float64Array 并计算 min/max
    const data = new Float64Array(buffer);
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
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

