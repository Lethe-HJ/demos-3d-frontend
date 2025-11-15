# 性能对比说明

## 两种解压方式的性能特点

### 浏览器自动解压（如果采用）
```typescript
// 设置 Content-Encoding: gzip
// 浏览器自动解压
const response = await fetch('/api/voxel-grid?file=...');
const blob = await response.blob(); // 已解压
// 需要从 Blob 转换为 ArrayBuffer，然后再处理
const arrayBuffer = await blob.arrayBuffer();
```

**性能开销：**
- 解压：原生实现，快 ✅
- 数据传输：Blob → ArrayBuffer（额外复制）❌
- 线程：网络线程 → 主线程 → Worker（多次传递）❌

### Worker 手动解压（当前实现）
```typescript
// 接收压缩数据
const response = await fetch('/api/voxel-grid?file=...');
const compressed = await response.arrayBuffer();
// 在 Worker 中直接解压并处理
const decompressed = await decompressInWorker(compressed);
```

**性能开销：**
- 解压：原生 DecompressionStream API，快 ✅
- 数据传输：直接使用 ArrayBuffer（零拷贝）✅
- 线程：网络线程 → Worker（直接传递）✅

## 实测建议

对于大型二进制数据（如体素网格）：
- **Worker 手动解压更优**：减少内存复制，不阻塞 UI
- **浏览器自动解压适合**：小文件、JSON 数据

当前实现（Worker 手动解压）是**最佳实践**。
