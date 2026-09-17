/**
 * 全局类型定义。
 * 数据模型与 docs/04 §七 一一对应；消息协议与 docs/04 §八 对应（本实现做了少量命名收敛，见 messages.ts 注释）。
 */

/** 对照三态（FR-16） */
export type DisplayMode = 'bilingual' | 'original-only' | 'translation-only'

/** 翻译来源类型 */
export type TranslateType = 'selection' | 'fullpage' | 'dynamic'

/** 模型配置（docs/04 §7.1） */
export interface ModelConfig {
  id: string
  name: string
  /** 固定为 openai-compatible，保留扩展点（D3 / NFR-07） */
  provider: 'openai-compatible'
  /** 接口地址，支持 `https://api.x.com/v1` 或直接给到 `/chat/completions` */
  endpoint: string
  apiKey: string
  model: string
  /**
   * 该模型的默认目标语言（设计稿 E2 表单第 5 个字段）。
   *
   * 留空 = **跟随全局设置**（通用设置里的「默认目标语言」）。
   * 这样 E2 表单能对齐设计稿的 7 字段，又不会和全局设置互相打架 ——
   * docs/00 §A4 冻结的「目标语言由用户选、固定 9 种」仍然成立，这里只是一个可选覆盖。
   */
  targetLang?: string
  temperature: number
  maxTokens: number
  enabled: boolean
}

/** 全局设置（docs/04 §7.3） */
export interface Settings {
  /** 默认目标语言（A4：固定 9 种，默认 zh-CN） */
  targetLang: string
  /** 默认源语言（A5：默认 en，不自动检测；'auto' 表示交给模型判定） */
  sourceLang: string
  /** 全文翻译的对照显示模式 */
  displayMode: DisplayMode
  /** 翻译缓存开关（S12，默认开） */
  cacheEnabled: boolean
  /** 失败自动重试开关（E5 / S13：单批失败固定重试 2 次 + 指数退避，默认开） */
  autoRetry: boolean
  /** 历史上限（S11） */
  historyLimit: number
  /** 全文对比模型上限（S5） */
  maxModelsForCompare: number
  /** Popup / 悬浮菜单里上次选中的模型 */
  lastModelId: string | null
  /** 悬浮按钮是否被用户隐藏（X1：可隐藏） */
  fabHidden: boolean
}

/** 翻译历史（docs/04 §7.2） */
export interface HistoryItem {
  id?: number
  modelId: string
  modelName: string
  sourceText: string
  translatedText: string | null
  error: string | null
  type: TranslateType
  pageUrl: string
  sourceLang: string
  targetLang: string
  timestamp: number
  latencyMs?: number
  totalTokens?: number
}

/** 错误分类（docs/00 §D-1） */
export type ErrorKind =
  | 'no-model'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'refused'
  | 'canceled'
  | 'invalid-config'
  | 'unknown'

/** 错误可提供的动作按钮 */
export type ErrorAction = 'configure' | 'retry' | 'topup' | 'check-config' | 'copy-source'

/** 结构化错误信息，直接驱动 UI 渲染 */
export interface ErrorInfo {
  kind: ErrorKind
  message: string
  actions: ErrorAction[]
  retryable: boolean
}

/** 单条待翻译文本 */
export interface Segment {
  id: number
  text: string
}

/** LLM 调用返回 */
export interface ChatResult {
  content: string
  latencyMs: number
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}
