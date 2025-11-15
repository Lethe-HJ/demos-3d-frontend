import { useEffect, useRef, useState } from "react";
import VoxelGridWorker from "./voxelGrid.worker.ts?worker";
import { ThreeRenderer } from "./render";

// Worker 消息类型
interface WorkerLoadMessage {
  type: "load";
  filename: string;
}

interface WorkerResultMessage {
  type: "result";
  positionsData: ArrayBuffer;
  positionsLength: number;
  cellsData: ArrayBuffer;
  cellsLength: number;
  shape: [number, number, number];
}

interface WorkerErrorMessage {
  type: "error";
  error: string;
}

type WorkerMessage = WorkerLoadMessage | WorkerResultMessage | WorkerErrorMessage;

const SurfaceNetsDemo1 = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ThreeRenderer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const loadVoxelGrid = (filename: string) => {
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
            const { positionsData, positionsLength, cellsData, cellsLength, shape } = message;
            
            // 更新渲染器的网格
            if (rendererRef.current) {
              rendererRef.current.updateMesh(
                positionsData,
                positionsLength,
                cellsData,
                cellsLength,
                shape
              );
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
    };
    workerRef.current.postMessage(message);
  };

  // 组件挂载时自动加载数据
  useEffect(() => {
    if (rendererRef.current) {
      loadVoxelGrid("CHGDIFF.vasp");
    }
  }, []);

  return (
    <div style={{ padding: 24, height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#7aa2f7" }}>SurfaceNets 3D 可视化</h2>
        {loading && <p style={{ color: "#7aa2f7" }}>加载中...</p>}
        {error && <p style={{ color: "#f7768e" }}>错误: {error}</p>}
        {!loading && !error && (
          <p style={{ color: "#9ece6a" }}>数据已加载</p>
        )}
        <button
          onClick={() => loadVoxelGrid("CHGDIFF.vasp")}
          disabled={loading}
          style={{
            padding: "8px 16px",
            backgroundColor: "#7aa2f7",
            color: "#1a1b26",
            border: "none",
            borderRadius: 4,
            cursor: loading ? "not-allowed" : "pointer",
            marginTop: 8,
          }}
        >
          重新加载
        </button>
      </div>
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