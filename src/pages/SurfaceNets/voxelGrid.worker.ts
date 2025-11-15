/// <reference lib="webworker" />

// @ts-expect-error - surfacenets.js 没有类型定义
import { surfaceNets } from './surfacenets.js';

// Worker 消息类型
type WorkerInputMessage =
  | { type: 'load'; filename: string };

type WorkerOutputMessage =
  | { type: 'result'; positionsData: ArrayBuffer; positionsLength: number; cellsData: ArrayBuffer; cellsLength: number; shape: [number, number, number] }
  | { type: 'error'; error: string };

// 处理来自主线程的消息
self.addEventListener('message', async (event: MessageEvent<WorkerInputMessage>) => {
  if (event.data.type === 'load') {
    try {
      const { filename } = event.data;
      
      // 1. 调用 API 获取压缩的二进制体素网格数据
      // 使用相对路径，Vite 代理会自动转发到后端
      const response = await fetch(`/api/voxel-grid?file=${encodeURIComponent(filename)}`);
      
      if (!response.ok) {
        // 尝试读取错误 JSON
        try {
          const errorData = await response.json();
          throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        } catch {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }
      
      // 2. 读取 ArrayBuffer 并解压
      const compressedArrayBuffer = await response.arrayBuffer();
      
      // 使用 DecompressionStream API 解压 gzip
      // 正确的方式：先启动读取，再写入数据
      const decompressionStream = new DecompressionStream('gzip');
      const writer = decompressionStream.writable.getWriter();
      const reader = decompressionStream.readable.getReader();
      
      // 启动读取循环（必须在写入之前启动）
      const readPromise = (async () => {
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
            }
          }
          return chunks;
        } finally {
          reader.releaseLock();
        }
      })();
      
      // 写入数据并关闭 writer
      try {
        await writer.write(new Uint8Array(compressedArrayBuffer));
        await writer.close();
      } catch (error) {
        writer.abort();
        throw error;
      }
      
      // 等待读取完成并合并所有 chunks
      const chunks = await readPromise;
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const decompressed = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        decompressed.set(chunk, offset);
        offset += chunk.length;
      }
      
      // 3. 解析二进制数据
      // 格式：shape[0] (u64) + shape[1] (u64) + shape[2] (u64) + file_size (u64) + data_length (u64) + data (Float64Array)
      const dataView = new DataView(decompressed.buffer);
      let offsetBytes = 0;
      
      // 读取元数据（u64 = 8 bytes，使用 Little Endian）
      const shape0 = Number(dataView.getBigUint64(offsetBytes, true)); // Little Endian
      offsetBytes += 8;
      const shape1 = Number(dataView.getBigUint64(offsetBytes, true));
      offsetBytes += 8;
      const shape2 = Number(dataView.getBigUint64(offsetBytes, true));
      offsetBytes += 8;
      // 跳过 file_size（8 bytes）
      offsetBytes += 8;
      const data_length = Number(dataView.getBigUint64(offsetBytes, true));
      offsetBytes += 8;
      
      const shape: [number, number, number] = [shape0, shape1, shape2];
      
      // 读取 Float64Array 数据（每个元素 8 bytes）
      const data = new Float64Array(decompressed.buffer, offsetBytes, data_length);
      
      // 4. 计算数据范围（最小值和最大值）
      console.time('calculate data range');
      let min = data[0];
      let max = data[0];
      for (let i = 1; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      // 默认 level 为中间值
      const level = (min + max) / 2;
      console.timeEnd('calculate data range');
      console.log(`数据范围: [${min}, ${max}], 默认等值面 level: ${level}`);
      
      // 5. 创建 potential 函数
      // 根据示例，shape 需要加 2，并使用模运算处理边界
      const [xm, ym, zm] = shape;
      
      // potential 函数：使用模运算处理边界，并减去 level
      const potential = (x: number, y: number, z: number): number => {
        // 转换为整数索引（根据示例，坐标需要减1）
        const i = Math.floor(x) - 1;
        const j = Math.floor(y) - 1;
        const k = Math.floor(z) - 1;
        
        // 使用模运算处理边界（循环边界）
        const idx = ((i + xm) % xm + xm) % xm; // 确保为正数
        const idy = ((j + ym) % ym + ym) % ym;
        const idz = ((k + zm) % zm + zm) % zm;
        
        // 计算扁平数组索引：index = k * nx * ny + j * nx + i
        const index = idz * xm * ym + idy * xm + idx;
        
        // 返回 data[index] - level（等值面计算）
        return data[index] - level;
      };
      
      // 6. 调用 surfaceNets 生成网格
      // shape 需要加 2（根据示例）
      const extendedShape: [number, number, number] = [
        shape[0] + 2,
        shape[1] + 2,
        shape[2] + 2,
      ];
      
      console.time('isosurface');
      console.log(`生成等值面，level: ${level}, shape: [${extendedShape.join(', ')}]`);
      
      const result = surfaceNets(
        extendedShape,
        potential,
        undefined // 不指定 bounds，使用默认值
      );
      
      console.timeEnd('isosurface');
      console.log(`生成了 ${result.positions.length} 个顶点，${result.cells.length} 个面`);
      
      // 7. 将结果发送回主线程
      // 将数据以可传输的格式发送，使用 Transferable Objects 优化性能
      
      // 展平 positions 为 Float32Array（使用 Transferable Objects）
      const flatPositions = new Float32Array(result.positions.length * 3);
      for (let i = 0; i < result.positions.length; i++) {
        flatPositions[i * 3] = result.positions[i][0];
        flatPositions[i * 3 + 1] = result.positions[i][1];
        flatPositions[i * 3 + 2] = result.positions[i][2];
      }
      
      // 展平 cells 为 Uint32Array（使用 Transferable Objects）
      const flatCells = new Uint32Array(result.cells.flat());
      
      // 发送扁平化数据以便传输
      const message = {
        type: 'result' as const,
        positionsData: flatPositions.buffer,
        positionsLength: result.positions.length,
        cellsData: flatCells.buffer,
        cellsLength: result.cells.length,
        shape,
      };
      
      // 使用 Transferable Objects 转移所有权（零拷贝）
      self.postMessage(message, [flatPositions.buffer, flatCells.buffer]);
      
    } catch (error) {
      const errorMessage: WorkerOutputMessage = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(errorMessage);
    }
  }
});
