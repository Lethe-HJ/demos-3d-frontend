/**
 * 性能分析数据类型定义
 */

/**
 * 性能数据记录
 * 每一条性能分析数据的格式
 */
export interface PerformanceRecord {
  /** 开始时间 (Unix 时间戳，毫秒) */
  startTime: number;
  /** 结束时间 (Unix 时间戳，毫秒) */
  endTime: number;
  /** 行组 (同一行组颜色相同) */
  channelGroup: string;
  /** 行号 (在同一行组内的索引，可以是数字或字符串标识，如 "chunk请求线程1", "chunk合并线程6") */
  channelIndex: number | string;
  /** 消息 (hover 时除了时间外的显示信息) */
  msg: string;
}

/**
 * 性能数据会话
 * 一次完整的性能追踪会话包含多个记录
 */
export interface PerformanceSession {
  /** 会话 ID */
  sessionId: string;
  /** 会话开始时间 */
  sessionStartTime: number;
  /** 会话结束时间 */
  sessionEndTime: number;
  /** 性能记录列表 */
  records: PerformanceRecord[];
  /** 会话元数据 */
  metadata?: {
    filename?: string;
    chunkSize?: number;
    taskId?: string;
    [key: string]: unknown;
  };
}

/**
 * 行组配置
 */
export interface ChannelGroupConfig {
  /** 行组名称 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 颜色 */
  color: string;
  /** 行组顺序 */
  order: number;
}

/**
 * 性能追踪器配置
 */
export interface PerformanceTrackerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 会话 ID（如果不提供则自动生成） */
  sessionId?: string;
  /** 会话元数据 */
  metadata?: PerformanceSession['metadata'];
}

