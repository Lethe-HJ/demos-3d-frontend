/**
 * 性能追踪器
 * 记录从数据加载到渲染完成的所有时间节点
 */

export interface PerformanceEvent {
  name: string;
  startTime: number; // 相对开始时间的毫秒数
  duration: number; // 持续时间（毫秒）
  category: 'network' | 'cache' | 'worker' | 'compute' | 'render';
  metadata?: {
    chunkIndex?: number;
    workerId?: number;
    fromCache?: boolean;
    [key: string]: any;
  };
}

export interface PerformanceTrace {
  startTime: number; // 绝对开始时间
  totalDuration: number; // 总耗时
  events: PerformanceEvent[];
}

export class PerformanceTracker {
  private startTime: number;
  private events: PerformanceEvent[] = [];
  private currentEvent: { name: string; startTime: number; category: PerformanceEvent['category']; metadata?: any } | null = null;

  constructor() {
    this.startTime = performance.now();
  }

  /**
   * 开始记录一个事件
   */
  startEvent(
    name: string,
    category: PerformanceEvent['category'],
    metadata?: PerformanceEvent['metadata']
  ): void {
    // 如果之前有未结束的事件，先结束它
    if (this.currentEvent) {
      this.endEvent();
    }

    const relativeStart = performance.now() - this.startTime;
    this.currentEvent = {
      name,
      startTime: relativeStart,
      category,
      metadata,
    };
  }

  /**
   * 结束当前事件
   */
  endEvent(): void {
    if (!this.currentEvent) return;

    const endTime = performance.now();
    const duration = endTime - (this.startTime + this.currentEvent.startTime);

    this.events.push({
      name: this.currentEvent.name,
      startTime: this.currentEvent.startTime,
      duration,
      category: this.currentEvent.category,
      metadata: this.currentEvent.metadata,
    });

    this.currentEvent = null;
  }

  /**
   * 记录一个完整的事件（开始到结束）
   */
  recordEvent(
    name: string,
    category: PerformanceEvent['category'],
    startTime: number,
    duration: number,
    metadata?: PerformanceEvent['metadata']
  ): void {
    const relativeStart = startTime - this.startTime;
    this.events.push({
      name,
      startTime: relativeStart,
      duration,
      category,
      metadata,
    });
  }

  /**
   * 获取性能追踪结果
   */
  getTrace(): PerformanceTrace {
    // 确保最后一个事件也结束
    if (this.currentEvent) {
      this.endEvent();
    }

    const endTime = performance.now();
    const totalDuration = endTime - this.startTime;

    // 按开始时间排序
    const sortedEvents = [...this.events].sort((a, b) => a.startTime - b.startTime);

    return {
      startTime: this.startTime,
      totalDuration,
      events: sortedEvents,
    };
  }

  /**
   * 重置追踪器
   */
  reset(): void {
    this.startTime = performance.now();
    this.events = [];
    this.currentEvent = null;
  }
}

