# 性能模块迁移说明

## 主要变更

1. **新的性能模块位置**: `src/common/performance/`
2. **数据格式**: 使用新的 `PerformanceSession` 和 `PerformanceRecord` 格式
3. **存储方式**: 使用 IndexedDB 存储，支持 Worker 线程写入
4. **展示方式**: 用户点击按钮时才加载并展示

## 迁移步骤

1. 更新导入语句
2. 使用新的 `PerformanceTracker` 创建追踪器
3. 使用新的 API 记录性能数据
4. 移除摘要 UI (`lastTimings`)
5. 添加性能分析按钮和状态
6. 从 IndexedDB 加载并显示数据

## 新 API 使用示例

```typescript
// 创建追踪器
import { createTracker, performanceDB } from '@/common/performance';
const tracker = createTracker({ 
  enabled: true,
  metadata: { filename, chunkSize }
});

// 记录事件
tracker.recordEvent('network', 0, '发送预处理请求', startTime, endTime);
tracker.recordEvent('compute', 0, '合并chunk数据', startTime, endTime, duration);

// 完成会话
await tracker.complete();

// 加载会话
const session = await performanceDB.getSession(sessionId);
```

