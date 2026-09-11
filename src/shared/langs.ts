/**
 * 语言清单 —— 口径见 docs/00 §A4（目标语言固定 9 种）与 §A5（源语言默认英语、不自动检测）。
 *
 * ⚠️ 接口约定：注入 prompt 时使用**显示名全称**（如「简体中文」），不使用 ISO 码。
 *    ISO 码只用于本地存储与 UI 取值。
 */

export interface LangOption {
  value: string
  label: string
}

/** 目标语言：固定精编 9 种，不做自由输入（A4） */
export const TARGET_LANGS: readonly LangOption[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'es', label: '西班牙语' },
  { value: 'ru', label: '俄语' },
] as const

/** 源语言：多一个「自动」，默认选中的是「英语」而不是「自动」（A5） */
export const SOURCE_LANGS: readonly LangOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'en', label: '英语' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'es', label: '西班牙语' },
  { value: 'ru', label: '俄语' },
] as const

export const DEFAULT_TARGET_LANG = 'zh-CN'
export const DEFAULT_SOURCE_LANG = 'en'

/** ISO 值 → 显示名全称；找不到时原样返回（用于 prompt 注入） */
export function langDisplayName(value: string): string {
  const hit = [...TARGET_LANGS, ...SOURCE_LANGS].find((l) => l.value === value)
  return hit ? hit.label : value
}

/** 源语言是否为「具体语言」（决定 prompt 是否明写源语言） */
export function isExplicitSource(value: string): boolean {
  return value !== 'auto' && value !== ''
}

/** 取选项文案，找不到时回退为 value */
export function langLabel(list: readonly LangOption[], value: string): string {
  return list.find((l) => l.value === value)?.label ?? value
}
