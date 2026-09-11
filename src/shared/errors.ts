/**
 * 错误分类 —— 实现 docs/00 §D-1 的「错误类型 → 文案 / 动作」映射表。
 *
 * 统一规则：所有错误**不弹 alert**，一律以「块内联占位 + 可选 Toast」呈现；
 * 同一批次只报一次 Toast，避免刷屏。
 */

import type { ErrorAction, ErrorInfo, ErrorKind } from './types'

/** 可重试的错误类型：超时 / 限流 / 服务端 / 网络（docs/00 §D-2） */
const RETRYABLE_KINDS: readonly ErrorKind[] = ['timeout', 'rate-limit', 'server', 'network']

/** D-1 表格：类型 → 文案 + 动作 */
const ERROR_MATRIX: Record<ErrorKind, { message: string; actions: ErrorAction[] }> = {
  'no-model': { message: '尚未配置模型，完成配置后即可翻译', actions: ['configure'] },
  auth: { message: 'API Key 无效或无权访问该模型', actions: ['configure', 'retry'] },
  quota: { message: '账户余额不足或额度已用尽', actions: ['topup', 'retry'] },
  'rate-limit': { message: '请求过于频繁，请稍后重试', actions: ['retry'] },
  timeout: { message: '请求超时，可能是文本过长或网络较慢', actions: ['retry'] },
  network: { message: '网络异常，请检查网络或接口地址', actions: ['retry', 'check-config'] },
  server: { message: '模型服务异常（5xx），请稍后重试', actions: ['retry'] },
  refused: { message: '模型拒绝翻译该内容', actions: ['copy-source'] },
  canceled: { message: '已取消', actions: [] },
  'invalid-config': { message: '模型配置不完整，请检查接口地址与模型名称', actions: ['configure'] },
  unknown: { message: '翻译失败，请稍后重试', actions: ['retry'] },
}

export function isRetryableKind(kind: ErrorKind): boolean {
  return RETRYABLE_KINDS.includes(kind)
}

export function errorInfoOf(kind: ErrorKind, overrideMessage?: string): ErrorInfo {
  const row = ERROR_MATRIX[kind] ?? ERROR_MATRIX.unknown
  return {
    kind,
    message: overrideMessage ?? row.message,
    actions: row.actions,
    retryable: isRetryableKind(kind),
  }
}

/** 带分类信息的错误对象，贯穿 Background ↔ Content */
export class TransoraError extends Error {
  readonly info: ErrorInfo

  constructor(info: ErrorInfo) {
    super(info.message)
    this.name = 'TransoraError'
    this.info = info
  }

  static of(kind: ErrorKind, message?: string): TransoraError {
    return new TransoraError(errorInfoOf(kind, message))
  }
}

/**
 * 由 HTTP 状态码判定错误类型。
 * 状态码之外的判据：响应体关键词（额度不足 / 内容被拒）优先于状态码兜底。
 */
export function fromHttpStatus(status: number, bodyText = ''): TransoraError {
  const body = bodyText.toLowerCase()

  if (status === 402 || /insufficient|quota|balance|额度|余额/.test(body)) {
    return TransoraError.of('quota')
  }
  if (status === 401 || status === 403) {
    return TransoraError.of('auth')
  }
  if (status === 429) {
    return TransoraError.of('rate-limit')
  }
  if (status >= 500) {
    return TransoraError.of('server')
  }
  if (status === 408 || status === 504) {
    return TransoraError.of('timeout')
  }
  if (status === 404) {
    return TransoraError.of('invalid-config', '接口地址不存在（404），请检查接口地址是否包含正确的路径')
  }
  return TransoraError.of('unknown', `请求失败（HTTP ${status}）`)
}

/** 兜底：把任意异常归一到 TransoraError */
export function fromUnknown(err: unknown): TransoraError {
  if (err instanceof TransoraError) return err

  if (err instanceof DOMException && err.name === 'AbortError') {
    return TransoraError.of('canceled')
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return TransoraError.of('canceled')
    if (err.name === 'TimeoutError') return TransoraError.of('timeout')
    if (err instanceof TypeError) return TransoraError.of('network')
    return TransoraError.of('unknown', err.message)
  }
  return TransoraError.of('unknown')
}

export function canceledError(): TransoraError {
  return TransoraError.of('canceled')
}
