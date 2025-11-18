/// <reference lib="webworker" />

// @ts-expect-error - surfacenets.js 没有类型定义
import { surfaceNets } from "./surfacenets.js";

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
    const tStart = performance.now();
    const { taskId, shape, chunks, dataBuffer, level, min, max } = event.data;

    const data = new Float64Array(dataBuffer);
    const selectedLevel = level !== undefined ? level : (min! + max!) / 2;

    const tSurfaceStart = performance.now();
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
    const surfaceMs = performance.now() - tSurfaceStart;

    const tPackStart = performance.now();
    const flatPositions = new Float32Array(result.positions.length * 3);
    for (let i = 0; i < result.positions.length; i++) {
      flatPositions[i * 3] = result.positions[i][0];
      flatPositions[i * 3 + 1] = result.positions[i][1];
      flatPositions[i * 3 + 2] = result.positions[i][2];
    }
    const flatCells = new Uint32Array(result.cells.flat());
    const packMs = performance.now() - tPackStart;

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
        totalWorkerMs: performance.now() - tStart,
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
