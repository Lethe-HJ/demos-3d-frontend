/**
 * IndexedDB 工具类，用于管理 chunk 数据缓存
 * 
 * 存储结构：
 * - store: 'chunks'
 * - key: `${taskId}_${chunkIndex}`
 * - value: { buffer: ArrayBuffer, min: number, max: number, timestamp: number }
 */

const DB_NAME = 'voxel-grid-cache';
const DB_VERSION = 2; // 升级版本：索引从 taskId 改为 file
const STORE_NAME = 'chunks';

interface ChunkCache {
  buffer: ArrayBuffer;
  min: number;
  max: number;
  timestamp: number;
}

class IndexedDBManager {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<IDBDatabase> | null = null;

  /**
   * 初始化数据库
   */
  private async init(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error('打开 IndexedDB 失败'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建 object store
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          // 创建索引用于查询
          store.createIndex('file', 'file', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * 生成缓存键
   * 使用 file + chunk_size + chunkIndex 作为键，而不是 task_id
   * 因为相同文件和 chunk_size 的数据是相同的，不管 task_id 是什么
   */
  private getCacheKey(file: string, chunkSize: number, chunkIndex: number): string {
    return `${file}_${chunkSize}_${chunkIndex}`;
  }

  /**
   * 获取缓存的 chunk
   */
  async getChunk(file: string, chunkSize: number, chunkIndex: number): Promise<ChunkCache | null> {
    try {
      const db = await this.init();
      const cacheKey = this.getCacheKey(file, chunkSize, chunkIndex);

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(cacheKey);

        request.onsuccess = () => {
          const result = request.result;
          if (result) {
            resolve({
              buffer: result.buffer,
              min: result.min,
              max: result.max,
              timestamp: result.timestamp,
            });
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          reject(new Error('读取缓存失败'));
        };
      });
    } catch (error) {
      console.error('[IndexedDB] 获取缓存失败:', error);
      return null;
    }
  }

  /**
   * 保存 chunk 到缓存
   */
  async saveChunk(
    file: string,
    chunkSize: number,
    chunkIndex: number,
    buffer: ArrayBuffer,
    min: number,
    max: number
  ): Promise<void> {
    try {
      const db = await this.init();
      const cacheKey = this.getCacheKey(file, chunkSize, chunkIndex);

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const data = {
          key: cacheKey,
          file,
          chunkSize,
          chunkIndex,
          buffer,
          min,
          max,
          timestamp: Date.now(),
        };

        const request = store.put(data);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          reject(new Error('保存缓存失败'));
        };
      });
    } catch (error) {
      console.error('[IndexedDB] 保存缓存失败:', error);
    }
  }

  /**
   * 删除指定文件的所有 chunk 缓存
   */
  async deleteFileChunks(file: string): Promise<void> {
    try {
      const db = await this.init();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('file');
        const request = index.openCursor(IDBKeyRange.only(file));

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };

        request.onerror = () => {
          reject(new Error('删除缓存失败'));
        };
      });
    } catch (error) {
      console.error('[IndexedDB] 删除缓存失败:', error);
    }
  }

  /**
   * 清理过期缓存（可选的清理功能）
   */
  async clearExpiredCache(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    // maxAge 默认 7 天
    try {
      const db = await this.init();
      const cutoffTime = Date.now() - maxAge;
      let deletedCount = 0;

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('timestamp');
        const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            cursor.delete();
            deletedCount++;
            cursor.continue();
          } else {
            resolve(deletedCount);
          }
        };

        request.onerror = () => {
          reject(new Error('清理缓存失败'));
        };
      });
    } catch (error) {
      console.error('[IndexedDB] 清理缓存失败:', error);
      return 0;
    }
  }

  /**
   * 清除所有缓存数据
   */
  async clearAll(): Promise<void> {
    try {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => {
          reject(new Error(`清除所有缓存失败: ${request.error}`));
        };
      });
    } catch (error) {
      console.error('[IndexedDB] 清除所有缓存失败:', error);
      throw error;
    }
  }
}

// 导出单例
export const indexedDBManager = new IndexedDBManager();

