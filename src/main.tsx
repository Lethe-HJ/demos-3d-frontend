/// <reference types="vite/client" />

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 声明全局 __DEV__ 类型（由 vite.config.ts 中的 define 配置提供）
declare const __DEV__: boolean

// 在应用启动时清空所有 IndexedDB 数据库
const clearAllIndexedDB = async () => {
  try {
    // 尝试使用 indexedDB.databases() 列出所有数据库（需要浏览器支持）
    if ('databases' in indexedDB) {
      interface DatabaseInfo {
        name: string
        version: number
      }
      const databases = await (indexedDB.databases as () => Promise<DatabaseInfo[]>)()
      console.log(`[IndexedDB] 找到 ${databases.length} 个数据库，开始清空...`)
      
      // 对每个数据库，删除其所有 object store 的内容
      for (const dbInfo of databases) {
        try {
          const dbName = dbInfo.name
          const dbVersion = dbInfo.version
          
          // 打开数据库
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, dbVersion)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result)
          })
          
          // 清空所有 object store
          const storeNames = Array.from(db.objectStoreNames)
          for (const storeName of storeNames) {
            const transaction = db.transaction([storeName], 'readwrite')
            const store = transaction.objectStore(storeName)
            await new Promise<void>((resolve, reject) => {
              const request = store.clear()
              request.onsuccess = () => resolve()
              request.onerror = () => reject(request.error)
            })
          }
          
          db.close()
          console.log(`[IndexedDB] 已清空数据库: ${dbName}`)
        } catch (error) {
          console.error(`[IndexedDB] 清空数据库失败:`, error)
        }
      }
      
      console.log('[IndexedDB] 所有数据库已清空')
    } else {
      // 如果不支持 databases() API，则清空已知的数据库
      console.warn('[IndexedDB] 浏览器不支持 databases() API，清空已知的数据库')
      
      const knownDatabases = [
        { name: 'performance-trace-db', version: 1 },
        { name: 'voxel-grid-cache', version: 2 }
      ]
      
      for (const dbInfo of knownDatabases) {
        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbInfo.name, dbInfo.version)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result)
          })
          
          const storeNames = Array.from(db.objectStoreNames)
          for (const storeName of storeNames) {
            const transaction = db.transaction([storeName], 'readwrite')
            const store = transaction.objectStore(storeName)
            await new Promise<void>((resolve, reject) => {
              const request = store.clear()
              request.onsuccess = () => resolve()
              request.onerror = () => reject(request.error)
            })
          }
          
          db.close()
          console.log(`[IndexedDB] 已清空数据库: ${dbInfo.name}`)
        } catch (error) {
          console.error(`[IndexedDB] 清空数据库 ${dbInfo.name} 失败:`, error)
        }
      }
    }
  } catch (error) {
    console.error('[IndexedDB] 清空所有数据库失败:', error)
  }
}

// 在渲染应用前清空所有 IndexedDB（仅在开发环境）
// 使用 __DEV__ 或 import.meta.env.DEV 都可以，两者都支持分支编译
// 生产构建时，这个 if 块会被完全移除（dead code elimination）
if (__DEV__) {
  await clearAllIndexedDB()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
