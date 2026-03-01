/**
 * 性能追踪器
 * 支持写入 IndexedDB（在空闲时）
 */

import { performanceDB } from "./indexedDB";
import type {
  PerformanceRecord,
  PerformanceTrackerConfig,
  ChannelGroupConfig,
} from "./types";

/**
 * 行组配置
 */
export const CHANNEL_GROUPS: Record<string, ChannelGroupConfig> = {
  worker: {
    name: "worker",
    displayName: "web worker",
    color: "#f5a623",
    order: 0,
  },
  main: { name: "main", displayName: "主线程", color: "#ff0000", order: 1 },
  rust: {
    name: "backend",
    displayName: "web backend",
    color: "#bb9af7",
    order: 2,
  },
  render: {
    name: "render",
    displayName: "GPU渲染",
    color: "#50e3c2",
    order: 3,
  },
};

/**
 * 获取 Unix 时间戳（毫秒）
 */
function getUnixTimestamp(): number {
  return Date.now();
}

/**
 * 性能追踪器类
 */
export class PerformanceTracker {
  private sessionId: string;
  private group: string;
  private threadId: string;
  private metadata?: Record<string, unknown>;
  private records: PerformanceRecord[] = [];
  private activeRecords: Map<string, number | string> = new Map(); // recordId -> startTime

  constructor(config: PerformanceTrackerConfig) {
    this.sessionId = config.sessionId || "";
    this.threadId = config.threadId;
    this.metadata = config.metadata;
    this.group = config.group;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * 开始记录
   */
  startRecord(recordId: string, msg: string): string {
    const startTime = getUnixTimestamp();
    // 存储完整的记录信息，以便结束时使用
    this.activeRecords.set(recordId, startTime);
    this.activeRecords.set(`_${recordId}_group`, this.group);
    this.activeRecords.set(`_${recordId}_index`, this.threadId);
    this.activeRecords.set(`_${recordId}_msg`, msg);
    return recordId;
  }

  /**
   * 结束记录
   */
  endRecord(recordId: string): void {
    const startTime = this.activeRecords.get(recordId);
    if (startTime === undefined) return;

    const channelGroup = this.activeRecords.get(`_${recordId}_group`) || "";
    const channelIndex = this.activeRecords.get(`_${recordId}_index`) || 0;
    const msg = this.activeRecords.get(`_${recordId}_msg`) || "";

    this.activeRecords.delete(recordId);
    this.activeRecords.delete(`_${recordId}_group`);
    this.activeRecords.delete(`_${recordId}_index`);
    this.activeRecords.delete(`_${recordId}_msg`);

    const endTime = getUnixTimestamp();

    const record: PerformanceRecord = {
      startTime: startTime as number,
      endTime,
      channelGroup: channelGroup as string,
      channelIndex: channelIndex as number,
      msg: msg as string,
    };

    this.records.push(record);
    this.saveRecord(record);
  }

  /**
   * 完成会话并保存
   */
  async complete(): Promise<void> {
    // 保存所有待保存的记录
    await performanceDB.flushPendingRecords?.(this.sessionId);
    if (!this.sessionId) {
      throw Error("sessionId is not set");
    }
    // 完成会话
    const session = {
      sessionId: this.sessionId,
      threadId: this.threadId,
      sessionStartTime:
        this.records.length > 0
          ? Math.min(...this.records.map((r) => r.startTime))
          : getUnixTimestamp(),
      sessionEndTime:
        this.records.length > 0
          ? Math.max(...this.records.map((r) => r.endTime))
          : getUnixTimestamp(),
      records: [...this.records],
      metadata: this.metadata,
    };

    await performanceDB.completeSession(session);
  }

  /**
   * 更新元数据
   */
  updateMetadata(metadata: Partial<Record<string, unknown>>): void {
    this.metadata = { ...this.metadata, ...metadata };
  }

  /**
   * 保存记录（异步，在空闲时）
   */
  private saveRecord(record: PerformanceRecord): void {
    if (!this.sessionId) {
      throw Error("sessionId is not set");
    }
    performanceDB.addRecord(this.sessionId, record).catch((err) => {
      console.error("[PerformanceTracker] 保存记录失败:", err);
    });
  }
}
