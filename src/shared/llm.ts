/**
 * OpenAI 兼容客户端（D3：仅实现 chat/completions）。
 *
 * ⚠️ 本模块**只在 Background / 扩展页面**中使用。
 *    Content Script 受宿主页面同源策略约束，跨域请求会被 CORS 拦截（docs/00 §G-2），
 *    因此内容脚本必须把请求委托给 Background 执行。
 *
 * 非流式（D5）。超时 60s（docs/00 §D-2）。
 */

import { REQUEST_TIMEOUT_MS } from './constants'
import { TransoraError, fromHttpStatus, fromUnknown } from './errors'
import type { ChatResult, ModelConfig } from './types'

/** 把用户填写的接口地址补全为 chat/completions 端点 */
export function resolveChatUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\s+/g, '')
  if (!base) {
    throw TransoraError.of('invalid-config', '请先填写接口地址')
  }
  if (base.endsWith('/chat/completions')) return base
  return `${base.replace(/\/+$/, '')}/chat/completions`
}

/** 调用前的配置校验（FR-07 字段校验） */
export function validateModel(model: ModelConfig): void {
  if (!model.endpoint?.trim()) {
    throw TransoraError.of('invalid-config', '接口地址不能为空')
  }
  if (!/^https?:\/\//i.test(model.endpoint.trim())) {
    throw TransoraError.of('invalid-config', '接口地址需以 http:// 或 https:// 开头')
  }
  if (!model.model?.trim()) {
    throw TransoraError.of('invalid-config', '模型名称不能为空')
  }
  try {
    resolveChatUrl(model.endpoint)
  } catch {
    throw TransoraError.of('invalid-config', '接口地址格式不正确')
  }
}

export interface ChatOptions {
  model: ModelConfig
  system: string
  user: string
  timeoutMs?: number
  /** 外部取消信号（用户点取消 / 切换页面） */
  signal?: AbortSignal
  /** 覆盖温度等（连接测试用低温） */
  temperatureOverride?: number
}

/**
 * 发起一次非流式 chat/completions 调用。
 * 失败时抛 TransoraError（已分类），调用方不需要再判断 status code。
 */
export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  const { model, system, user, timeoutMs = REQUEST_TIMEOUT_MS, signal, temperatureOverride } = options

  validateModel(model)

  const url = resolveChatUrl(model.endpoint)
  const controller = new AbortController()
  const startAt = Date.now()

  const onExternalAbort = (): void => controller.abort('canceled')
  if (signal) {
    if (signal.aborted) throw TransoraError.of('canceled')
    signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)

  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: temperatureOverride ?? model.temperature ?? 0.3,
          // 未填则不传，交给服务端默认值
          ...(model.maxTokens > 0 ? { max_tokens: model.maxTokens } : {}),
          stream: false,
        }),
        signal: controller.signal,
      })
    } catch (err) {
      // 区分「我们主动 abort」与「网络层失败」
      if (controller.signal.aborted) {
        throw controller.signal.reason === 'timeout'
          ? TransoraError.of('timeout')
          : TransoraError.of('canceled')
      }
      throw fromUnknown(err)
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      throw fromHttpStatus(response.status, bodyText)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw TransoraError.of('unknown', '模型返回的内容不是合法 JSON')
    }

    const content = extractContent(payload)
    if (!content.trim()) {
      throw TransoraError.of('refused')
    }

    return {
      content,
      latencyMs: Date.now() - startAt,
      usage: extractUsage(payload),
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}

interface ChatPayload {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

function extractContent(payload: unknown): string {
  const data = payload as ChatPayload
  const choice = data?.choices?.[0]
  const content = choice?.message?.content

  if (typeof content === 'string') return content
  // 部分兼容实现返回的是分段数组
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
      .join('')
  }
  if (typeof choice?.text === 'string') return choice.text
  return ''
}

function extractUsage(payload: unknown): ChatResult['usage'] {
  const usage = (payload as ChatPayload)?.usage
  if (!usage) return undefined
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  }
}
