import { useEffect, useRef, useState, useCallback } from "react";
import { Select, Slider, Row, Col, Card, Space, InputNumber } from "antd";
import VoxelGridWorker from "./voxelGrid.worker.ts?worker";
import ChunkLoaderWorker from "./chunkLoader.worker.ts?worker";
import { ThreeRenderer } from "./render";

// Worker 消息类型
interface WorkerLoadMessage {
  type: "load";
  taskId: string;
  shape: [number, number, number];
  chunks: Array<{ index: number; start: number; end: number }>;
  dataBuffer: ArrayBuffer;
  level?: number;
  min?: number;
  max?: number;
}

interface WorkerResultMessage {
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

interface WorkerErrorMessage {
  type: "error";
  error: string;
}

type WorkerMessage = WorkerLoadMessage | WorkerResultMessage | WorkerErrorMessage;

// 预处理响应类型
interface PreprocessResponse {
  task_id: string;
  file: string;
  file_size: number;
  shape: [number, number, number];
  data_length: number;
  chunk_size: number;
  chunks: Array<{ index: number; start: number; end: number }>;
}

type WorkerTimings = {
  cacheSource?: string;
  fetchMs?: number;
  decompressMs?: number;
  parseBinaryMs?: number;
  rangeMs?: number;
  backendParseMs?: number;
  backendCompressMs?: number;
  backendTotalMs?: number;
  surfaceMs?: number;
  packMs?: number;
  totalWorkerMs?: number;
};

// 颜色映射
const colorMap = [
  '#313695',
  '#4575b4',
  '#74add1',
  '#abd9e9',
  '#e0f3f8',
  '#ffffbf',
  '#fee090',
  '#fdae61',
  '#f46d43',
  '#d73027',
  '#a50026'
].reverse();

// 根据值在 min-max 范围内获取颜色
const getColorFromValue = (value: number, min: number, max: number): string => {
  if (min === max) return colorMap[0];
  const normalized = (value - min) / (max - min); // 0 到 1
  const index = Math.floor(normalized * (colorMap.length - 1));
  return colorMap[Math.max(0, Math.min(colorMap.length - 1, index))];
};

const SurfaceNetsDemo1 = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ThreeRenderer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // UI 状态
  const [filename, setFilename] = useState("CHGDIFF.vasp");
  const [chunkSize, setChunkSize] = useState(1000000); // 默认 1M 元素
  const [computeEnv, setComputeEnv] = useState("js");
  const [threadCount, setThreadCount] = useState(4); // 默认 4 个 worker
  const [interpolationDensity, setInterpolationDensity] = useState(1);
  const [level, setLevel] = useState<number | null>(null); // 等值面值
  const [dataRange, setDataRange] = useState<{ min: number; max: number } | null>(null); // 数据范围
  const [taskId, setTaskId] = useState<string | null>(null); // 当前 task ID
  const [lastTimings, setLastTimings] = useState<null | {
    cacheSource: string;
    fetchMs: number;
    decompressMs: number;
    parseBinaryMs: number;
    rangeMs: number;
    backendParseMs: number;
    backendCompressMs: number;
    backendTotalMs: number;
    surfaceMs: number;
    packMs: number;
    totalWorkerMs: number;
    renderMs: number;
  }>(null);
  // 滑动条防抖：显示值与实际触发值分离
  const [displayLevel, setDisplayLevel] = useState<number | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

  // 初始化 Three.js 渲染器
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const renderer = new ThreeRenderer(container);
    rendererRef.current = renderer;

    // 清理函数
    return () => {
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current = null;
      }
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  // 加载体素网格数据（分块加载）
  const loadVoxelGrid = useCallback(async (filename: string, levelValue?: number, currentTaskId?: string | null) => {
    if (!rendererRef.current) {
      setError("渲染器未初始化");
      return;
    }

    setLoading(true);
    setError(null);

    const tStart = performance.now();
    let preprocessResponse: PreprocessResponse;

    try {
      // 1. 发送预处理请求
      const preprocessRes = await fetch("/api/voxel-grid/preprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filename, chunk_size: chunkSize }),
      });

      if (!preprocessRes.ok) {
        const errorData = await preprocessRes.json().catch(() => ({ error: `HTTP ${preprocessRes.status}` }));
        throw new Error(errorData.error || `预处理失败: HTTP ${preprocessRes.status}`);
      }

      preprocessResponse = await preprocessRes.json();
      const newTaskId = preprocessResponse.task_id;
      setTaskId(newTaskId);

      // 2. 创建多个 chunkLoader worker 并行加载 chunk
      // 每个 worker 会计算各自 chunk 的 min/max
      const chunkLoaders: Worker[] = [];
      const chunkPromises: Promise<{ 
        chunkIndex: number; 
        buffer: ArrayBuffer; 
        min: number;
        max: number;
        timings: { fetchMs: number } 
      }>[] = [];

      const activeWorkerCount = Math.min(threadCount, preprocessResponse.chunks.length);

      for (let i = 0; i < preprocessResponse.chunks.length; i++) {
        const chunk = preprocessResponse.chunks[i];
        const workerIndex = i % activeWorkerCount;

        // 复用 worker 或创建新的
        if (chunkLoaders.length <= workerIndex) {
          const worker = new ChunkLoaderWorker();
          chunkLoaders.push(worker);
        }

        const worker = chunkLoaders[workerIndex];
        const promise = new Promise<{ 
          chunkIndex: number; 
          buffer: ArrayBuffer; 
          min: number;
          max: number;
          timings: { fetchMs: number } 
        }>((resolve, reject) => {
          const handler = (e: MessageEvent) => {
            if (e.data.type === "chunk" && e.data.chunkIndex === chunk.index) {
              worker.removeEventListener("message", handler);
              resolve({
                chunkIndex: chunk.index,
                buffer: e.data.buffer,
                min: e.data.min,
                max: e.data.max,
                timings: e.data.timings,
              });
            } else if (e.data.type === "error" && e.data.chunkIndex === chunk.index) {
              worker.removeEventListener("message", handler);
              reject(new Error(e.data.error));
            }
          };
          worker.addEventListener("message", handler);
          worker.postMessage({
            type: "fetch-chunk",
            taskId: newTaskId,
            chunkIndex: chunk.index,
            start: chunk.start,
            length: chunk.end - chunk.start,
          });
        });

        chunkPromises.push(promise);
      }

      // 3. 等待所有 chunk 加载完成并合并
      const chunkResults = await Promise.all(chunkPromises);
      chunkLoaders.forEach((w) => w.terminate());

      // 按 chunkIndex 排序
      chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);

      // 合并所有 chunk 数据，并计算全局 min/max
      const totalLength = chunkResults.reduce((sum, r) => sum + r.buffer.byteLength / 8, 0);
      const mergedData = new Float64Array(totalLength);
      let offset = 0;
      const totalFetchMs = chunkResults.reduce((sum, r) => sum + r.timings.fetchMs, 0);

      // 计算全局 min/max（从所有 chunk 的 min/max 中取）
      let globalMin = chunkResults[0]?.min ?? 0;
      let globalMax = chunkResults[0]?.max ?? 0;
      for (const result of chunkResults) {
        const chunkArray = new Float64Array(result.buffer);
        mergedData.set(chunkArray, offset);
        offset += chunkArray.length;
        
        // 更新全局 min/max
        if (result.min < globalMin) globalMin = result.min;
        if (result.max > globalMax) globalMax = result.max;
      }

      // 更新数据范围（只在第一次加载时设置）
      setDataRange((prevRange) => {
        if (prevRange === null) {
          const def = (globalMin + globalMax) / 2;
          setLevel(def);
          setDisplayLevel(def);
          return { min: globalMin, max: globalMax };
        }
        return prevRange;
      });

      // 保存用于回调的变量
      const finalTotalFetchMs = totalFetchMs;
      const finalMin = globalMin;
      const finalMax = globalMax;


      // 4. 创建或重用 VoxelGrid Worker 进行 surfaceNets 处理
      if (!workerRef.current) {
        workerRef.current = new VoxelGridWorker();

        workerRef.current.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;

          if (message.type === "result") {
            try {
              const { positionsData, positionsLength, cellsData, cellsLength, shape, min, max, level: resultLevel } = message;

              // 计算颜色
              const color = getColorFromValue(resultLevel, min, max);

              // 更新渲染器的网格
              if (rendererRef.current) {
                const renderMs = rendererRef.current.updateMesh(
                  positionsData,
                  positionsLength,
                  cellsData,
                  cellsLength,
                  shape,
                  color
                );

                // 将耗时信息保存以展示
                const rec = (message as unknown as { timings?: WorkerTimings }).timings || {};
                setLastTimings({
                  cacheSource: rec?.cacheSource || 'unknown',
                  fetchMs: finalTotalFetchMs,
                  decompressMs: rec?.decompressMs ?? 0,
                  parseBinaryMs: rec?.parseBinaryMs ?? 0,
                  rangeMs: rec?.rangeMs ?? 0,
                  backendParseMs: 0, // 不再统计，因为预处理是异步的
                  backendCompressMs: 0,
                  backendTotalMs: 0,
                  surfaceMs: rec?.surfaceMs ?? 0,
                  packMs: rec?.packMs ?? 0,
                  totalWorkerMs: rec?.totalWorkerMs ?? 0,
                  renderMs,
                });
              }

              setLoading(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : "渲染网格时出错");
              setLoading(false);
            }
          } else if (message.type === "error") {
            setError(message.error || "加载数据时出错");
            setLoading(false);
          }
        };

        workerRef.current.onerror = (error) => {
          setError(`Worker 错误: ${error.message}`);
          setLoading(false);
        };
      }

      // 5. 发送合并后的数据给 VoxelGrid Worker
      const message: WorkerLoadMessage = {
        type: "load",
        taskId: newTaskId,
        shape: preprocessResponse.shape,
        chunks: preprocessResponse.chunks,
        dataBuffer: mergedData.buffer,
        level: levelValue,
        min: finalMin,
        max: finalMax,
      };
      workerRef.current.postMessage(message, [mergedData.buffer]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载数据时出错");
      setLoading(false);
    }
  }, [chunkSize, threadCount, dataRange]);

  // 组件挂载时自动加载数据
  useEffect(() => {
    if (rendererRef.current && !dataRange) {
      // 只在首次加载时执行，不传 level（使用默认值）
      loadVoxelGrid(filename);
    }
  }, [filename, chunkSize, threadCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当 level 改变时重新计算（需要等待数据范围加载完成）
  useEffect(() => {
    if (level !== null && rendererRef.current && dataRange && taskId) {
      loadVoxelGrid(filename, level, taskId);
    }
  }, [level]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 24, height: "100%", display: "flex", flexDirection: "column" }}>
      <Card 
        title="SurfaceNets 3D 可视化" 
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            {loading && <span style={{ color: "#7aa2f7" }}>加载中...</span>}
            {error && <span style={{ color: "#f7768e" }}>错误: {error}</span>}
            {!loading && !error && dataRange && (
              <span style={{ color: "#9ece6a" }}>数据已加载</span>
            )}
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Col span={6}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>选择文件</div>
              <Select
                value={filename}
                onChange={setFilename}
                style={{ width: "100%" }}
                options={[
                  { label: "CHGDIFF.vasp", value: "CHGDIFF.vasp" }
                ]}
              />
            </div>
          </Col>
          
          <Col span={6}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>分块大小 (元素数)</div>
              <InputNumber
                value={chunkSize}
                onChange={(val) => val && setChunkSize(val)}
                style={{ width: "100%" }}
                min={1000}
                step={100000}
                formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                parser={(value) => value!.replace(/\$\s?|(,*)/g, '')}
              />
            </div>
          </Col>
          
          <Col span={6}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>Worker 线程数</div>
              <Select
                value={threadCount}
                onChange={setThreadCount}
                style={{ width: "100%" }}
                options={[
                  { label: "1", value: 1 },
                  { label: "2", value: 2 },
                  { label: "4", value: 4 },
                  { label: "8", value: 8 }
                ]}
              />
            </div>
          </Col>
          
          <Col span={6}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>选择计算环境</div>
              <Select
                value={computeEnv}
                onChange={setComputeEnv}
                style={{ width: "100%" }}
                options={[
                  { label: "js", value: "js" }
                ]}
              />
            </div>
          </Col>
          
          <Col span={24}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>
                选择等值面
                {displayLevel !== null && dataRange && (
                  <span style={{ marginLeft: 8, color: "#9ece6a" }}>
                    {displayLevel.toFixed(4)} (范围: {dataRange.min.toFixed(4)} - {dataRange.max.toFixed(4)})
                  </span>
                )}
              </div>
              {dataRange && displayLevel !== null ? (
                <Slider
                  min={dataRange.min}
                  max={dataRange.max}
                  value={displayLevel}
                  onChange={(val: number) => {
                    setDisplayLevel(val);
                    if (debounceTimerRef.current) {
                      window.clearTimeout(debounceTimerRef.current);
                    }
                    debounceTimerRef.current = window.setTimeout(() => {
                      setLevel(val);
                    }, 200);
                  }}
                  step={(dataRange.max - dataRange.min) / 1000}
                  tooltip={{ formatter: (value) => value?.toFixed(4) }}
                />
              ) : (
                <Slider disabled />
              )}
            </div>
          </Col>
        </Row>
      </Card>
      
      {lastTimings && (
        <Card title="性能统计" size="small" style={{ marginBottom: 16 }}>
          <Row gutter={[16, 8]}>
            <Col span={6}>缓存来源: {lastTimings.cacheSource}</Col>
            <Col span={6}>网络获取: {lastTimings.fetchMs.toFixed(2)} ms</Col>
            <Col span={6}>解压: {lastTimings.decompressMs.toFixed(2)} ms</Col>
            <Col span={6}>解析头/数据: {lastTimings.parseBinaryMs.toFixed(2)} ms</Col>
            <Col span={6}>计算范围: {lastTimings.rangeMs.toFixed(2)} ms</Col>
            <Col span={6}>后端解析: {lastTimings.backendParseMs.toFixed(2)} ms</Col>
            <Col span={6}>后端压缩: {lastTimings.backendCompressMs.toFixed(2)} ms</Col>
            <Col span={6}>后端总耗时: {lastTimings.backendTotalMs.toFixed(2)} ms</Col>
            <Col span={6}>等值面计算: {lastTimings.surfaceMs.toFixed(2)} ms</Col>
            <Col span={6}>打包顶点/索引: {lastTimings.packMs.toFixed(2)} ms</Col>
            <Col span={6}>Worker总耗时: {lastTimings.totalWorkerMs.toFixed(2)} ms</Col>
            <Col span={6}>渲染构建: {lastTimings.renderMs.toFixed(2)} ms</Col>
          </Row>
        </Card>
      )}

      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: "100%",
          minHeight: 600,
          backgroundColor: "#1a1b26",
        }}
      />
    </div>
  );
};

export default SurfaceNetsDemo1;