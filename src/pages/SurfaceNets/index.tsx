import { useEffect, useRef, useState, useCallback } from "react";
import { Select, Slider, Row, Col, Card, Space, InputNumber, Button } from "antd";
import VoxelGridWorker from "./voxelGrid.worker.ts?worker";
import { ThreeRenderer } from "./render";
import { dataSource } from "./dataSource";
import { createTracker, performanceDB, FlameGraph, recordPerformanceFromResponse } from "@/common/performance";
import type { PerformanceSession } from "@/common/performance";

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
  sessionId?: string; // 性能追踪会话 ID
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
  fetchMs?: number;
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
  const [chunkSize, setChunkSize] = useState(1e5); // 默认 10w 元素
  const [computeEnv, setComputeEnv] = useState("js");
  // Worker 线程数固定为 5 个
  const THREAD_COUNT = 5;
  const [interpolationDensity, setInterpolationDensity] = useState(1);
  const [level, setLevel] = useState<number | null>(null); // 等值面值
  const [dataRange, setDataRange] = useState<{ min: number; max: number } | null>(null); // 数据范围
  const [taskId, setTaskId] = useState<string | null>(null); // 当前 task ID
  // 性能分析相关状态
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showPerformance, setShowPerformance] = useState(false);
  const [performanceSession, setPerformanceSession] = useState<PerformanceSession | null>(null);
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

    // 创建性能追踪器
    const tracker = createTracker({
      enabled: true,
      metadata: { filename, chunkSize, taskId: null },
      });
    const sessionId = tracker.getSessionId();
    setCurrentSessionId(sessionId);
    
    // 初始化 IndexedDB
    await performanceDB.init();

    try {
      // 使用 dataSource 统一处理数据获取逻辑
      const loadResult = await dataSource.loadData(filename, chunkSize, tracker);
      
      const { chunks: chunkResults, shape, dataLength, taskId: newTaskId, fetchMs: totalFetchMs } = loadResult;
      
      if (newTaskId) {
      setTaskId(newTaskId);
        // 更新 tracker 的 metadata
        tracker.updateMetadata({ taskId: newTaskId });
      }

      // 合并所有 chunk 数据，并计算全局 min/max
      const mergeStartTime = Date.now();
      tracker.startEvent('merge_chunks', 'compute', 0, `合并chunk数据 (${chunkResults.length}个)`);
      
      const totalLength = chunkResults.reduce((sum, r) => sum + r.buffer.byteLength / 8, 0);
      const mergedData = new Float64Array(totalLength);
      let offset = 0;

      // 计算全局 min/max（从所有 chunk 的 min/max 中取）
      let globalMin = chunkResults[0]?.min ?? 0;
      let globalMax = chunkResults[0]?.max ?? 0;
      
      const minMaxStartTime = Date.now();
      tracker.startEvent('calc_minmax', 'compute', 0, '计算全局min/max');
      
      for (const result of chunkResults) {
        const chunkArray = new Float64Array(result.buffer);
        mergedData.set(chunkArray, offset);
        offset += chunkArray.length;
        
        // 更新全局 min/max
        if (result.min < globalMin) globalMin = result.min;
        if (result.max > globalMax) globalMax = result.max;
      }
      
      const minMaxEndTime = Date.now();
      tracker.endEvent('calc_minmax');
      
      const mergeEndTime = Date.now();
      tracker.endEvent('merge_chunks');

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
      const voxelWorkerStartTime = Date.now();
      if (!workerRef.current) {
        tracker.recordEvent('worker', 0, '创建VoxelGrid Worker', voxelWorkerStartTime, voxelWorkerStartTime, 0);
        workerRef.current = new VoxelGridWorker();

        workerRef.current.onmessage = async (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          const resultReceiveTime = performance.now();

          if (message.type === "result") {
            try {
              const { positionsData, positionsLength, cellsData, cellsLength, shape, min, max, level: resultLevel } = message;

              // Worker 中的性能数据已经由 Worker 自己记录了，这里不需要重复记录

              // 计算颜色
              const colorStartTime = Date.now();
              tracker.startEvent('calc_color', 'compute', 0, '计算颜色');
              const color = getColorFromValue(resultLevel, min, max);
              tracker.endEvent('calc_color');

              // 更新渲染器的网格
              if (rendererRef.current) {
                const renderStartTime = Date.now();
                tracker.startEvent('render_mesh', 'render', 0, '渲染网格');
                
                const renderMs = rendererRef.current.updateMesh(
                  positionsData,
                  positionsLength,
                  cellsData,
                  cellsLength,
                  shape,
                  color
                );

                tracker.endEvent('render_mesh');
              }
              
              // 完成会话
              await tracker.complete();

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

      // 发送合并后的数据给 VoxelGrid Worker
      const sendStartTime = Date.now();
      tracker.startEvent('send_to_worker', 'worker', 0, '发送数据到VoxelGrid Worker');
      
      const message: WorkerLoadMessage = {
        type: "load",
        taskId: newTaskId || '',
        shape: shape,
        chunks: chunkResults.map((r) => ({ index: r.chunkIndex, start: 0, end: 0 })), // chunks 信息在 worker 中不需要使用
        dataBuffer: mergedData.buffer,
        level: levelValue,
        min: finalMin,
        max: finalMax,
        sessionId: sessionId, // 传递 sessionId 给 Worker
        workerIndex: 0, // VoxelGrid Worker 只有一个，使用索引 0
      };
      workerRef.current.postMessage(message, [mergedData.buffer]);
      
      tracker.endEvent('send_to_worker');
      
      // 保存发送时间，用于后续计算Worker处理时间
      (workerRef.current as any)._lastSendTime = { value: sendStartTime };
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载数据时出错");
      setLoading(false);
    }
  }, [chunkSize, dataRange]);

  // 组件挂载时自动加载数据
  useEffect(() => {
    if (rendererRef.current && !dataRange) {
      // 只在首次加载时执行，不传 level（使用默认值）
      loadVoxelGrid(filename);
    }
  }, [filename, chunkSize]); // eslint-disable-line react-hooks/exhaustive-deps

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
      
      {/* 性能分析按钮 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space>
          <Button 
            type="primary" 
            onClick={async () => {
              if (currentSessionId) {
                await performanceDB.init();
                
                // 先从 IndexedDB 加载本地性能数据
                let session = await performanceDB.getSession(currentSessionId);
                
                // 从后端获取性能数据
                try {
                  console.log('[性能分析] 请求后端性能数据，sessionId:', currentSessionId);
                  const response = await fetch(`/api/performance?session_id=${encodeURIComponent(currentSessionId)}`);
                  console.log('[性能分析] 后端响应状态:', response.status);
                  if (response.ok) {
                    const backendData = await response.json();
                    const backendRecords = (backendData.records || []).map((r: any) => ({
                      startTime: r.start_time,
                      endTime: r.end_time,
                      channelGroup: r.channel_group,
                      channelIndex: r.channel_index,
                      msg: r.msg,
                    }));
                    
                    // 合并后端记录到本地 session
                    if (session) {
                      session.records = [...session.records, ...backendRecords];
                      // 重新计算会话时间范围
                      const allTimes = session.records.flatMap(r => [r.startTime, r.endTime]);
                      session.sessionStartTime = Math.min(...allTimes);
                      session.sessionEndTime = Math.max(...allTimes);
                    } else {
                      // 如果没有本地 session，创建一个新的
                      session = {
                        sessionId: currentSessionId,
                        sessionStartTime: backendRecords.length > 0 
                          ? Math.min(...backendRecords.map(r => r.startTime))
                          : Date.now(),
                        sessionEndTime: backendRecords.length > 0
                          ? Math.max(...backendRecords.map(r => r.endTime))
                          : Date.now(),
                        records: backendRecords,
                      };
                    }
                  } else {
                    const errorData = await response.json().catch(() => ({}));
                    console.error('[性能分析] 后端返回错误:', errorData);
                  }
                } catch (err) {
                  console.error('[性能分析] 从后端加载性能数据失败:', err);
                }
                
                if (session) {
                  setPerformanceSession(session);
                  setShowPerformance(true);
                }
              }
            }}
            disabled={!currentSessionId}
          >
            查看性能分析
          </Button>
          {showPerformance && (
            <Button onClick={() => setShowPerformance(false)}>
              关闭性能分析
            </Button>
          )}
        </Space>
        </Card>

      {/* 性能火焰图 */}
      {showPerformance && performanceSession && (
        <FlameGraph session={performanceSession} />
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