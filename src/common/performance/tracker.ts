/**
 * 性能追踪器
 * 支持写入 IndexedDB（在空闲时）
 */

import { performanceDB } from './indexedDB';
import type { PerformanceRecord, PerformanceTrackerConfig, ChannelGroupConfig } from './types';

/**
 * 行组配置
 */
export const CHANNEL_GROUPS: Record<string, ChannelGroupConfig> = {
  network: { name: 'network', displayName: '网络', color: '#4a90e2', order: 0 },
  cache: { name: 'cache', displayName: '缓存', color: '#7ed321', order: 1 },
  worker: { name: 'worker', displayName: 'Worker', color: '#f5a623', order: 2 },
  compute: { name: 'compute', displayName: '计算', color: '#bd10e0', order: 3 },
  render: { name: 'render', displayName: '渲染', color: '#50e3c2', order: 4 },
};

/**
 * 生成会话 ID
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

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
  private enabled: boolean;
  private metadata?: Record<string, unknown>;
  private records: PerformanceRecord[] = [];
  private activeEvents: Map<string, number> = new Map(); // eventId -> startTime

  constructor(config: PerformanceTrackerConfig = { enabled: true }) {
    this.enabled = config.enabled;
    this.sessionId = config.sessionId || generateSessionId();
    this.metadata = config.metadata;
  }

  /**
   * 开始记录一个事件
   */
  startEvent(
    eventId: string,
    channelGroup: string,
    channelIndex: number | string,
    msg: string
  ): void {
    if (!this.enabled) return;

    const startTime = getUnixTimestamp();
    // 存储完整的记录信息，以便结束时使用
    this.activeEvents.set(eventId, startTime);
    (this.activeEvents as any).set(`_${eventId}_group`, channelGroup);
    (this.activeEvents as any).set(`_${eventId}_index`, channelIndex);
    (this.activeEvents as any).set(`_${eventId}_msg`, msg);
  }

  /**
   * 结束记录一个事件
   */
  endEvent(eventId: string): void {
    if (!this.enabled) return;

    const startTime = this.activeEvents.get(eventId);
    if (startTime === undefined) return;

    const channelGroup = (this.activeEvents as any).get(`_${eventId}_group`) || '';
    const channelIndex = (this.activeEvents as any).get(`_${eventId}_index`) || 0;
    const msg = (this.activeEvents as any).get(`_${eventId}_msg`) || '';

    this.activeEvents.delete(eventId);
    (this.activeEvents as any).delete(`_${eventId}_group`);
    (this.activeEvents as any).delete(`_${eventId}_index`);
    (this.activeEvents as any).delete(`_${eventId}_msg`);

    const endTime = getUnixTimestamp();

    const record: PerformanceRecord = {
      startTime,
      endTime,
      channelGroup,
      channelIndex,
      msg,
    };

    this.records.push(record);
    this.saveRecord(record);
  }

  /**
   * 记录一个完整的事件
   */
  recordEvent(
    channelGroup: string,
    channelIndex: number | string,
    msg: string,
    startTime?: number,
    endTime?: number,
    duration?: number
  ): void {
    if (!this.enabled) return;

    const now = getUnixTimestamp();
    const finalStartTime = startTime || now;
    const finalEndTime = endTime || (duration ? finalStartTime + duration : now);

    const record: PerformanceRecord = {
      startTime: finalStartTime,
      endTime: finalEndTime,
      channelGroup,
      channelIndex,
      msg,
    };

    this.records.push(record);
    this.saveRecord(record);
  }

  /**
   * 完成会话并保存
   */
  async complete(): Promise<void> {
    if (!this.enabled) return;

    // 结束所有未结束的事件
    for (const [eventId] of this.activeEvents) {
      // 这里需要知道 channelGroup 和 msg，暂时忽略
      this.activeEvents.delete(eventId);
    }

    // 保存所有待保存的记录
    await performanceDB.flushPendingRecords?.(this.sessionId) || Promise.resolve();

    // 完成会话
    const session = {
      sessionId: this.sessionId,
      sessionStartTime: this.records.length > 0
        ? Math.min(...this.records.map((r) => r.startTime))
        : getUnixTimestamp(),
      sessionEndTime: this.records.length > 0
        ? Math.max(...this.records.map((r) => r.endTime))
        : getUnixTimestamp(),
      records: [...this.records],
      metadata: this.metadata,
    };

    await performanceDB.completeSession(session);
  }

  /**
   * 获取会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
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
    performanceDB.addRecord(this.sessionId, record).catch((err) => {
      console.error('[PerformanceTracker] 保存记录失败:', err);
    });
  }
}

/**
 * 创建性能追踪器
 */
export function createTracker(config?: PerformanceTrackerConfig): PerformanceTracker {
  return new PerformanceTracker(config);
}

