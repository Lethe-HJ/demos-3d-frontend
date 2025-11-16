import { useEffect, useRef, useState, useCallback } from "react";
import { Select, Slider, Row, Col, Card, Space } from "antd";
import VoxelGridWorker from "./voxelGrid.worker.ts?worker";
import { ThreeRenderer } from "./render";

// Worker 消息类型
interface WorkerLoadMessage {
  type: "load";
  filename: string;
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
  const [computeEnv, setComputeEnv] = useState("js");
  const [threadCount, setThreadCount] = useState(1);
  const [interpolationDensity, setInterpolationDensity] = useState(1);
  const [level, setLevel] = useState<number | null>(null); // 等值面值
  const [dataRange, setDataRange] = useState<{ min: number; max: number } | null>(null); // 数据范围
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

  // 加载体素网格数据
  const loadVoxelGrid = useCallback((filename: string, levelValue?: number) => {
    if (!rendererRef.current) {
      setError("渲染器未初始化");
      return;
    }

    setLoading(true);
    setError(null);

    // 创建或重用 Worker
    if (!workerRef.current) {
      workerRef.current = new VoxelGridWorker();

      // 处理 Worker 消息
      workerRef.current.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;

        if (message.type === "result") {
          try {
            const { positionsData, positionsLength, cellsData, cellsLength, shape, min, max, level: resultLevel } = message;
            
            // 更新数据范围（只在第一次加载时设置）
            setDataRange((prevRange) => {
              if (prevRange === null) {
                // 首次加载，设置默认 level
                const def = (min + max) / 2;
                setLevel(def);
                setDisplayLevel(def);
                return { min, max };
              }
              return prevRange;
            });
            
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
                fetchMs: rec?.fetchMs ?? 0,
                decompressMs: rec?.decompressMs ?? 0,
                parseBinaryMs: rec?.parseBinaryMs ?? 0,
                rangeMs: rec?.rangeMs ?? 0,
                backendParseMs: rec?.backendParseMs ?? 0,
                backendCompressMs: rec?.backendCompressMs ?? 0,
                backendTotalMs: rec?.backendTotalMs ?? 0,
                surfaceMs: rec?.surfaceMs ?? 0,
                packMs: rec?.packMs ?? 0,
                totalWorkerMs: rec?.totalWorkerMs ?? 0,
                renderMs,
              });
            }

            setLoading(false);
          } catch (err) {
            setError(
              err instanceof Error ? err.message : "渲染网格时出错"
            );
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

    // 发送加载请求
    const message: WorkerLoadMessage = {
      type: "load",
      filename,
      level: levelValue,
      min: dataRange?.min,
      max: dataRange?.max,
    };
    workerRef.current.postMessage(message);
  }, [dataRange]);

  // 组件挂载时自动加载数据
  useEffect(() => {
    if (rendererRef.current && !dataRange) {
      // 只在首次加载时执行，不传 level（使用默认值）
      loadVoxelGrid(filename);
    }
  }, [filename]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当 level 改变时重新计算（需要等待数据范围加载完成）
  useEffect(() => {
    if (level !== null && rendererRef.current && dataRange) {
      loadVoxelGrid(filename, level);
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
          
          <Col span={6}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>选择线程数量</div>
              <Select
                value={threadCount}
                onChange={setThreadCount}
                style={{ width: "100%" }}
                options={[
                  { label: "1", value: 1 }
                ]}
              />
            </div>
          </Col>
          
          <Col span={6}>
            <div>
              <div style={{ marginBottom: 8, color: "#7aa2f7" }}>选择线性插值密度</div>
              <Select
                value={interpolationDensity}
                onChange={setInterpolationDensity}
                style={{ width: "100%" }}
                options={[
                  { label: "1", value: 1 }
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