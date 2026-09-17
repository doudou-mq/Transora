/**
 * 存储封装。统一走 chrome.storage.local（D4：历史之外的配置与缓存均本地）。
 *
 * 所有读取都带默认值兜底，避免「首次安装 / 用户清空存储」时拿到 undefined。
 */

import { CACHE_MAX_ENTRIES, HISTORY_LIMIT, MAX_COMPARE_MODELS, STORAGE_KEYS } from './constants'
import { DEFAULT_SOURCE_LANG, DEFAULT_TARGET_LANG } from './langs'
import type { ModelConfig, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  targetLang: DEFAULT_TARGET_LANG,
  sourceLang: DEFAULT_SOURCE_LANG,
  displayMode: 'bilingual',
  cacheEnabled: true,
  autoRetry: true,
  historyLimit: HISTORY_LIMIT,
  maxModelsForCompare: MAX_COMPARE_MODELS,
  lastModelId: null,
  fabHidden: false,
}

function getArea(): chrome.storage.LocalStorageArea {
  return chrome.storage.local
}

async function readKey<T>(key: string): Promise<T | undefined> {
  const result = await getArea().get(key)
  return result[key] as T | undefined
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await getArea().set({ [key]: value })
}

/** 读取设置，与默认值做一层合并 */
export async function getSettings(): Promise<Settings> {
  const raw = (await readKey<Partial<Settings>>(STORAGE_KEYS.settings)) ?? {}
  return { ...DEFAULT_SETTINGS, ...raw }
}

/** 局部更新设置，返回更新后的完整设置 */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await writeKey(STORAGE_KEYS.settings, next)
  return next
}

/**
 * E5 页首「恢复默认」：把设置整体写回 `DEFAULT_SETTINGS`。
 *
 * 只重置**设置**，不动模型配置与翻译缓存 —— 模型是用户填了 Key 的资产，
 * 一个「恢复默认值」按钮不该把它清掉。
 */
export async function resetSettings(): Promise<Settings> {
  const next = { ...DEFAULT_SETTINGS }
  await writeKey(STORAGE_KEYS.settings, next)
  return next
}

export async function getModels(): Promise<ModelConfig[]> {
  return (await readKey<ModelConfig[]>(STORAGE_KEYS.models)) ?? []
}

export async function saveModels(models: ModelConfig[]): Promise<void> {
  await writeKey(STORAGE_KEYS.models, models)
}

/** 启用中的模型（翻译链路的实际可选集） */
export async function getEnabledModels(): Promise<ModelConfig[]> {
  return (await getModels()).filter((m) => m.enabled)
}

/** 取「当前应当使用的模型」：上次选择 → 首个启用项 */
export async function resolveActiveModel(preferredId?: string | null): Promise<ModelConfig | null> {
  const enabled = await getEnabledModels()
  if (enabled.length === 0) return null
  const settings = await getSettings()
  const targetId = preferredId ?? settings.lastModelId
  return enabled.find((m) => m.id === targetId) ?? enabled[0]
}

export async function getModelById(id: string): Promise<ModelConfig | null> {
  const models = await getModels()
  return models.find((m) => m.id === id) ?? null
}

/** 监听存储变化（content script 需要跟随设置实时更新） */
export function onStorageChanged(
  keys: string[],
  callback: (changes: Record<string, chrome.storage.StorageChange>) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return
    const hit = Object.keys(changes).some((k) => keys.includes(k))
    if (hit) callback(changes)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

/* ------------------------------------------------------------------ */
/* 翻译缓存（S12：开关式，同文本不重复请求）                              */
/* ------------------------------------------------------------------ */

export type TranslationCache = Record<string, string>

export async function getCache(): Promise<TranslationCache> {
  return (await readKey<TranslationCache>(STORAGE_KEYS.cache)) ?? {}
}

export async function writeCacheEntry(key: string, value: string): Promise<void> {
  const cache = await getCache()
  cache[key] = value

  // 简易容量控制：超出上限时按插入顺序丢弃最早的键
  const keys = Object.keys(cache)
  if (keys.length > CACHE_MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) {
      delete cache[stale]
    }
  }
  await writeKey(STORAGE_KEYS.cache, cache)
}

export async function clearCache(): Promise<void> {
  await writeKey(STORAGE_KEYS.cache, {})
}

/* ------------------------------------------------------------------ */
/* 打开「新标签页」（扩展独立页）                                        */
/* ------------------------------------------------------------------ */

/**
 * 打开扩展独立页并定位到指定区块。
 *
 * 用 manifest 里的 options_page 反查真实路径 —— 构建后路径会变（src/pages/index.html → pages/index.html），
 * 写死路径在 dev / build 之间会失效。
 */
export function openAppPage(hash?: string): void {
  const declared = chrome.runtime.getManifest().options_page
  const path = declared || 'src/pages/index.html'
  const url = chrome.runtime.getURL(path) + (hash ? `#${hash.replace(/^#/, '')}` : '')
  void chrome.tabs.create({ url })
}
