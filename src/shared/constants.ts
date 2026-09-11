/**
 * 全局常量 —— 取值口径全部来自 docs/00-确认方案.md，改这里等于改口径，务必回写文档。
 */

/** 产品版本（对应 manifest.version，见 docs/00 §C3）。设计稿版本是另一回事，勿混用。 */
export const PRODUCT_VERSION = '0.1.0'

/** 注入宿主页面的所有 class / 属性统一前缀 */
export const NS = 'transora'

/** 注入 DOM 使用的 class 名 */
export const CLS = {
  /** 译文块本体（兄弟插入） */
  tr: 'transora-tr',
  /** 译文正文容器 */
  trBody: 'transora-tr-body',
  /** 折叠按钮 */
  trFold: 'transora-tr-fold',
  /** 译文块折叠态 */
  folded: 'transora-tr--folded',
  /** 被翻译的原文块（兄弟插入场景） */
  src: 'transora-src',
  /** 被翻译的原文块（父级为 flex/grid，译文内嵌场景） */
  srcInline: 'transora-src-inline',
  /** 引用块（用于侧边栏定位时高亮） */
  highlight: 'transora-highlight',
} as const

/** 对照三态：挂在 documentElement 上的 class */
export const MODE_CLASS = {
  bilingual: 'transora-mode-bilingual',
  'original-only': 'transora-mode-original',
  'translation-only': 'transora-mode-translation',
} as const

/** 层级体系：全部压在宿主页面之上，且内部保持有序 */
export const Z = {
  fab: 2147483000,
  fabMenu: 2147483001,
  /** 侧边栏是常驻面板，但在划词交互之下 —— 否则侧边栏打开时划词入口会被盖住点不动 */
  sidebar: 2147483100,
  selectionIcon: 2147483200,
  selectionCard: 2147483201,
  toast: 2147483300,
} as const

/** 批次切分（docs/00 §D-2）：先到者为准 */
export const BATCH = {
  MAX_BLOCKS: 40,
  MAX_CHARS: 2000,
} as const

/** 并发上限（docs/00 §D-2）：全文 3，划词 1 */
export const CONCURRENCY = {
  FULL_PAGE: 3,
  SELECTION: 1,
} as const

/** 单请求超时 60s */
export const REQUEST_TIMEOUT_MS = 60_000

/** 失败重试：2 次 + 指数退避 1s → 2s → 4s（docs/00 §D-2，S13） */
export const RETRY = {
  MAX: 2,
  BASE_DELAY_MS: 1000,
  FACTOR: 2,
} as const

/** 历史保留上限（S11） */
export const HISTORY_LIMIT = 1000

/** 全文对比模型上限（S5） */
export const MAX_COMPARE_MODELS = 3

/** 翻译缓存条目上限（本地 LRU 式淘汰） */
export const CACHE_MAX_ENTRIES = 4000

/** 单个块的可翻译文本上限，超出则截断（防超长块撑爆单批） */
export const BLOCK_MAX_CHARS = 4000

/** 低于此长度的块不翻译 */
export const MIN_BLOCK_CHARS = 2

/** 存储键 */
export const STORAGE_KEYS = {
  models: 'transora:models',
  settings: 'transora:settings',
  cache: 'transora:cache',
} as const

/** 悬浮按钮尺寸（设计稿 G10） */
export const FAB = {
  size: 40,
  offset: 16,
  menuWidth: 224,
} as const

/** 侧边栏宽度（设计稿 G11） */
export const SIDEBAR_WIDTH = 400

/** MutationObserver 防抖（docs/00 §G-3 风险 4） */
export const MUTATION_DEBOUNCE_MS = 300

/** 可翻译的块级元素（docs/04 §5.1） */
export const TRANSLATABLE_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dt,dd,figcaption,caption,summary'

/** 明确跳过的容器选择器（docs/03 FR-01 边界） */
export const SKIP_ANCESTOR_SELECTOR = [
  'pre',
  'code',
  'kbd',
  'samp',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'textarea',
  'input',
  'select',
  'option',
  'canvas',
  'iframe',
  '[contenteditable="true"]',
  `[data-${NS}]`,
].join(',')
