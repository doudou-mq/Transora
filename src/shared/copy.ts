/**
 * 跨表面**唯一**文案源。
 *
 * 背景（审计发现）：同一个「未配置引导卡」在实现里有四套不同说法 ——
 * `guide-card.ts` / `popup/main.ts` / preview S6 / preview G12 各写各的。
 * 用户裁决 Q8-A：**文案以 docs/00 + 设计稿 S 区为准**，四处收敛为一版。
 *
 * 因此凡是被两个以上挂载点复用的文案，一律放这里，组件只做渲染。
 * 单行内联文案（例如「重试」「复制译文」）仍留在各自组件里，避免过度集中。
 *
 * 注意：**错误类型 → 文案** 的映射不在本文件，它是 docs/00 §D-1 的表格，
 * 唯一实现在 `shared/errors.ts` 的 `ERROR_MATRIX`。
 */

/** G12 / S6 未配置引导卡（挂载点：悬浮菜单 / 划词内容块 / Popup 空态 / 新标签页空态） */
export const GUIDE_COPY = {
  /** S6 主文案（16px / 600 / ink） */
  title: '还没有配置模型',
  /** S6 副文案（13px / muted） */
  desc: 'Transora 不内置模型，需要先接入一个 OpenAI 兼容服务才能开始翻译。',
  /** S6 要点 3 条（Mono 小字） */
  steps: [
    '接口地址形如 https://api.xxx.com/v1',
    '填写 API Key（仅存本地）',
    '填写模型名如 deepseek-chat',
  ],
  /** 主按钮（橙） */
  primary: '去配置模型',
  /** 次按钮（文字） */
  secondary: '查看配置指引',
  /** G12 脚注 */
  note: '数据仅存本机 · Key 不上传',
} as const

/** H2 Toast 的动作文案（三态各一个单一动作） */
export const TOAST_COPY = {
  undo: '撤销',
  cancel: '取消',
  retry: '重试',
  /** 失败态的下一步出口 */
  goSettings: '去设置',
  /** docs/00 §D-1「未配置模型」的可用动作 */
  goConfigure: '去配置',
} as const

/**
 * 「查看配置指引」的落地地址。
 *
 * S6 只写「打开帮助 / 配置说明文档」，未指名具体页面。扩展内没有独立帮助页，
 * 唯一承载「使用文档」的是**关于页**（设计稿 F6 区块，随批次 4 补齐），
 * 故此处统一指向新标签页 `#about`。若后续新增独立帮助页，只改这一个常量。
 */
export const GUIDE_DOC_HASH = 'about'
