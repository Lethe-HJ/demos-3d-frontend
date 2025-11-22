/**
 * 后端响应头性能数据解析
 * 从响应头中提取性能数据并记录
 */

import type { PerformanceRecord } from './types';
import { recordPerformanceInWorker } from './worker-utils';

/**
 * 解析响应头中的性能数据
 * 格式: X-Performance-Data: startTime,endTime,channelGroup,channelIndex,msg
 */
export function parsePerformanceFromHeaders(
  headers: Headers,
  sessionId: string
): PerformanceRecord[] {
  const records: PerformanceRecord[] = [];
  const perfHeader = headers.get('X-Performance-Data');

  if (!perfHeader) return records;

  // 支持多个性能数据（用分号分隔）
  const perfDataList = perfHeader.split(';').filter(Boolean);

  for (const perfData of perfDataList) {
    try {
      const parts = perfData.trim().split(',');
      if (parts.length < 5) continue;

      const startTime = parseInt(parts[0], 10);
      const endTime = parseInt(parts[1], 10);
      const channelGroup = parts[2];
      const channelIndex = parseInt(parts[3], 10);
      const msg = parts.slice(4).join(','); // msg 可能包含逗号

      if (isNaN(startTime) || isNaN(endTime) || isNaN(channelIndex)) {
        console.warn('[Performance] 无效的性能数据格式:', perfData);
        continue;
      }

      records.push({
        startTime,
        endTime,
        channelGroup,
        channelIndex,
        msg,
      });
    } catch (err) {
      console.error('[Performance] 解析性能数据失败:', err, perfData);
    }
  }

  return records;
}

/**
 * 从响应对象中提取并记录性能数据
 */
export async function recordPerformanceFromResponse(
  response: Response,
  sessionId: string
): Promise<void> {
  const records = parsePerformanceFromHeaders(response.headers, sessionId);

  if (records.length === 0) return;

  // 如果是 Worker 环境，使用 Worker 工具
  if (typeof self !== 'undefined' && 'importScripts' in self) {
    for (const record of records) {
      await recordPerformanceInWorker(sessionId, record).catch((err) => {
        console.error('[Performance] Worker 记录性能数据失败:', err);
      });
    }
  } else {
    // 主线程环境，使用 IndexedDB 管理器
    const { performanceDB } = await import('./indexedDB');
    await performanceDB.init();
    await performanceDB.addRecords(sessionId, records).catch((err) => {
      console.error('[Performance] 主线程记录性能数据失败:', err);
    });
  }
}

