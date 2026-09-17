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
  /** 译文块标题行（G2/G8/G9：左「{目标语言}译文」+ 右状态 / 折叠） */
  trHead: 'transora-tr-head',
  /** 标题行左侧语言标签 */
  trHeadLabel: 'transora-tr-head-label',
  /** 标题行右侧状态（「翻译中…」） */
  trHeadState: 'transora-tr-head-state',
  /** 加载骨架容器（G8：3 条灰条） */
  trSkeleton: 'transora-tr-skeleton',
  /** 失败态的重试入口（G9 标题行右侧） */
  trRetry: 'transora-tr-retry',
  /** 译文块折叠态 */
  folded: 'transora-tr--folded',
  /** 被翻译的原文块（兄弟插入场景） */
  src: 'transora-src',
  /** 被翻译的原文块（父级为 flex/grid，译文内嵌场景） */
  srcInline: 'transora-src-inline',
  /** 引用块（用于侧边栏定位时高亮） */
  highlight: 'transora-highlight',
  /** G7 页面顶部状态栏（Sticky） */
  st: 'transora-st',
  /** 状态栏左侧「译」章 */
  stMark: 'transora-st-mark',
  /** 状态栏左侧状态文案「双语对照已开启」 */
  stTitle: 'transora-st-title',
  /** 状态栏左侧域名 */
  stHost: 'transora-st-host',
  /** 状态栏右侧「42 / 56 段」 */
  stCount: 'transora-st-count',
  /** 状态栏进度条（4px） */
  stBar: 'transora-st-bar',
  /** 状态栏三态切换容器 */
  stModes: 'transora-st-modes',
  /** 状态栏三态切换单个药丸 */
  stMode: 'transora-st-mode',
  /** 状态栏目标语言下拉 */
  stLang: 'transora-st-lang',
  /** 状态栏退出入口 */
  stExit: 'transora-st-exit',
} as const

/** 对照三态：挂在 documentElement 上的 class */
export const MODE_CLASS = {
  bilingual: 'transora-mode-bilingual',
  'original-only': 'transora-mode-original',
  'translation-only': 'transora-mode-translation',
} as const

/** 层级体系：全部压在宿主页面之上，且内部保持有序 */
export const Z = {
  /**
   * G7 状态栏是**页面级**信息条，只做展示 + 轻交互。
   * 刻意压在 FAB / 侧边栏之下：侧边栏从右侧贴边滑出时会盖住状态栏右端，
   * 这是可接受的（状态栏的入口都能在侧边栏/菜单里找到），反之则会挡住侧边栏头部。
   */
  statusbar: 2147482900,
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
  offset: 18,
  menuWidth: 224,
} as const

/** 侧边栏宽度（设计稿 G11） */
export const SIDEBAR_WIDTH = 400

/**
 * G7 页面顶部状态栏几何。
 * 设计稿给的是「56 高卡片 + 圆角 10」，但没写贴边距离；
 * 这里取 12px 上边距并沿用 FAB 的 18px 左右安全边，让两个注入层观感一致。
 */
export const STATUS_BAR = {
  height: 56,
  insetX: 18,
  insetY: 12,
  /** 进度条：设计稿 90×4 */
  barWidth: 90,
} as const

/**
 * 划词跟随图标（G4）与划词内容块（G5）的几何 / 节奏。
 * 取值口径 = 设计稿交互规范 S5（docs/00 §A1、§D-4 已冻结），不是 G4/G5 视觉稿的像素。
 */
export const SELECTION = {
  /** 跟随图标 24×24、圆角 8px，橙底 + 白色「译」字（S5） */
  iconSize: 24,
  iconRadius: 8,
  /** 图标落在选区末端外扩 8px 处（S5 位置） */
  offset: 8,
  /** 选中长度 ≥ 2（按码点计，CJK 也按 1 个字算）才出现图标（S5 触发条件） */
  minChars: 2,
  /** 悬停图标 ≥120ms 展开内容块；移出 250ms 收起（与 S4 菜单同一节奏） */
  hoverOpenDelayMs: 120,
  hoverCloseDelayMs: 250,
  /**
   * 内容块宽度：S5 规格文本写 340px，G5 视觉稿画 470px —— 设计稿自相矛盾。
   * 用户裁决 Q5-C：保持实现现状 360px（两侧都能读，不重排）。
   */
  cardWidth: 360,
} as const

/**
 * H2 Toast 几何与节奏。
 * 「固定底部居中，宽 300–360；深墨底 + 橙色单动作。
 *  成功 / 进行中 3s 自动消失，失败常驻 6s 并可手动关闭。」
 */
export const TOAST = {
  minWidth: 300,
  maxWidth: 360,
  /** 成功 / 进行中自动消失时长 */
  durationMs: 3000,
  /** 失败常驻时长（到点也会消失，只是给用户留出操作时间） */
  persistentMs: 6000,
  /** 同一批次只报一次 Toast 的冷却窗口（docs/00 §D-1 统一规则） */
  cooldownMs: 1200,
} as const

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
