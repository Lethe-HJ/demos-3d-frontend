# 性能分析模块文档

## 目录

- [架构概述](#架构概述)
- [数据格式](#数据格式)
- [使用方法](#使用方法)
  - [后端使用](#后端使用)
  - [前端主线程使用](#前端主线程使用)
  - [Worker 线程使用](#worker-线程使用)
- [API 参考](#api-参考)
- [行组配置](#行组channel-group配置)
- [最佳实践](#最佳实践)
- [故障排查](#故障排查)
- [完整示例](#完整示例数据加载流程)

---

## 架构概述

性能分析模块是一个独立的、可复用的性能追踪系统，支持：

- ✅ **多线程支持**：主线程和 Worker 线程都可以记录性能数据
- ✅ **统一存储**：使用 IndexedDB 作为共享存储，所有线程写入同一数据库
- ✅ **异步保存**：在空闲时自动保存数据，不影响主流程性能
- ✅ **后端集成**：支持通过 HTTP 响应头传递性能数据
- ✅ **可视化展示**：提供火焰图组件展示性能时间轴

### 模块结构

```
src/common/performance/
├── types.ts              # 数据类型定义
├── tracker.ts            # 性能追踪器（核心类）
├── indexedDB.ts          # IndexedDB 管理器
├── response-header.ts    # 响应头解析工具
├── worker-utils.ts       # Worker 端工具函数
├── FlameGraph.tsx        # 火焰图可视化组件
├── index.ts              # 模块入口
└── README.md             # 本文档
```

### 数据流

```
┌─────────────┐
│   后端服务   │ ──(响应头)──>  ┌──────────────┐
└─────────────┘               │   前端主线程   │
                              │              │
┌─────────────┐               │  ┌────────┐  │
│  Worker 1   │ ──(直接写入)──>│  │Tracker │  │
└─────────────┘               │  └────────┘  │
                              │      │       │
┌─────────────┐               │      │       │
│  Worker 2   │ ──(直接写入)──>│      ▼       │
└─────────────┘               │  ┌────────┐  │
                              │  │IndexedDB│ │
                              │  └────────┘  │
                              └──────────────┘
                                      │
                                      ▼
                              ┌──────────────┐
                              │  火焰图展示    │
                              └──────────────┘
```

---

## 数据格式

### PerformanceRecord（性能记录）

每一条性能分析数据包含以下字段：

```typescript
interface PerformanceRecord {
  startTime: number;        // 开始时间 (Unix 时间戳，毫秒)
  endTime: number;          // 结束时间 (Unix 时间戳，毫秒)
  channelGroup: string;     // 行组 (同一行组颜色相同)
  channelIndex: number;     // 行号 (在同一行组内的索引)
  msg: string;              // 消息 (hover 时除了时间外的显示信息)
}
```

**字段说明：**

- `startTime` / `endTime`: 使用 Unix 时间戳（毫秒），例如 `Date.now()`
- `channelGroup`: 行组名称，可选值：`'network'`, `'cache'`, `'worker'`, `'compute'`, `'render'`, `'rust后端'`
- `channelIndex`: 行号，可以是数字或字符串标识
  - **数字**：用于前端主线程的性能记录
  - **字符串**：用于 Worker 线程和后端性能记录
    - Worker 线程：`"chunk请求线程0"`, `"chunk请求线程1"`, `"chunk合并线程0"`
    - 后端接口：`"preprocess_1"`, `"get_chunk_2"`
    - 后端后台任务：`"parse_file_3"`, `"split_chunk_4"`
- `msg`: 事件描述信息，会在火焰图的 tooltip 中显示

### PerformanceSession（性能会话）

一次完整的性能追踪会话：

```typescript
interface PerformanceSession {
  sessionId: string;                    // 会话 ID
  sessionStartTime: number;             // 会话开始时间
  sessionEndTime: number;                // 会话结束时间
  records: PerformanceRecord[];          // 性能记录列表
  metadata?: {                          // 会话元数据
    filename?: string;
    chunkSize?: number;
    taskId?: string;
    [key: string]: unknown;
  };
}
```

---

## 使用方法

### 后端使用

后端性能数据通过 **state 缓存**存储，不再通过响应头返回。前端在点击性能分析按钮时，通过 `sessionId` 请求后端性能数据。

#### 性能数据格式

后端性能数据使用以下格式：

- **channelGroup**: `"rust后端"`（固定值）
- **channelIndex**: 字符串标识，格式为 `接口名称_线程号` 或 `后台任务名称_线程号`
  - 接口名称示例：`"preprocess_1"`, `"get_chunk_2"`
  - 后台任务名称示例：`"parse_file_3"`, `"split_chunk_4"`

#### 获取性能数据接口

```
GET /api/performance?session_id={sessionId}
```

响应格式：

```json
{
  "session_id": "session_xxx",
  "records": [
    {
      "start_time": 1234567890,
      "end_time": 1234567900,
      "channel_group": "rust后端",
      "channel_index": "preprocess_1",
      "msg": "预处理请求: test.vasp"
    }
  ]
}
```

#### 示例代码（Rust/Actix Web）

```rust
use actix_web::{HttpResponse, web};
use std::time::{SystemTime, UNIX_EPOCH};

async fn handle_preprocess(req: web::Json<PreprocessRequest>) -> HttpResponse {
    let start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    
    // 执行预处理操作
    let result = preprocess_data(&req.file).await;
    
    let end_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    
    // 构建性能数据字符串
    let perf_data = format!(
        "{},{},network,0,后端预处理请求",
        start_time, end_time
    );
    
    HttpResponse::Ok()
        .insert_header(("X-Performance-Data", perf_data))
        .json(result)
}

// 多个性能数据示例
async fn handle_chunk(req: web::Query<ChunkRequest>) -> HttpResponse {
    let parse_start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    
    // 解析数据
    let data = parse_chunk_data(&req.task_id, req.chunk_index).await;
    
    let parse_end = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    
    let compress_start = parse_end;
    
    // 压缩数据
    let compressed = compress_data(&data);
    
    let compress_end = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    
    // 多个性能数据用分号分隔
    let perf_data = format!(
        "{},{},compute,0,后端解析chunk数据;{},{},compute,0,后端压缩chunk数据",
        parse_start, parse_end, compress_start, compress_end
    );
    
    HttpResponse::Ok()
        .insert_header(("X-Performance-Data", perf_data))
        .body(compressed)
}
```

#### 注意事项

1. 时间戳必须是 Unix 时间戳（毫秒）
2. `msg` 字段如果包含逗号，需要用引号包裹或使用其他分隔符
3. 多个性能数据用分号 `;` 分隔
4. 前端会自动解析响应头并记录到 IndexedDB

---

### 前端主线程使用

#### 1. 创建性能追踪器

```typescript
import { createTracker, performanceDB } from '@/common/performance';

// 创建追踪器
const tracker = createTracker({
  enabled: true,
  metadata: {
    filename: 'test.vasp',
    chunkSize: 100000,
  },
});

// 获取会话 ID（用于传递给 Worker）
const sessionId = tracker.getSessionId();

// 初始化 IndexedDB
await performanceDB.init();
```

#### 2. 记录性能事件

**方式一：使用 startEvent / endEvent（推荐用于异步操作）**

```typescript
// 开始记录
tracker.startEvent('event_id', 'network', 0, '发送预处理请求');

// 执行操作
await fetch('/api/endpoint');

// 结束记录
tracker.endEvent('event_id');
```

**方式二：使用 recordEvent（推荐用于已知开始和结束时间）**

```typescript
const startTime = Date.now();
// 执行操作
const endTime = Date.now();

tracker.recordEvent(
  'network',        // channelGroup
  0,                // channelIndex
  '发送预处理请求',  // msg
  startTime,        // startTime (可选，默认当前时间)
  endTime,          // endTime (可选，默认当前时间)
);
```

**方式三：使用 recordEvent 和 duration**

```typescript
const startTime = Date.now();
// 执行操作
const duration = 100; // 毫秒

tracker.recordEvent(
  'compute',
  0,
  '计算数据',
  startTime,
  undefined,  // endTime 不提供
  duration,   // 使用 duration
);
```

#### 3. 从后端获取性能数据（点击性能分析按钮时）

```typescript
// 在点击性能分析按钮时，从后端获取性能数据
const response = await fetch(`/api/performance?session_id=${sessionId}`);
if (response.ok) {
  const backendData = await response.json();
  const backendRecords = backendData.records.map((r: any) => ({
    startTime: r.start_time,
    endTime: r.end_time,
    channelGroup: r.channel_group,
    channelIndex: r.channel_index, // 后端返回的是字符串
    msg: r.msg,
  }));
  
  // 合并到本地 session
  if (session) {
    session.records = [...session.records, ...backendRecords];
  }
}
```

#### 4. 完成会话并保存

```typescript
// 在操作完成后调用
await tracker.complete();
```

#### 5. 加载并展示性能数据

```typescript
import { performanceDB, FlameGraph } from '@/common/performance';
import type { PerformanceSession } from '@/common/performance';

// 加载会话
const session = await performanceDB.getSession(sessionId);

// 在 React 组件中展示
function MyComponent() {
  const [session, setSession] = useState<PerformanceSession | null>(null);
  
  const loadPerformance = async () => {
    const s = await performanceDB.getSession(sessionId);
    setSession(s);
  };
  
  return (
    <>
      <button onClick={loadPerformance}>查看性能分析</button>
      {session && <FlameGraph session={session} />}
    </>
  );
}
```

#### 完整示例

```typescript
import { createTracker, performanceDB } from '@/common/performance';

async function loadData() {
  // 1. 创建追踪器
  const tracker = createTracker({
    enabled: true,
    metadata: { filename: 'test.vasp' },
  });
  const sessionId = tracker.getSessionId();
  await performanceDB.init();
  
  // 2. 记录预处理请求（传递 sessionId 给后端）
  tracker.startEvent('preprocess', 'network', 0, '发送预处理请求');
  const response = await fetch('/api/preprocess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      file: 'test.vasp',
      session_id: sessionId, // 传递 sessionId 给后端
    }),
  });
  
  tracker.endEvent('preprocess');
  
  // 3. 记录数据处理
  const processStart = Date.now();
  // ... 处理数据
  const processEnd = Date.now();
  tracker.recordEvent('compute', 0, '处理数据', processStart, processEnd);
  
  // 4. 完成会话
  await tracker.complete();
  
  return sessionId;
}

// 5. 点击性能分析按钮时，从后端获取性能数据
async function loadPerformance(sessionId: string) {
  await performanceDB.init();
  let session = await performanceDB.getSession(sessionId);
  
  // 从后端获取性能数据
  try {
    const response = await fetch(`/api/performance?session_id=${sessionId}`);
    if (response.ok) {
      const backendData = await response.json();
      const backendRecords = backendData.records.map((r: any) => ({
        startTime: r.start_time,
        endTime: r.end_time,
        channelGroup: r.channel_group,
        channelIndex: r.channel_index,
        msg: r.msg,
      }));
      
      // 合并后端记录到本地 session
      if (session) {
        session.records = [...session.records, ...backendRecords];
        const allTimes = session.records.flatMap(r => [r.startTime, r.endTime]);
        session.sessionStartTime = Math.min(...allTimes);
        session.sessionEndTime = Math.max(...allTimes);
      } else {
        session = {
          sessionId,
          sessionStartTime: Math.min(...backendRecords.map(r => r.startTime)),
          sessionEndTime: Math.max(...backendRecords.map(r => r.endTime)),
          records: backendRecords,
        };
      }
    }
  } catch (err) {
    console.error('从后端加载性能数据失败:', err);
  }
  
  return session;
}
```

---

### Worker 线程使用

Worker 线程可以创建自己的 tracker 实例，使用相同的 `sessionId`，数据会自动写入同一个 IndexedDB 会话。

#### 1. 接收 sessionId

主线程在发送消息给 Worker 时需要传递 `sessionId`：

```typescript
// 主线程
worker.postMessage({
  type: 'fetch-chunk',
  taskId: 'xxx',
  chunkIndex: 0,
  sessionId: tracker.getSessionId(), // 传递 sessionId
});
```

#### 2. Worker 中初始化 tracker

```typescript
// Worker 文件 (chunkLoader.worker.ts)
let tracker: any = null;
let sessionId: string | null = null;

self.addEventListener('message', async (event) => {
  const { sessionId: newSessionId, ...otherData } = event.data;
  
  // 初始化 tracker（如果 sessionId 变化或 tracker 未初始化）
  if (newSessionId && newSessionId !== sessionId) {
    sessionId = newSessionId;
    try {
      // 动态导入 tracker（Worker 环境）
      const { createTracker } = await import('../../common/performance/tracker');
      tracker = createTracker({
        enabled: true,
        sessionId: newSessionId,
      });
    } catch (err) {
      console.error('[Worker] 初始化 tracker 失败:', err);
    }
  }
  
  // 使用 tracker 记录性能数据
  if (tracker) {
    tracker.startEvent('fetch_chunk', 'network', chunkIndex, `Worker 请求 Chunk ${chunkIndex}`);
  }
  
  // 执行操作
  const response = await fetch(url);
  
  if (tracker) {
    tracker.endEvent('fetch_chunk');
    
    // 解析响应头中的性能数据
    const { recordPerformanceFromResponse } = await import('../../common/performance/response-header');
    await recordPerformanceFromResponse(response.clone(), sessionId);
  }
});
```

#### 3. Worker 中记录性能事件

Worker 中使用 tracker 的方式与主线程完全相同：

```typescript
// 方式一：startEvent / endEvent
tracker.startEvent('event_id', 'compute', 0, 'Worker 计算数据');
// ... 执行操作
tracker.endEvent('event_id');

// 方式二：recordEvent
const startTime = Date.now();
// ... 执行操作
const endTime = Date.now();
tracker.recordEvent('compute', 0, 'Worker 计算数据', startTime, endTime);
```

#### 完整示例（ChunkLoader Worker）

```typescript
/// <reference lib="webworker" />

let tracker: any = null;
let sessionId: string | null = null;

self.addEventListener('message', async (event) => {
  const { taskId, chunkIndex, sessionId: newSessionId } = event.data;
  
  // 初始化 tracker
  if (newSessionId && newSessionId !== sessionId) {
    sessionId = newSessionId;
    const { createTracker } = await import('../../common/performance/tracker');
    tracker = createTracker({ enabled: true, sessionId: newSessionId });
  }
  
  const url = `/api/chunk?task_id=${taskId}&chunk_index=${chunkIndex}`;
  
  try {
    // 记录网络请求
    const fetchStart = Date.now();
    if (tracker) {
      tracker.startEvent(`fetch_${chunkIndex}`, 'network', chunkIndex, `请求 Chunk ${chunkIndex}`);
    }
    
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    
    const fetchEnd = Date.now();
    if (tracker) {
      tracker.endEvent(`fetch_${chunkIndex}`);
      
      // 解析响应头性能数据
      const { recordPerformanceFromResponse } = await import('../../common/performance/response-header');
      await recordPerformanceFromResponse(response.clone(), sessionId!);
    }
    
    // 记录数据解析
    const parseStart = Date.now();
    const data = new Float64Array(buffer);
    // ... 处理数据
    const parseEnd = Date.now();
    
    if (tracker) {
      tracker.recordEvent('compute', chunkIndex, `解析 Chunk ${chunkIndex}`, parseStart, parseEnd);
    }
    
    self.postMessage({ type: 'chunk', chunkIndex, buffer });
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message });
  }
});
```

---

## API 参考

### PerformanceTracker 类

#### 构造函数

```typescript
new PerformanceTracker(config?: PerformanceTrackerConfig)
```

**参数：**

- `config.enabled`: 是否启用追踪（默认 `true`）
- `config.sessionId`: 会话 ID（不提供则自动生成）
- `config.metadata`: 会话元数据

#### 方法

##### `startEvent(eventId, channelGroup, channelIndex, msg)`

开始记录一个事件。

**参数：**
- `eventId`: 事件唯一标识符
- `channelGroup`: 行组名称
- `channelIndex`: 行号
- `msg`: 事件描述

##### `endEvent(eventId)`

结束记录一个事件。

**参数：**
- `eventId`: 事件唯一标识符（必须与 `startEvent` 中的一致）

##### `recordEvent(channelGroup, channelIndex, msg, startTime?, endTime?, duration?)`

记录一个完整的事件。

**参数：**
- `channelGroup`: 行组名称
- `channelIndex`: 行号
- `msg`: 事件描述
- `startTime`: 开始时间（可选，默认当前时间）
- `endTime`: 结束时间（可选，默认当前时间）
- `duration`: 持续时间（可选，如果提供则忽略 `endTime`）

##### `complete()`

完成会话并保存到 IndexedDB。

##### `getSessionId()`

获取会话 ID。

##### `updateMetadata(metadata)`

更新会话元数据。

### PerformanceDBManager 类

#### 方法

##### `init()`

初始化 IndexedDB 数据库。

##### `addRecord(sessionId, record)`

添加一条性能记录（异步保存）。

##### `addRecords(sessionId, records)`

批量添加性能记录。

##### `getSession(sessionId)`

获取指定会话。

##### `getAllSessions(limit?)`

获取所有会话（按开始时间降序）。

##### `deleteSession(sessionId)`

删除指定会话。

##### `clearAll()`

清除所有数据。

##### `flushPendingRecords(sessionId?)`

刷新待保存的记录（立即保存）。

### 工具函数

#### `createTracker(config?)`

创建性能追踪器实例。

#### `recordPerformanceFromResponse(response, sessionId)`

从 HTTP 响应中解析并记录性能数据。

#### `parsePerformanceFromHeaders(headers, sessionId)`

解析响应头中的性能数据。

---

## 行组（Channel Group）配置

系统预定义了 5 个行组：

| 行组名称 | 显示名称 | 颜色 | 用途 |
|---------|---------|------|------|
| `network` | 网络 | `#4a90e2` | 网络请求相关 |
| `cache` | 缓存 | `#7ed321` | 缓存操作相关 |
| `worker` | Worker | `#f5a623` | Worker 线程相关 |
| `compute` | 计算 | `#bd10e0` | 计算处理相关 |
| `render` | 渲染 | `#50e3c2` | 渲染相关 |

---

## 最佳实践

### 1. 事件 ID 命名

使用有意义的、唯一的事件 ID：

```typescript
// ✅ 好的命名
tracker.startEvent('preprocess_request', 'network', 0, '发送预处理请求');
tracker.startEvent('chunk_0_fetch', 'network', 0, '请求 Chunk 0');

// ❌ 不好的命名
tracker.startEvent('event1', 'network', 0, '事件1');
```

### 2. 行号使用

- 同一类型的多个并行操作使用不同的 `channelIndex`
- 例如：多个 Worker 同时加载不同的 chunk，可以使用 chunkIndex 作为 channelIndex

```typescript
// Worker 0 加载 Chunk 0
tracker.recordEvent('network', 0, 'Worker 0 加载 Chunk 0', start, end);

// Worker 1 加载 Chunk 1
tracker.recordEvent('network', 1, 'Worker 1 加载 Chunk 1', start, end);
```

### 3. 时间戳一致性

所有时间戳必须使用 Unix 时间戳（毫秒），使用 `Date.now()`：

```typescript
// ✅ 正确
const startTime = Date.now();

// ❌ 错误（performance.now() 是相对时间）
const startTime = performance.now();
```

### 4. 错误处理

始终处理可能的错误：

```typescript
try {
  await tracker.complete();
} catch (err) {
  console.error('完成性能追踪失败:', err);
}
```

### 5. 性能考虑

- 性能记录是异步的，不会阻塞主流程
- 数据在空闲时自动保存，使用 `requestIdleCallback`
- 如果需要在特定时间点确保数据已保存，可以调用 `performanceDB.flushPendingRecords(sessionId)`

---

## 故障排查

### 问题：Worker 中 tracker 初始化失败

**原因：** 导入路径错误或模块未正确打包

**解决：**
1. 检查导入路径是否正确（Worker 中需要使用相对路径）
2. 确保 Vite 配置支持 Worker 中的动态导入

### 问题：性能数据未显示

**原因：** 会话未完成或数据未保存

**解决：**
1. 确保调用了 `tracker.complete()`
2. 检查 IndexedDB 中是否有数据
3. 使用浏览器开发者工具查看 IndexedDB

### 问题：时间戳不准确

**原因：** 使用了 `performance.now()` 而不是 `Date.now()`

**解决：** 统一使用 `Date.now()` 获取 Unix 时间戳

---

## 示例：完整的数据加载流程

```typescript
// 主线程
async function loadData() {
  // 1. 创建追踪器
  const tracker = createTracker({
    enabled: true,
    metadata: { filename: 'test.vasp' },
  });
  const sessionId = tracker.getSessionId();
  await performanceDB.init();
  
  // 2. 记录预处理请求
  tracker.startEvent('preprocess', 'network', 0, '发送预处理请求');
  const response = await fetch('/api/preprocess', {
    method: 'POST',
    body: JSON.stringify({ file: 'test.vasp' }),
  });
  await recordPerformanceFromResponse(response, sessionId);
  tracker.endEvent('preprocess');
  
  // 3. 创建 Worker 并传递 sessionId
  const worker = new ChunkLoaderWorker();
  worker.postMessage({
    type: 'fetch-chunk',
    taskId: 'xxx',
    chunkIndex: 0,
    sessionId: sessionId, // 传递给 Worker
  });
  
  // 4. 记录数据处理
  const processStart = Date.now();
  // ... 处理数据
  const processEnd = Date.now();
  tracker.recordEvent('compute', 0, '处理数据', processStart, processEnd);
  
  // 5. 完成会话
  await tracker.complete();
  
  return sessionId;
}

// Worker 中
self.addEventListener('message', async (event) => {
  const { sessionId, chunkIndex } = event.data;
  
  // 初始化 tracker
  const { createTracker } = await import('../../common/performance/tracker');
  const tracker = createTracker({ enabled: true, sessionId });
  
  // 记录性能数据
  tracker.startEvent('fetch', 'network', chunkIndex, `请求 Chunk ${chunkIndex}`);
  const response = await fetch(url);
  tracker.endEvent('fetch');
  
  // 解析响应头
  const { recordPerformanceFromResponse } = await import('../../common/performance/response-header');
  await recordPerformanceFromResponse(response, sessionId);
});
```

---

## 总结

性能分析模块提供了完整的性能追踪解决方案：

- ✅ **统一的数据格式**：所有性能数据使用相同的格式
- ✅ **多线程支持**：主线程和 Worker 都可以记录
- ✅ **自动存储**：数据自动保存到 IndexedDB
- ✅ **后端集成**：支持通过响应头传递性能数据
- ✅ **可视化展示**：提供火焰图组件

通过这个模块，可以全面追踪从前端到后端、从主线程到 Worker 的所有性能数据。

