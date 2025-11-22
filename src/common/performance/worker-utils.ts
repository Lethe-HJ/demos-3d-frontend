/**
 * Worker 端性能记录工具
 * Worker 可以直接调用这些函数来记录性能数据
 */

import type { PerformanceRecord } from './types';

/**
 * Worker 中记录性能数据
 * 使用 IndexedDB 存储（异步）
 */
export async function recordPerformanceInWorker(
  sessionId: string,
  record: PerformanceRecord
): Promise<void> {
  try {
    // 在 Worker 中直接访问 IndexedDB
    const dbName = 'performance-trace-db';
    const storeName = 'performance-sessions';
    const version = 1;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version);

      request.onerror = () => {
        reject(new Error(`打开 IndexedDB 失败: ${request.error}`));
      };

      request.onsuccess = () => {
        const db = request.result;

        // 获取或创建会话
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const getRequest = store.get(sessionId);

        getRequest.onsuccess = () => {
          let session = getRequest.result;

          if (!session) {
            // 创建新会话
            session = {
              sessionId,
              sessionStartTime: record.startTime,
              sessionEndTime: record.endTime,
              records: [],
            };
          } else {
            // 更新会话时间范围
            session.sessionStartTime = Math.min(session.sessionStartTime, record.startTime);
            session.sessionEndTime = Math.max(session.sessionEndTime, record.endTime);
          }

          // 添加记录
          session.records.push(record);
          session.records.sort((a, b) => a.startTime - b.startTime);

          // 保存会话
          const putRequest = store.put(session);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(new Error(`保存会话失败: ${putRequest.error}`));
        };

        getRequest.onerror = () => {
          reject(new Error(`获取会话失败: ${getRequest.error}`));
        };
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: 'sessionId' });
          store.createIndex('sessionId', 'sessionId', { unique: true });
          store.createIndex('startTime', 'sessionStartTime', { unique: false });
        }
      };
    });
  } catch (err) {
    console.error('[Worker Performance] 记录性能数据失败:', err);
    throw err;
  }
}

/**
 * Worker 中批量记录性能数据
 */
export async function recordBatchPerformanceInWorker(
  sessionId: string,
  records: PerformanceRecord[]
): Promise<void> {
  for (const record of records) {
    try {
      await recordPerformanceInWorker(sessionId, record);
    } catch (err) {
      console.error('[Worker Performance] 批量记录失败:', err);
    }
  }
}

