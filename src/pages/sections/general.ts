/**
 * 区块二：通用设置（E5 / FR-16 / FR-17，A4 / A5 / S9 / S10 / S11 / S12 / S13）
 *
 * 对齐设计稿 E5 的 6 行（默认目标语言 / 默认显示模式 / 全文对比上限 / 历史保留上限 /
 * 翻译缓存 / 失败自动重试）+ 页首「恢复默认」；另外保留设计稿没画但 docs/00 §A5
 * 明确要求的「源语言」一行（Q6-A 已把源语言下拉从划词内容块移除，这里成了唯一入口）。
 */

import { MAX_COMPARE_MODELS } from '@/shared/constants'
import { SOURCE_LANGS, TARGET_LANGS, isExplicitSource } from '@/shared/langs'
import { clearCache } from '@/shared/storage'
import type { DisplayMode } from '@/shared/types'
import { el, getContext, patchSettings, resetSettings } from '../store'

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'setting-row')
  const left = el('div', 'setting-left')
  left.appendChild(el('div', 'setting-label', label))
  if (hint) left.appendChild(el('div', 'setting-hint', hint))
  wrap.appendChild(left)
  wrap.appendChild(control)
  return wrap
}

function selectControl(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const node = el('select', 'tr-select setting-select')
  for (const option of options) {
    const opt = document.createElement('option')
    opt.value = option.value
    opt.textContent = option.label
    if (option.value === value) opt.selected = true
    node.appendChild(opt)
  }
  node.addEventListener('change', () => onChange(node.value))
  return node
}

function toggleControl(checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const wrap = el('label', 'switch')
  const input = el('input', 'switch-input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  wrap.appendChild(input)
  wrap.appendChild(el('span', 'switch-track'))
  return wrap
}

/** B7：默认显示模式从分段控件改为下拉（设计稿 E5 是 `双语对照 ▾`） */
function displayModeSelect(
  value: DisplayMode,
  onChange: (value: DisplayMode) => void,
): HTMLElement {
  return selectControl(
    [
      { value: 'bilingual', label: '双语对照' },
      { value: 'translation-only', label: '仅译文' },
      { value: 'original-only', label: '仅原文' },
    ],
    value,
    (next) => onChange(next as DisplayMode),
  )
}

export function renderGeneral(): HTMLElement {
  const container = el('div', 'section')

  /** 任一设置变更后整体重绘（设置项少，重绘比增量更新更不易出错） */
  const redraw = (): void => {
    container.replaceChildren(...buildAll())
  }

  const buildAll = (): HTMLElement[] => {
    const { settings } = getContext()
    const nodes: HTMLElement[] = []

    /* ---------- 页首动作：恢复默认（E5） ---------- */
    const actions = el('div', 'section-actions')
    const reset = el('button', 'tr-btn tr-btn--primary', '恢复默认')
    reset.type = 'button'
    reset.title = '把全部设置恢复为出厂默认；不会动模型配置与翻译缓存'
    reset.addEventListener('click', () => {
      void resetSettings().then(() => {
        reset.textContent = '已恢复默认'
        redraw()
        window.setTimeout(() => {
          if (reset.isConnected) reset.textContent = '恢复默认'
        }, 1500)
      })
    })
    actions.appendChild(reset)
    nodes.push(actions)

    /* ---------- 翻译相关 ---------- */
    const main = el('div', 'tr-card settings-card')

    main.appendChild(
      row(
        '默认目标语言',
        selectControl(
          TARGET_LANGS.map((l) => ({ value: l.value, label: l.label })),
          settings.targetLang,
          (value) => {
            void patchSettings({ targetLang: value }).then(redraw)
          },
        ),
        '固定 9 种。翻译时按「显示名全称」下发给模型，指令遵循更稳。',
      ),
    )

    main.appendChild(
      row(
        '源语言',
        selectControl(
          SOURCE_LANGS.map((l) => ({ value: l.value, label: l.label })),
          settings.sourceLang,
          (value) => {
            void patchSettings({ sourceLang: value }).then(redraw)
          },
        ),
        '默认英语，不做自动检测。选「自动」则由模型自行判定源语言。',
      ),
    )

    main.appendChild(
      row(
        '默认显示模式',
        displayModeSelect(settings.displayMode, (value) => {
          void patchSettings({ displayMode: value }).then(redraw)
        }),
        '整页翻译完成后的初始展示方式。切换即时生效，不会重新请求翻译。',
      ),
    )

    main.appendChild(
      row(
        '翻译缓存',
        toggleControl(settings.cacheEnabled, (checked) => {
          void patchSettings({ cacheEnabled: checked }).then(redraw)
        }),
        '相同文本不重复请求，可显著降低 token 费用与等待时间。',
      ),
    )

    main.appendChild(
      row(
        '失败自动重试',
        toggleControl(settings.autoRetry, (checked) => {
          void patchSettings({ autoRetry: checked }).then(redraw)
        }),
        '单批次失败时固定重试 2 次并指数退避，不影响其他批次。',
      ),
    )

    nodes.push(main)

    if (isExplicitSource(settings.sourceLang)) {
      const note = el('p', 'section-footnote')
      note.textContent = '当前设置会在 prompt 中明写源语言，模型无需自行猜测。（A5）'
      nodes.push(note)
    }

    /* ---------- 上限：B8 改为可调下拉 ---------- */
    const limits = el('div', 'tr-card settings-card')
    limits.appendChild(el('div', 'settings-group-title', '上限与保留'))

    limits.appendChild(
      row(
        '全文对比模型上限',
        selectControl(
          [1, 2, 3].map((n) => ({ value: String(n), label: `${n} 个` })),
          String(settings.maxModelsForCompare),
          (value) => {
            void patchSettings({ maxModelsForCompare: Number(value) }).then(redraw)
          },
        ),
        `多模型同时翻译时的最大可选数量（默认 ${MAX_COMPARE_MODELS} 个，超出会提示）。对比视图只在侧边栏内，划词不含对比。`,
      ),
    )

    limits.appendChild(
      row(
        '历史保留上限',
        selectControl(
          [100, 500, 1000, 5000].map((n) => ({ value: String(n), label: `${n} 条` })),
          String(settings.historyLimit),
          (value) => {
            void patchSettings({ historyLimit: Number(value) }).then(redraw)
          },
        ),
        '超出后自动清理最早的记录（本机存储）。',
      ),
    )
    nodes.push(limits)

    /* ---------- 界面 ---------- */
    const ui = el('div', 'tr-card settings-card')
    ui.appendChild(
      row(
        '显示悬浮按钮',
        toggleControl(!settings.fabHidden, (checked) => {
          void patchSettings({ fabHidden: !checked }).then(redraw)
        }),
        '关闭后网页右侧不再出现悬浮按钮，可用浏览器工具栏图标继续操作。',
      ),
    )

    ui.appendChild(
      row(
        '对照文本样式',
        el('div', 'setting-value', '浅底 + 橙色左条'),
        '译文块可折叠，长页面可收起；样式只借用强调色与 8px 圆角，不覆盖网页原有设计。',
      ),
    )
    nodes.push(ui)

    /* ---------- 本地数据 ---------- */
    const data = el('div', 'tr-card settings-card')
    data.appendChild(el('div', 'settings-group-title', '本地数据'))

    const clear = el('button', 'tr-btn tr-btn--danger', '清除翻译缓存')
    clear.type = 'button'
    clear.addEventListener('click', () => {
      void clearCache().then(() => {
        clear.textContent = '已清除'
        window.setTimeout(() => {
          clear.textContent = '清除翻译缓存'
        }, 1500)
      })
    })

    data.appendChild(row('翻译缓存', clear, '只清缓存，不影响模型配置。'))
    nodes.push(data)

    const privacy = el('p', 'section-footnote')
    privacy.textContent = 'API Key、翻译缓存与历史全部保存在本机浏览器存储中，没有任何上报或中转。'
    nodes.push(privacy)

    return nodes
  }

  redraw()
  return container
}
