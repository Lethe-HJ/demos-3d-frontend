/// <reference lib="webworker" />

// 声明全局 __DEV__ 类型（由 vite.config.ts 中的 define 配置提供）
declare const __DEV__: boolean;

// @ts-expect-error - surfacenets.js 没有类型定义
import { surfaceNets } from "./surfacenets.js";

import { PerformanceTracker } from "../../common/performance/tracker";
const threadId = crypto.randomUUID().slice(0, 8);
const tracker = new PerformanceTracker({ group: "worker", threadId });

type WorkerInputMessage = {
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
    }
  | { type: "error"; error: string };

const ctx: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

self.addEventListener(
  "message",
  async (event: MessageEvent<WorkerInputMessage>) => {
    if (event.data.type !== "load") return;

    try {
      const { shape, dataBuffer, level, min, max, workerIndex, sessionId } =
        event.data;
      tracker.setSessionId(sessionId);
      // 使用 worker线程标识作为 channelIndex
      const workerThreadId =
        workerIndex !== undefined
          ? `chunk合并线程${workerIndex}`
          : "chunk合并线程0";

      const eventId = `parse_data_${workerThreadId}`;
      if (__DEV__) {
        tracker.startRecord(eventId, "VoxelGrid Worker 解析数据");
      }
      const data = new Float64Array(dataBuffer);
      const selectedLevel = level !== undefined ? level : (min! + max!) / 2;

      if (__DEV__) tracker.endRecord(eventId);

      const surfaceEventId = `surface_calculation_${workerThreadId}`;
      if (__DEV__)
        tracker.startRecord(surfaceEventId, "VoxelGrid Worker 等值面计算");
      const [xm, ym, zm] = shape;
      const potential = (x: number, y: number, z: number): number => {
        const i = Math.floor(x) - 1;
        const j = Math.floor(y) - 1;
        const k = Math.floor(z) - 1;
        const idx = (((i + xm) % xm) + xm) % xm;
        const idy = (((j + ym) % ym) + ym) % ym;
        const idz = (((k + zm) % zm) + zm) % zm;
        const index = idz * xm * ym + idy * xm + idx;
        return data[index] - selectedLevel;
      };
      const extendedShape: [number, number, number] = [
        shape[0] + 2,
        shape[1] + 2,
        shape[2] + 2,
      ];
      const result = surfaceNets(extendedShape, potential, undefined);

      if (__DEV__) tracker.endRecord(surfaceEventId);

      const flatPositions = new Float32Array(result.positions.length * 3);
      for (let i = 0; i < result.positions.length; i++) {
        flatPositions[i * 3] = result.positions[i][0];
        flatPositions[i * 3 + 1] = result.positions[i][1];
        flatPositions[i * 3 + 2] = result.positions[i][2];
      }
      const flatCells = new Uint32Array(result.cells.flat());

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
      };
      ctx.postMessage(message, [flatPositions.buffer, flatCells.buffer]);
    } catch (error) {
      ctx.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerOutputMessage);
    }
  }
);
