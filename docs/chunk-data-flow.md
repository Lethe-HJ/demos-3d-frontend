# Chunk数据处理流程

本文档详细描述了前端和后端的chunk数据处理流程。

## 流程概览

整个流程分为以下几个主要阶段：

1. **预处理阶段** - 快速获取元数据并创建任务
2. **后台解析阶段** - 异步解析文件并分割成chunk
3. **并行加载阶段** - 前端多个Worker并行请求chunk数据
4. **数据合并阶段** - 合并所有chunk并处理

## 详细流程

### 1. 预处理阶段（同步，快速返回）

```
前端 → 后端: POST /api/voxel-grid/preprocess
{file: "CHGDIFF.vasp", chunk_size: 100000}
```

后端处理步骤：
1. 参数验证与文件路径构建
2. 查找匹配的解析器（根据文件扩展名）
3. 获取文件大小
4. **快速获取shape**（只读取元数据，如VASP文件的前29行）
5. **计算分块信息**（根据chunk_size划分chunks）
6. **创建TaskData**（此时chunk_data全部为None，表示未就绪）
7. 生成task_id并存储TaskData
8. **立即返回响应**（不等待文件解析）

返回数据：
```json
{
  "task_id": "uuid",
  "file": "CHGDIFF.vasp",
  "file_size": 1234567,
  "shape": [112, 112, 108],
  "data_length": 1354752,
  "chunk_size": 100000,
  "chunks": [
    {index: 0, start: 0, end: 100000},
    {index: 1, start: 100000, end: 200000},
    ...
  ]
}
```

### 2. 后台解析阶段（异步，不阻塞响应）

后端在返回预处理响应后，立即启动后台任务：

1. **解析完整文件**（顺序执行，因为文件格式是顺序的）
   - 使用解析器读取完整文件
   - 生成完整的VoxelGrid数据结构

2. **并行分割成多个chunk**（可以并行执行）
   - 为每个chunk创建一个异步任务
   - 每个任务复制对应的数据切片
   - 调用`task.set_chunk(index, chunk_data)`标记为已就绪

```rust
// 伪代码
for descriptor in chunks {
    spawn(async move {
        let chunk_values = data[descriptor.start..descriptor.end].to_vec();
        task.set_chunk(descriptor.index, chunk_values);
    });
}
```

### 3. 并行加载阶段（前端Worker）

前端收到预处理响应后：

1. **创建多个ChunkLoader Worker**
   - 数量 = `min(threadCount, chunks.length)`
   - 默认4个Worker（可在UI中选择1/2/4/8）

2. **轮询分配策略**
   - Worker 0: 处理 chunk 0, 4, 8, ...
   - Worker 1: 处理 chunk 1, 5, 9, ...
   - Worker 2: 处理 chunk 2, 6, ...
   - Worker 3: 处理 chunk 3, 7, ...

3. **每个Worker的请求流程**
   ```
   Worker → 后端: GET /api/voxel-grid/chunk?task_id=xxx&chunk_index=0
   ```
   
   后端处理：
   - 检查task是否存在
   - 检查chunk是否已就绪
   - 如果就绪：调用`task.take_chunk(index)`获取并移除数据，返回200 OK + 二进制数据
   - 如果未就绪：返回202 Accepted（前端需要重试）

4. **Worker的重试逻辑**
   - 如果收到202 Accepted，说明chunk还在解析中
   - 使用指数退避重试：100ms, 200ms, 400ms, 800ms...
   - 最多重试10次

5. **Worker处理响应**
   - 解析ArrayBuffer为Float64Array
   - 计算chunk的min/max
   - 发送结果给主线程

### 4. 数据合并阶段（前端主线程）

1. **等待所有chunk加载完成**
   ```typescript
   await Promise.all(chunkPromises);
   ```

2. **按chunkIndex排序**
   ```typescript
   chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);
   ```

3. **合并所有chunk数据**
   - 创建完整的Float64Array
   - 按顺序将各个chunk的数据复制到合并数组

4. **计算全局min/max**
   - 从所有chunk的min/max中取最小和最大值

5. **终止Worker**
   - 所有数据加载完成后，终止所有ChunkLoader Worker

6. **发送给VoxelGrid Worker处理**
   - 进行SurfaceNets等值面计算
   - 渲染到Three.js

## 关键设计点

### 1. 异步非阻塞
- 预处理立即返回，不等待文件解析
- 文件解析在后台异步进行
- 前端可以立即开始请求chunk

### 2. 内存管理
- 每个chunk被请求后，立即从TaskData中移除（`take_chunk`）
- 避免重复请求占用内存
- 支持TTL自动清理过期任务

### 3. 并行处理
- 后端并行分割chunk
- 前端多个Worker并行请求chunk
- 最大化利用CPU和网络资源

### 4. 重试机制
- 处理chunk解析未完成的情况
- 指数退避避免频繁请求
- 最多重试10次防止无限等待

## 状态流转

### Chunk状态
```
创建TaskData → chunk_data[0] = None (未就绪)
       ↓
后台解析完成 → chunk_data[0] = Some(Vec<f64>) (已就绪)
       ↓
前端请求chunk → chunk_data[0] = removed (已请求)
```

### HTTP状态码
- `200 OK`: chunk已就绪，返回二进制数据
- `202 Accepted`: chunk正在解析中，需要重试
- `400 Bad Request`: task_id或chunk_index无效，或chunk已被请求
- `404 Not Found`: task不存在（可能已过期）

## 性能优化

1. **快速预处理**: 只读取元数据，快速返回
2. **并行解析**: 后端并行分割，前端并行加载
3. **按需加载**: chunk按需请求，不一次性加载全部
4. **内存释放**: 请求后立即释放，避免内存占用
5. **Worker复用**: 每个Worker处理多个chunk，减少创建开销

## 流程图

详细的流程图请查看 `chunk-data-flow.puml` 文件，使用PlantUML工具可以生成可视化流程图。

