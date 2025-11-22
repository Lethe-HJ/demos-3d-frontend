# Chunk 缓存功能说明

## 功能概述

本功能实现了基于 IndexedDB 的 chunk 数据缓存机制，可以显著提升重复加载相同文件时的性能。

## 主要特性

### 1. Worker 数量限制
- **最多 5 个 Worker**：无论用户设置的线程数是多少，实际最多只会创建 5 个 Worker
- UI 选项：1、2、4、5（移除了 8 选项，因为最多只能使用 5 个）

### 2. IndexedDB 缓存
- **缓存策略**：首次加载时从后端获取，后续加载时优先使用缓存
- **存储位置**：浏览器 IndexedDB，数据库名称：`voxel-grid-cache`
- **缓存键**：`${taskId}_${chunkIndex}`
- **缓存内容**：chunk 的二进制数据、min/max 值、时间戳

## 工作流程

### 加载流程

```
1. 前端发送预处理请求
   ↓
2. 收到 task_id 和 chunks 信息
   ↓
3. 主线程批量查询 IndexedDB 缓存
   ↓
4. 对于每个 chunk：
   ├─ 缓存命中 → 直接使用缓存数据
   └─ 缓存未命中 → 分配给 Worker 从后端请求
   ↓
5. 等待所有 chunk 加载完成
   ↓
6. 合并数据并处理
   ↓
7. 在空闲时间保存非缓存的 chunk 到 IndexedDB
```

### 缓存保存时机

- 使用 `requestIdleCallback` API 在浏览器空闲时保存
- 降级方案：如果不支持 `requestIdleCallback`，使用 `setTimeout`（延迟 1 秒）
- 只保存从网络获取的 chunk（标记为 `fromCache: false`）

## 代码结构

### 文件说明

1. **`indexedDB.ts`** - IndexedDB 管理工具类
   - `getChunk()` - 获取缓存的 chunk
   - `saveChunk()` - 保存 chunk 到缓存
   - `deleteTaskChunks()` - 删除指定 task 的所有缓存
   - `clearExpiredCache()` - 清理过期缓存（可选功能）

2. **`index.tsx`** - 主线程逻辑
   - 在加载前批量查询缓存
   - 区分缓存和网络数据
   - 在空闲时间保存缓存

## 性能优势

1. **减少网络请求**：缓存命中时直接使用本地数据，避免网络延迟
2. **提升加载速度**：从 IndexedDB 读取比网络请求快得多
3. **降低服务器压力**：减少重复的 chunk 请求
4. **离线支持**：已缓存的数据可以在离线状态下使用

## 注意事项

1. **存储空间**：IndexedDB 存储大小有限制（通常几 GB），大量缓存可能占用较多空间
2. **缓存过期**：当前实现不自动清理过期缓存，可以调用 `clearExpiredCache()` 手动清理
3. **数据一致性**：如果后端文件更新，缓存可能过期，需要手动清理对应 task 的缓存

## 清理缓存

如果需要清理缓存，可以使用以下方法：

```typescript
import { indexedDBManager } from './indexedDB';

// 清理指定 task 的所有 chunk 缓存
await indexedDBManager.deleteTaskChunks(taskId);

// 清理过期缓存（默认 7 天）
await indexedDBManager.clearExpiredCache();
```

## 调试

可以在浏览器开发者工具中查看 IndexedDB：
1. 打开 Chrome DevTools
2. Application → Storage → IndexedDB
3. 找到 `voxel-grid-cache` 数据库
4. 查看 `chunks` store 中的缓存数据

