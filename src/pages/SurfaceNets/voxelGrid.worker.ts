/// <reference lib="webworker" />

// @ts-expect-error - surfacenets.js 没有类型定义
import { surfaceNets } from "./surfacenets.js";

// 动态导入性能追踪器（Worker 环境）
let tracker: any = null;
let sessionId: string | null = null;

type WorkerInputMessage =
  | {
      type: "load";
      taskId: string;
      shape: [number, number, number];
      chunks: Array<{ index: number; start: number; end: number }>;
      dataBuffer: ArrayBuffer;
      level?: number;
      min?: number;
      max?: number;
      sessionId?: string; // 性能追踪会话 ID
      workerIndex?: number; // Worker 索引，用于标识线程
    };

type WorkerOutputMessage =
  | { 
      type: "result"; 
      positionsData: ArrayBuffer; 
      positionsLength: number; 
      cellsData: ArrayBuffer; 
      cellsLength: number; 
      shape: [number, number, number]; 
      min: number; 
      max: number; 
      level: number;
      timings: ResultTimings;
    }
  | { type: "error"; error: string };

interface ResultTimings {
  surfaceMs: number;
  packMs: number;
  totalWorkerMs: number;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

self.addEventListener("message", async (event: MessageEvent<WorkerInputMessage>) => {
  if (event.data.type !== "load") return;

  try {
    const { taskId, shape, chunks, dataBuffer, level, min, max, sessionId: newSessionId, workerIndex } = event.data;
    
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
        console.error('[VoxelGrid Worker] 初始化 tracker 失败:', err);
      }
    }
    
    // 使用 worker线程标识作为 channelIndex
    const workerThreadId = workerIndex !== undefined ? `chunk合并线程${workerIndex}` : 'chunk合并线程0';
    
    const tStart = Date.now();
    const data = new Float64Array(dataBuffer);
    const selectedLevel = level !== undefined ? level : (min! + max!) / 2;

    // 记录数据解析时间
    const parseEndTime = Date.now();
    if (tracker) {
      tracker.recordEvent(
        'compute',
        workerThreadId,
        'VoxelGrid Worker 解析数据',
        tStart,
        parseEndTime,
      );
    }

    const tSurfaceStart = Date.now();
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
    const extendedShape: [number, number, number] = [
      shape[0] + 2,
      shape[1] + 2,
      shape[2] + 2,
    ];
    const result = surfaceNets(extendedShape, potential, undefined);
    const surfaceEndTime = Date.now();
    const surfaceMs = surfaceEndTime - tSurfaceStart;
    
    // 记录等值面计算时间
    if (tracker) {
      tracker.recordEvent(
        'compute',
        workerThreadId,
        '等值面计算 (VoxelGrid Worker)',
        tSurfaceStart,
        surfaceEndTime,
      );
    }

    const tPackStart = Date.now();
    const flatPositions = new Float32Array(result.positions.length * 3);
    for (let i = 0; i < result.positions.length; i++) {
      flatPositions[i * 3] = result.positions[i][0];
      flatPositions[i * 3 + 1] = result.positions[i][1];
      flatPositions[i * 3 + 2] = result.positions[i][2];
    }
    const flatCells = new Uint32Array(result.cells.flat());
    const packEndTime = Date.now();
    const packMs = packEndTime - tPackStart;
    
    // 记录打包时间
    if (tracker) {
      tracker.recordEvent(
        'compute',
        workerThreadId,
        '打包顶点/索引 (VoxelGrid Worker)',
        tPackStart,
        packEndTime,
      );
      
      // 记录 Worker 总处理时间
      const totalEndTime = Date.now();
      tracker.recordEvent(
        'worker',
        workerThreadId,
        'VoxelGrid Worker 总处理时间',
        tStart,
        totalEndTime,
      );
    }

    const message: WorkerOutputMessage = {
      type: "result",
      positionsData: flatPositions.buffer,
      positionsLength: result.positions.length,
      cellsData: flatCells.buffer,
      cellsLength: result.cells.length,
      shape,
      min: min!,
      max: max!,
      level: selectedLevel,
      timings: {
        surfaceMs,
        packMs,
        totalWorkerMs: Date.now() - tStart,
      },
    };
    ctx.postMessage(message, [flatPositions.buffer, flatCells.buffer]);
  } catch (error) {
    ctx.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerOutputMessage);
  }
});
