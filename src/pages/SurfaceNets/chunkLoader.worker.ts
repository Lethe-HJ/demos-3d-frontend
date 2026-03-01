/// <reference lib="webworker" />

// 声明全局 __DEV__ 类型（由 vite.config.ts 中的 define 配置提供）
declare const __DEV__: boolean;

import { PerformanceTracker } from "@/common/performance/tracker";
const threadId = crypto.randomUUID().slice(0, 8);

const tracker = new PerformanceTracker({ group: "worker", threadId });
type ChunkRequestMessage =
  | {
      type: "fetch-chunk";
      taskId: string;
      chunkIndex: number;
      start: number;
      length: number;
      sessionId: string; // 性能追踪会话 ID
    }
  | {
      type: "pre-close";
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
    }
  | {
      type: "error";
      chunkIndex: number;
      error: string;
    }
  | {
      type: "close-ok";
    };

const ctx: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

self.addEventListener(
  "message",
  async (event: MessageEvent<ChunkRequestMessage>) => {
    // 处理 pre-close 消息
    if (event.data.type === "pre-close") {
      try {
        // 等待性能追踪完成
        await tracker.complete();
        ctx.postMessage({
          type: "close-ok",
        } satisfies ChunkResponseMessage);
      } catch (err) {
        console.error("[Worker] tracker.complete() 失败:", err);
        // 即使失败也发送 close-ok，避免主线程一直等待
        ctx.postMessage({
          type: "close-ok",
        } satisfies ChunkResponseMessage);
      }
      return;
    }

    if (event.data.type !== "fetch-chunk") {
      return;
    }

    const { taskId, chunkIndex, start, length, sessionId } = event.data;
    tracker.setSessionId(sessionId);
    const urlTaskId = encodeURIComponent(taskId);
    const url = `/api/voxel-grid/chunk?task_id=${urlTaskId}&chunk_index=${chunkIndex}`;

    try {
      // 记录网络请求开始
      const eventId = `fetch_chunk_${chunkIndex}`;
      if (__DEV__) {
        tracker.startRecord(eventId, `Worker 请求 Chunk ${chunkIndex}`);
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
            throw new Error(
              `chunk ${chunkIndex} 在 ${maxRetries} 次重试后仍未就绪`
            );
          }

          // 指数退避：100ms, 200ms, 400ms, 800ms, ...
          const delay = baseDelay * Math.pow(2, retryCount);
          await new Promise((resolve) => setTimeout(resolve, delay));
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

      // 记录网络请求完成
      if (__DEV__) {
        tracker.endRecord(eventId);
      }

      // 解析二进制数据为 Float64Array 并计算 min/max
      const parseEventId = `parse_chunk_${chunkIndex}`;
      if (__DEV__) {
        tracker.startRecord(
          parseEventId,
          `Worker 解析 Chunk ${chunkIndex} 数据`
        );
      }
      const data = new Float64Array(buffer);
      let min = data[0];
      let max = data[0];
      for (let i = 1; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }

      // 记录解析时间
      if (tracker) {
        tracker.endRecord(parseEventId);
      }

      const msg: ChunkResponseMessage = {
        type: "chunk",
        chunkIndex,
        start,
        length,
        buffer,
        min,
        max,
      };
      ctx.postMessage(msg, [buffer]);
    } catch (error) {
      ctx.postMessage({
        type: "error",
        chunkIndex,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ChunkResponseMessage);
    }
  }
);
