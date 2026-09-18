/**
 * 翻译历史的存储层 —— **扩展源 IndexedDB**（docs/00 §D-4 / docs/04 §7.2）。
 *
 * 三条容易踩空的点，写在这里免得后面又踩：
 *
 * 1. **为什么必须落在这里，不能落在内容脚本里**：内容脚本跑在**宿主页面的源**上，
 *    它开的 IndexedDB 属于那个网站，不是扩展的 —— 换一个站点就读不到了。
 *    所以内容脚本只负责「把这次翻译报上来」，真正落库由 Background 完成（见 background/index.ts）。
 *
 * 2. **不要在事务里 `await` 一个「跨任务」的 Promise**：IndexedDB 事务在事件循环让出到宏任务时会自动提交，
 *    之后再操作同一个事务就报 TransactionInactiveError。这里的写法是「只 await 请求本身，
 *    事务让它自己提交」，下一个动作一律开新事务。
 *
 * 3. **超限剪裁复用纯函数 `pruneIds`**，不在这里再写一套「谁该被删」的判断 ——
 *    那套口径已经有单测钉着，两处各写一份迟早会不一致。
 */

import { pruneIds } from './history'
import type { HistoryItem } from './types'

export const HISTORY_DB_NAME = 'transora-history'
export const HISTORY_STORE = 'records'
const DB_VERSION = 1

let cached: Promise<IDBDatabase> | null = null

/** 打开（并按需建表）数据库。连接缓存起来，被浏览器强制关掉时自动重建。 */
export function openHistoryDb(): Promise<IDBDatabase> {
  if (cached) return cached

  cached = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(HISTORY_DB_NAME, DB_VERSION)
    } catch (err) {
      cached = null
      reject(err)
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(HISTORY_STORE)) return
      const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id', autoIncrement: true })
      // 索引与 docs/04 §7.2 冻结口径一致
      store.createIndex('timestamp', 'timestamp')
      store.createIndex('modelName', 'modelName')
      store.createIndex('type', 'type')
    }

    request.onsuccess = () => {
      const db = request.result
      // 版本升级、存储被清理、配额回收都会把这个连接关掉 —— 清缓存，下次重开
      db.onclose = () => {
        cached = null
      }
      db.onversionchange = () => {
        db.close()
        cached = null
      }
      resolve(db)
    }

    request.onerror = () => {
      cached = null
      reject(request.error ?? new Error('无法打开翻译历史数据库'))
    }
  })

  return cached
}

/** 只 await 请求本身，事务自己提交（见文件头第 2 点） */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

async function countIn(db: IDBDatabase): Promise<number> {
  return requestResult(db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).count())
}

/** 全部记录，**按时间倒序**（索引游标直接倒着走，不需要读出来再排） */
export async function queryAll(): Promise<HistoryItem[]> {
  const db = await openHistoryDb()
  return new Promise<HistoryItem[]>((resolve, reject) => {
    const out: HistoryItem[] = []
    const request = db
      .transaction(HISTORY_STORE, 'readonly')
      .objectStore(HISTORY_STORE)
      .index('timestamp')
      .openCursor(null, 'prev')

    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(out)
        return
      }
      out.push(cursor.value as HistoryItem)
      cursor.continue()
    }
    request.onerror = () => reject(request.error ?? new Error('读取翻译历史失败'))
  })
}

export async function count(): Promise<number> {
  return countIn(await openHistoryDb())
}

/**
 * 写入一条并顺手剪裁。
 * @param item  内容脚本报上来的记录（`id` 由 IndexedDB 自增分配，忽略传入值）
 * @param limit 上限（取 `settings.historyLimit`）
 * @returns 落库后的记录（带真实 id）
 */
export async function addRecord(
  item: HistoryItem,
  limit: number,
): Promise<HistoryItem & { id: number }> {
  const db = await openHistoryDb()

  const record: HistoryItem = { ...item }
  delete record.id

  const id = await requestResult(
    db.transaction(HISTORY_STORE, 'readwrite').objectStore(HISTORY_STORE).add(record),
  )

  await pruneToLimit(limit)
  return { ...record, id: Number(id) }
}

/**
 * 剪裁到上限（S11：超出自动清理**最早**的记录）。
 * 未超限时连读都不读 —— 上限内是常态，没必要每次写入都全表扫一遍。
 */
export async function pruneToLimit(limit: number): Promise<number[]> {
  const db = await openHistoryDb()
  const total = await countIn(db)
  if (total <= limit) return []

  const stale = pruneIds(await queryAll(), limit)
  if (stale.length > 0) await deleteRecords(stale)
  return stale
}

export async function deleteRecord(id: number): Promise<void> {
  const db = await openHistoryDb()
  await requestResult(
    db.transaction(HISTORY_STORE, 'readwrite').objectStore(HISTORY_STORE).delete(id),
  )
}

/** 批量删除（一个事务里发多条 delete，比逐条开事务快得多） */
export async function deleteRecords(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const db = await openHistoryDb()
  const store = db.transaction(HISTORY_STORE, 'readwrite').objectStore(HISTORY_STORE)
  await Promise.all(ids.map((id) => requestResult(store.delete(id))))
}

/** F4「确认清空」 */
export async function clearAll(): Promise<void> {
  const db = await openHistoryDb()
  await requestResult(db.transaction(HISTORY_STORE, 'readwrite').objectStore(HISTORY_STORE).clear())
}

/** 关闭连接（测试与「清空后释放」用；正常流程不需要） */
export async function closeHistoryDb(): Promise<void> {
  if (!cached) return
  const db = await cached.catch(() => null)
  cached = null
  db?.close()
}
