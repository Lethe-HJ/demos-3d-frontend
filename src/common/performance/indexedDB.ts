/**
 * 性能数据 IndexedDB 管理器
 * 支持主线程和 Worker 线程访问
 */

import type { PerformanceSession, PerformanceRecord } from './types';

const DB_NAME = 'performance-trace-db';
const DB_VERSION = 1;
const STORE_NAME = 'performance-sessions';
const INDEX_SESSION_ID = 'sessionId';
const INDEX_START_TIME = 'startTime';

/**
 * IndexedDB 管理器类
 * 支持在空闲时存储性能数据
 */
export class PerformanceDBManager {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private pendingRecords: Map<string, PerformanceRecord[]> = new Map();
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * 初始化数据库
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`打开 IndexedDB 失败: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 创建对象存储
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
          store.createIndex(INDEX_SESSION_ID, 'sessionId', { unique: true });
          store.createIndex(INDEX_START_TIME, 'sessionStartTime', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * 添加性能记录到待保存队列（异步保存）
   */
  async addRecord(sessionId: string, record: PerformanceRecord): Promise<void> {
    await this.init();

    // 添加到待保存队列
    if (!this.pendingRecords.has(sessionId)) {
      this.pendingRecords.set(sessionId, []);
    }
    this.pendingRecords.get(sessionId)!.push(record);

    // 在空闲时保存
    this.scheduleSave();
  }

  /**
   * 批量添加性能记录
   */
  async addRecords(sessionId: string, records: PerformanceRecord[]): Promise<void> {
    await this.init();

    if (!this.pendingRecords.has(sessionId)) {
      this.pendingRecords.set(sessionId, []);
    }
    this.pendingRecords.get(sessionId)!.push(...records);

    this.scheduleSave();
  }

  /**
   * 完成会话并保存
   */
  async completeSession(session: PerformanceSession): Promise<void> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    // 确保待保存的记录已保存
    await this.flushPendingRecords(session.sessionId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const request = store.put(session);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`保存会话失败: ${request.error}`));
    });
  }

  /**
   * 获取会话
   */
  async getSession(sessionId: string): Promise<PerformanceSession | null> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(sessionId);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(new Error(`获取会话失败: ${request.error}`));
      };
    });
  }

  /**
   * 获取所有会话（按开始时间降序）
   */
  async getAllSessions(limit = 100): Promise<PerformanceSession[]> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index(INDEX_START_TIME);
      const request = index.openCursor(null, 'prev'); // 降序

      const sessions: PerformanceSession[] = [];
      let count = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && count < limit) {
          sessions.push(cursor.value);
          count++;
          cursor.continue();
        } else {
          resolve(sessions);
        }
      };

      request.onerror = () => {
        reject(new Error(`获取会话列表失败: ${request.error}`));
      };
    });
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(sessionId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`删除会话失败: ${request.error}`));
    });
  }

  /**
   * 清除所有数据
   */
  async clearAll(): Promise<void> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        this.pendingRecords.clear();
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`清除数据失败: ${request.error}`));
      };
    });
  }

  /**
   * 安排保存（在空闲时执行）
   */
  private scheduleSave(): void {
    if (this.saveTimeout) {
      // 清除之前的定时器（兼容主线程和 Worker 环境）
      if (typeof window !== 'undefined' && window.clearTimeout) {
        window.clearTimeout(this.saveTimeout);
      } else {
        clearTimeout(this.saveTimeout);
      }
    }

    // 使用 requestIdleCallback 或 setTimeout 在空闲时保存
    // Worker 环境不支持 requestIdleCallback，使用 setTimeout
    if (typeof requestIdleCallback !== 'undefined' && typeof window !== 'undefined') {
      requestIdleCallback(
        () => {
          this.flushPendingRecords();
        },
        { timeout: 2000 }
      );
    } else {
      // Worker 环境或浏览器不支持 requestIdleCallback，使用 setTimeout
      // setTimeout 在 Worker 和主线程中都可用
      this.saveTimeout = setTimeout(() => {
        this.flushPendingRecords();
      }, 1000);
    }
  }

  /**
   * 刷新待保存的记录（公开方法，供外部调用）
   */
  async flushPendingRecords(sessionId?: string): Promise<void> {
    if (!this.db) return;

    const sessionsToUpdate = sessionId
      ? [sessionId]
      : Array.from(this.pendingRecords.keys());

    for (const sid of sessionsToUpdate) {
      const records = this.pendingRecords.get(sid);
      if (!records || records.length === 0) continue;

      // 获取或创建会话
      let session = await this.getSession(sid);
      if (!session) {
        // 创建新会话
        session = {
          sessionId: sid,
          sessionStartTime: Math.min(...records.map((r) => r.startTime)),
          sessionEndTime: Math.max(...records.map((r) => r.endTime)),
          records: [],
        };
      }

      // 合并记录
      session.records.push(...records);
      session.records.sort((a, b) => a.startTime - b.startTime);
      session.sessionStartTime = Math.min(
        session.sessionStartTime,
        ...records.map((r) => r.startTime)
      );
      session.sessionEndTime = Math.max(
        session.sessionEndTime,
        ...records.map((r) => r.endTime)
      );

      // 保存到数据库
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.put(session!);

          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });

        // 清除已保存的记录
        this.pendingRecords.delete(sid);
      } catch (err) {
        console.error(`[PerformanceDB] 保存会话 ${sid} 失败:`, err);
      }
    }
  }
}

// 导出单例
export const performanceDB = new PerformanceDBManager();

// Worker 端可以直接使用 performanceDB，因为 IndexedDB 在 Worker 中也可用
// scheduleSave 方法已经兼容 Worker 环境（使用 setTimeout 而不是 requestIdleCallback）

