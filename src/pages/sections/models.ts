/**
 * 区块一：模型配置（FR-07 / FR-08 / FR-12）
 *
 * 这里也是安装后的落地区块（X5）：首次进入时以页内轻量步骤提示呈现引导，
 * 不新开 tab、不强制走完（docs/00 §C1）。
 */

import { MSG, sendToBackground, type TestConnectionResponse } from '@/shared/messages'
import { TARGET_LANGS } from '@/shared/langs'
import type { ModelConfig } from '@/shared/types'
import { uid } from '@/shared/utils'
import { el, getContext, saveModels } from '../store'

function emptyModel(): ModelConfig {
  return {
    id: uid('model'),
    name: '',
    provider: 'openai-compatible',
    endpoint: '',
    apiKey: '',
    model: '',
    // 留空 = 跟随「通用设置 · 默认目标语言」
    targetLang: '',
    temperature: 0.3,
    maxTokens: 0,
    enabled: true,
  }
}

function field(
  label: string,
  control: HTMLElement,
  hint?: string,
): HTMLElement {
  const wrap = el('div', 'field')
  wrap.appendChild(el('label', 'field-label', label))
  wrap.appendChild(control)
  if (hint) wrap.appendChild(el('div', 'field-hint', hint))
  return wrap
}

function textInput(
  value: string,
  placeholder: string,
  onInput: (value: string) => void,
  options: { mono?: boolean; type?: string } = {},
): HTMLElement {
  const input = el('input', `tr-input${options.mono ? ' tr-mono' : ''}`)
  input.type = options.type ?? 'text'
  input.value = value
  input.placeholder = placeholder
  input.addEventListener('input', () => onInput(input.value))
  return input
}

function numberInput(
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (value: number) => void,
): HTMLElement {
  const input = el('input', 'tr-input')
  input.type = 'number'
  input.value = String(value)
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.addEventListener('input', () => {
    const parsed = Number(input.value)
    if (Number.isFinite(parsed)) onInput(parsed)
  })
  return input
}

/** 下拉输入（B9 第 5 字段「目标语言」） */
function selectInput(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const select = el('select', 'tr-select')
  for (const option of options) {
    const opt = document.createElement('option')
    opt.value = option.value
    opt.textContent = option.label
    if (option.value === value) opt.selected = true
    select.appendChild(opt)
  }
  select.addEventListener('change', () => onChange(select.value))
  return select
}

/**
 * 编辑态放在模块作用域而不是 renderModels 的闭包里：
 * 页面因存储变更（其它标签页 / Popup 改动设置）而整体重绘时，未保存的草稿不会丢。
 */
let draft: ModelConfig | null = null
let isNew = false
let status: { kind: 'ok' | 'error'; text: string } | null = null
let testing = false

export function renderModels(): HTMLElement {
  const container = el('div', 'section')

  /* ---------------- 编辑态 ---------------- */

  function validate(model: ModelConfig): string | null {
    if (!model.name.trim()) return '请填写显示名称'
    if (!model.endpoint.trim()) return '请填写接口地址'
    if (!/^https?:\/\//i.test(model.endpoint.trim())) return '接口地址需以 http:// 或 https:// 开头'
    if (!model.model.trim()) return '请填写模型名称'
    return null
  }

  function buildEditor(): HTMLElement {
    const model = draft as ModelConfig
    const { settings } = getContext()
    const card = el('div', 'tr-card editor')
    card.appendChild(el('div', 'editor-title', isNew ? '新增模型' : '编辑模型'))

    const grid = el('div', 'editor-grid')

    grid.appendChild(
      field(
        '显示名称',
        textInput(model.name, '例如 DeepSeek', (value) => {
          model.name = value
        }),
      ),
    )

    grid.appendChild(
      field(
        '接口地址',
        textInput(
          model.endpoint,
          'https://api.deepseek.com/v1',
          (value) => {
            model.endpoint = value
          },
          { mono: true },
        ),
        '填到 /v1 即可，扩展会自动补 /chat/completions；直接填到 /chat/completions 也可以。',
      ),
    )

    grid.appendChild(
      field(
        'API Key',
        textInput(
          model.apiKey,
          'sk-…',
          (value) => {
            model.apiKey = value
          },
          { mono: true, type: 'password' },
        ),
        '只保存在本机，不会上传到任何服务器。',
      ),
    )

    grid.appendChild(
      field(
        '模型名称',
        textInput(
          model.model,
          'deepseek-chat',
          (value) => {
            model.model = value
          },
          { mono: true },
        ),
      ),
    )

    // B9 / E2 第 5 个字段：目标语言。留空 = 跟随通用设置里的「默认目标语言」
    grid.appendChild(
      field(
        '目标语言',
        selectInput(
          [
            { value: '', label: `跟随全局设置（${settings.targetLang}）` },
            ...TARGET_LANGS.map((l) => ({ value: l.value, label: l.label })),
          ],
          model.targetLang ?? '',
          (value) => {
            model.targetLang = value
          },
        ),
        '留空即跟随通用设置；单独指定后，用这套模型翻译时固定输出到该语言。',
      ),
    )

    const numbers = el('div', 'editor-numbers')
    numbers.appendChild(
      field(
        '温度',
        numberInput(model.temperature, 0, 2, 0.1, (value) => {
          model.temperature = value
        }),
        '翻译建议 0.2 – 0.4。',
      ),
    )
    numbers.appendChild(
      field(
        '最大输出 token',
        numberInput(model.maxTokens, 0, 200000, 128, (value) => {
          model.maxTokens = value
        }),
        '填 0 表示不限制，由服务端默认。',
      ),
    )
    grid.appendChild(numbers)

    card.appendChild(grid)

    const actions = el('div', 'editor-actions')

    const save = el('button', 'tr-btn tr-btn--primary', '保存配置')
    save.type = 'button'
    save.addEventListener('click', () => {
      const error = validate(model)
      if (error) {
        status = { kind: 'error', text: error }
        redraw()
        return
      }
      const next = isNew
        ? [...getContext().models, model]
        : getContext().models.map((m) => (m.id === model.id ? model : m))
      void saveModels(next).then(() => {
        draft = null
        status = { kind: 'ok', text: isNew ? '已新增模型' : '已保存到本机' }
        redraw()
      })
    })
    actions.appendChild(save)

    const test = el('button', 'tr-btn', testing ? '测试中…' : '测试连接')
    test.type = 'button'
    test.disabled = testing
    test.addEventListener('click', () => {
      const error = validate(model)
      if (error) {
        status = { kind: 'error', text: error }
        redraw()
        return
      }
      testing = true
      status = null
      redraw()
      void sendToBackground<TestConnectionResponse>({ type: MSG.TEST_CONNECTION, model }).then(
        (result) => {
          testing = false
          // B11：设计稿口径「连接成功 ｜ deepseek-chat 响应正常，耗时 812 ms ｜ 已保存到本机」
          const modelName = model.model || '模型'
          status = result.ok
            ? {
                kind: 'ok',
                text: `连接成功 ｜ ${modelName} 响应正常，耗时 ${result.latencyMs} ms ｜ 已保存到本机`,
              }
            : { kind: 'error', text: result.error?.message ?? '连接失败' }
          redraw()
        },
      )
    })
    actions.appendChild(test)

    const cancel = el('button', 'tr-btn tr-btn--ghost', '取消')
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      draft = null
      status = null
      redraw()
    })
    actions.appendChild(cancel)

    card.appendChild(actions)

    if (status) {
      const note = el('div', `editor-status editor-status--${status.kind}`, status.text)
      card.appendChild(note)
    }

    return card
  }

  /* ---------------- 列表态 ---------------- */

  function buildModelCard(model: ModelConfig): HTMLElement {
    const card = el('div', 'tr-card model-card')
    if (!model.enabled) card.classList.add('model-card--off')

    const head = el('div', 'model-head')

    const title = el('div', 'model-title')
    title.appendChild(el('span', 'model-name', model.name || '未命名模型'))
    if (!model.enabled) title.appendChild(el('span', 'tr-pill', '已停用'))
    head.appendChild(title)

    const actions = el('div', 'model-actions')

    const toggle = el('button', 'tr-btn tr-btn--sm', model.enabled ? '停用' : '启用')
    toggle.type = 'button'
    toggle.addEventListener('click', () => {
      const next = getContext().models.map((m) =>
        m.id === model.id ? { ...m, enabled: !m.enabled } : m,
      )
      void saveModels(next).then(redraw)
    })
    actions.appendChild(toggle)

    const edit = el('button', 'tr-btn tr-btn--sm', '编辑')
    edit.type = 'button'
    edit.addEventListener('click', () => {
      draft = { ...model }
      isNew = false
      status = null
      redraw()
    })
    actions.appendChild(edit)

    const remove = el('button', 'tr-btn tr-btn--sm tr-btn--danger', '删除')
    remove.type = 'button'
    remove.addEventListener('click', () => {
      const next = getContext().models.filter((m) => m.id !== model.id)
      void saveModels(next).then(redraw)
    })
    actions.appendChild(remove)

    head.appendChild(actions)
    card.appendChild(head)

    const meta = el('div', 'model-meta')
    meta.appendChild(el('span', 'tr-mono', model.endpoint || '—'))
    meta.appendChild(el('span', 'model-meta-dot', '·'))
    meta.appendChild(el('span', 'tr-mono', model.model || '—'))
    card.appendChild(meta)

    return card
  }

  function buildEmpty(): HTMLElement {
    const card = el('div', 'tr-card onboarding')
    card.appendChild(el('div', 'onboarding-title', '还没有配置模型'))
    card.appendChild(
      el(
        'p',
        'onboarding-desc',
        'Transora 不内置模型、不中转请求。填入任意 OpenAI 兼容服务的接口地址、密钥和模型名，就可以开始翻译了。',
      ),
    )

    const steps = el('ol', 'onboarding-steps')
    for (const line of [
      '在模型服务商处申请 API Key',
      '把接口地址（到 /v1 即可）与模型名称填进来',
      '点「测试连接」确认可用，然后回到网页开始翻译',
    ]) {
      steps.appendChild(el('li', undefined, line))
    }
    card.appendChild(steps)

    return card
  }

  function redraw(): void {
    container.replaceChildren()

    const list = el('div', 'model-list')
    if (draft) list.appendChild(buildEditor())

    for (const model of getContext().models) {
      list.appendChild(buildModelCard(model))
    }

    if (!draft) {
      if (getContext().models.length === 0) list.appendChild(buildEmpty())

      const add = el('button', 'tr-btn tr-btn--primary', '新增模型')
      add.type = 'button'
      add.addEventListener('click', () => {
        draft = emptyModel()
        isNew = true
        status = null
        redraw()
      })
      list.appendChild(add)
    }

    container.appendChild(list)

    if (status && !draft) {
      container.appendChild(el('div', `editor-status editor-status--${status.kind}`, status.text))
    }
  }

  redraw()
  return container
}
