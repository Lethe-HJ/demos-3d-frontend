/**
 * 性能数据 IndexedDB 管理器
 * 支持主线程和 Worker 线程访问
 */

import type { PerformanceSession, PerformanceRecord } from './types';

const DB_NAME = 'performance-trace-db';
const INITIAL_DB_VERSION = 1; // 初始版本号（仅在数据库不存在时使用）
const STORE_NAME_PREFIX = 'performance-session-'; // Store 名称前缀

/**
 * 获取 sessionId 对应的 store 名称
 */
function getStoreName(sessionId: string): string {
  return `${STORE_NAME_PREFIX}${sessionId}`;
}

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
   * 获取当前数据库版本（如果数据库已存在）
   */
  private async getCurrentVersion(): Promise<number> {
    return new Promise((resolve) => {
      // 尝试打开数据库但不指定版本，获取当前版本
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => {
        const version = request.result.version;
        request.result.close();
        resolve(version);
      };
      request.onerror = () => {
        // 数据库不存在，返回 0
        resolve(0);
      };
    });
  }

  /**
   * 初始化数据库
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // 先尝试获取当前数据库版本
        const currentVersion = await this.getCurrentVersion();
        const targetVersion = currentVersion > 0 ? currentVersion : INITIAL_DB_VERSION;

        // 尝试打开数据库
        return new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, targetVersion);

          request.onerror = () => {
            const error = request.error;
            // 如果是版本错误，尝试重新获取版本并重试
            if (error && error.name === 'VersionError') {
              // 重新获取版本并重试
              this.getCurrentVersion().then((actualVersion) => {
                if (actualVersion > 0) {
                  // 使用实际版本重新打开
                  const retryRequest = indexedDB.open(DB_NAME, actualVersion);
                  retryRequest.onerror = () => {
                    reject(new Error(`打开 IndexedDB 失败: ${retryRequest.error}`));
                  };
                  retryRequest.onsuccess = () => {
                    this.db = retryRequest.result;
                    resolve();
                  };
                  retryRequest.onupgradeneeded = () => {
                    // 不需要升级，忽略
                  };
                } else {
                  reject(new Error(`打开 IndexedDB 失败: ${error}`));
                }
              }).catch(() => {
                reject(new Error(`打开 IndexedDB 失败: ${error}`));
              });
            } else {
              reject(new Error(`打开 IndexedDB 失败: ${error}`));
            }
          };

          request.onsuccess = () => {
            this.db = request.result;
            resolve();
          };

          request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;

            // 删除旧版本的 store（如果存在）
            if (db.objectStoreNames.contains('performance-sessions')) {
              db.deleteObjectStore('performance-sessions');
            }

            // 不再在这里创建 store，而是在需要时动态创建
            // Store 会在第一次使用时通过 ensureStore 方法创建
          };
        });
      } catch (error) {
        throw new Error(`初始化 IndexedDB 失败: ${error}`);
      }
    })();

    return this.initPromise;
  }

  /**
   * 确保指定 sessionId 的 store 存在，如果不存在则创建
   */
  private async ensureStore(sessionId: string): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('数据库未初始化');

    const storeName = getStoreName(sessionId);
    
    // 如果 store 已存在，直接返回
    if (this.db.objectStoreNames.contains(storeName)) {
      return;
    }

    // Store 不存在，需要创建
    // 注意：IndexedDB 只能在 upgrade 事务中创建 store
    // 所以我们需要关闭并重新打开数据库，触发 upgrade
    
    // 关闭当前数据库连接
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    // 重置 initPromise，以便后续可以重新初始化
    this.initPromise = null;

    // 获取当前版本并升级
    const currentVersion = await this.getCurrentVersion();
    const newVersion = currentVersion + 1;

    return new Promise((resolve, reject) => {
      // 重新打开数据库，触发 upgrade
      const request = indexedDB.open(DB_NAME, newVersion);

      request.onerror = () => {
        this.initPromise = null; // 失败时重置，允许重试
        reject(new Error(`打开 IndexedDB 失败: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建该 sessionId 的 store
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { autoIncrement: true });
          // 为记录创建索引，方便查询
          store.createIndex('startTime', 'startTime', { unique: false });
          store.createIndex('endTime', 'endTime', { unique: false });
        }
      };
    });
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
   * 批量添加性能记 录
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

    // 确保 store 存在（可能会关闭并重新打开数据库）
    await this.ensureStore(session.sessionId);

    // ensureStore 可能会关闭并重新打开数据库，需要再次检查
    if (!this.db) {
      await this.init();
      if (!this.db) throw new Error('数据库未初始化');
    }

    const storeName = getStoreName(session.sessionId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      // 存储 session 元数据和所有记录
      const sessionData = {
        sessionId: session.sessionId,
        sessionStartTime: session.sessionStartTime,
        sessionEndTime: session.sessionEndTime,
        records: session.records,
        metadata: session.metadata,
      };

      // 使用 sessionId 作为 key，存储整个 session 数据
      const request = store.put(sessionData, 'session');

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

    const storeName = getStoreName(sessionId);

    // 如果 store 不存在，返回 null
    if (!this.db.objectStoreNames.contains(storeName)) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get('session');

      request.onsuccess = () => {
        const result = request.result;
        if (!result) {
          resolve(null);
          return;
        }

        // 转换为 PerformanceSession 格式
        const session: PerformanceSession = {
          sessionId: result.sessionId,
          sessionStartTime: result.sessionStartTime,
          sessionEndTime: result.sessionEndTime,
          records: result.records || [],
          metadata: result.metadata,
        };

        resolve(session);
      };

      request.onerror = () => {
        reject(new Error(`获取会话失败: ${request.error}`));
      };
    });
  }

  /**
   * 获取所有会话（按开始时间降序）
   * 注意：由于每个 sessionId 对应一个独立的 store，需要遍历所有 store
   */
  async getAllSessions(limit = 100): Promise<PerformanceSession[]> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    const storeNames = Array.from(this.db.objectStoreNames);

    // 遍历所有以 STORE_NAME_PREFIX 开头的 store
    const sessionStores = storeNames.filter((name) =>
      name.startsWith(STORE_NAME_PREFIX)
    );

    // 获取所有 session 数据
    const sessionPromises = sessionStores.map(async (storeName) => {
      try {
        const transaction = this.db!.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get('session');

        return new Promise<PerformanceSession | null>((resolve, reject) => {
          request.onsuccess = () => {
            const result = request.result;
            if (!result) {
              resolve(null);
              return;
            }

            const session: PerformanceSession = {
              sessionId: result.sessionId,
              sessionStartTime: result.sessionStartTime,
              sessionEndTime: result.sessionEndTime,
              records: result.records || [],
              metadata: result.metadata,
            };

            resolve(session);
          };

          request.onerror = () => {
            reject(new Error(`获取会话失败: ${request.error}`));
          };
        });
      } catch (err) {
        console.error(`[PerformanceDB] 获取 store ${storeName} 失败:`, err);
        return null;
      }
    });

    const allSessions = await Promise.all(sessionPromises);
    const validSessions = allSessions.filter(
      (s): s is PerformanceSession => s !== null
    );

    // 按开始时间降序排序
    validSessions.sort(
      (a, b) => b.sessionStartTime - a.sessionStartTime
    );

    return validSessions.slice(0, limit);
  }

  /**
   * 删除会话（删除整个 store）
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    const storeName = getStoreName(sessionId);

    // 如果 store 不存在，直接返回
    if (!this.db.objectStoreNames.contains(storeName)) {
      return;
    }

    // 删除整个 store（需要在 upgrade 事务中）
    // 关闭当前数据库连接
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    // 重置 initPromise，以便后续可以重新初始化
    this.initPromise = null;

    // 获取当前版本并升级
    const currentVersion = await this.getCurrentVersion();
    const newVersion = currentVersion + 1;

    return new Promise((resolve, reject) => {
      // 重新打开数据库，触发 upgrade
      const request = indexedDB.open(DB_NAME, newVersion);

      request.onerror = () => {
        this.initPromise = null; // 失败时重置，允许重试
        reject(new Error(`打开 IndexedDB 失败: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 删除该 sessionId 的 store
        if (db.objectStoreNames.contains(storeName)) {
          db.deleteObjectStore(storeName);
        }
      };
    });
  }

  /**
   * 清除所有数据（删除所有 session store）
   */
  async clearAll(): Promise<void> {
    await this.init();

    if (!this.db) throw new Error('数据库未初始化');

    const storeNames = Array.from(this.db.objectStoreNames);
    const sessionStores = storeNames.filter((name) =>
      name.startsWith(STORE_NAME_PREFIX)
    );

    // 删除所有 session store
    if (sessionStores.length === 0) {
      this.pendingRecords.clear();
      return;
    }

    // 需要在 upgrade 事务中删除 store
    // 关闭当前数据库连接
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    // 重置 initPromise，以便后续可以重新初始化
    this.initPromise = null;

    // 获取当前版本并升级
    const currentVersion = await this.getCurrentVersion();
    const newVersion = currentVersion + 1;

    return new Promise((resolve, reject) => {
      // 重新打开数据库，触发 upgrade
      const request = indexedDB.open(DB_NAME, newVersion);

      request.onerror = () => {
        this.initPromise = null; // 失败时重置，允许重试
        reject(new Error(`打开 IndexedDB 失败: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.pendingRecords.clear();
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 删除所有 session store
        sessionStores.forEach((storeName) => {
          if (db.objectStoreNames.contains(storeName)) {
            db.deleteObjectStore(storeName);
          }
        });
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

      // 确保 store 存在
      await this.ensureStore(sid);

      const storeName = getStoreName(sid);

      // 保存到数据库
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction([storeName], 'readwrite');
          const store = transaction.objectStore(storeName);

          // 保存 session 数据
          const sessionData = {
            sessionId: sid,
            sessionStartTime: session.sessionStartTime,
            sessionEndTime: session.sessionEndTime,
            records: session.records,
            metadata: session.metadata,
          };

          const putRequest = store.put(sessionData, 'session');
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
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

