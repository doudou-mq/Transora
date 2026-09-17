/**
 * 多模型对比（FR-09 / FR-10）的**纯逻辑**。
 *
 * 这里只放可单测的函数；真正的调度（发请求 / 回填 / 取消）在 `content/translator.ts`，
 * UI 在 `content/ui/sidebar.ts`，状态形状在 `content/state.ts`。
 *
 * 口径来源：
 *  - 落点与形态：docs/00 §A1 / §A2（对比 = 全文 + 侧边栏，划词不含）
 *  - 「应用」语义：docs/00 §D-3（换显，不重新请求）
 *  - 模型上限：docs/00 §B 表 Q5（3 个，超出置灰并提示）
 *  - 并发上限：docs/00 §D-2（全局 3，不是每模型 3）
 */

/** 单列（一个模型）在一次对比中的状态 */
export type CompareColumnStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed'

/** 列状态 → 界面文案（列头 / 顶部模型条共用） */
export const COMPARE_STATUS_LABEL: Record<CompareColumnStatus, string> = {
  queued: '排队中',
  running: '翻译中',
  done: '已完成',
  partial: '部分失败',
  failed: '失败',
}

export interface CompareTask {
  /** 在本次对比的模型列表里的下标 */
  modelIndex: number
  /** 批次下标（所有模型共用同一份切分，见 planCompareTasks 注释） */
  batchIndex: number
}

/**
 * 生成对比任务队列：**按批次轮转**（batch 0 的 N 个模型 → batch 1 的 N 个模型 …）。
 *
 * 为什么不按模型串行：并发槽是**全局 3 个**（docs/00 §D-2），若把 A 模型的所有批次排前面，
 * 用户会看到 A 列先跑完、B/C 列一直空着 —— 那就不叫「并排」了。
 * 轮转后各列同时开始填充，且首屏块（batch 0）优先拿槽（切分前已按首屏优先排序，§D-2）。
 */
export function planCompareTasks(modelCount: number, batchCount: number): CompareTask[] {
  const tasks: CompareTask[] = []
  if (modelCount <= 0 || batchCount <= 0) return tasks

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) {
      tasks.push({ modelIndex, batchIndex })
    }
  }
  return tasks
}

/**
 * 列状态判定：未跑完是 queued / running；跑完后按失败数分 done / partial / failed。
 * 「跑完」的判据是 `done >= total` —— 失败块也算 done，否则失败列会永远停在「翻译中」。
 */
export function columnStatusOf(done: number, total: number, failed: number): CompareColumnStatus {
  if (done < total) return done === 0 ? 'queued' : 'running'
  if (failed <= 0) return 'done'
  return failed >= total ? 'failed' : 'partial'
}

/**
 * 列头元信息（G6 图例：`0.8s · 128 tok`）。
 *
 * 全部命中缓存时耗时与 token 都是 0，此时显示「命中缓存」而不是「0.0s · 0 tok」——
 * 后者会让人误以为请求失败了。既没耗时也没有缓存命中（例如整列在发出前就被取消）显示 `—`。
 */
export function formatColumnMeta(
  latencyMs: number,
  totalTokens: number,
  cacheHits: number,
): string {
  if (latencyMs <= 0 && totalTokens <= 0) return cacheHits > 0 ? '命中缓存' : '—'
  return `${(latencyMs / 1000).toFixed(1)}s · ${totalTokens} tok`
}

/** 所有列都失败（收尾 Toast 据此区分「部分失败」与「全部失败」） */
export function isAllFailed(columns: readonly { status: CompareColumnStatus }[]): boolean {
  return columns.length > 0 && columns.every((column) => column.status === 'failed')
}

/** 是否有任意列失败（决定 Toast 的类型：成功 / 失败） */
export function hasAnyFailure(columns: readonly { status: CompareColumnStatus }[]): boolean {
  return columns.some((column) => column.status === 'partial' || column.status === 'failed')
}
