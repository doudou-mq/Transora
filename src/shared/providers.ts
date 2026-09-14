/**
 * 「供应商 / 模型」两级分组（G5 划词内容块底部的 Tab 栏）。
 *
 * 为什么需要这一层：本地数据模型里 `ModelConfig.provider` 固定为 `openai-compatible`
 * （D3：只接 OpenAI 兼容接口），所以「供应商」不是配置字段，而是**从接口地址的主机名推断**出来的：
 * 命中已知厂商表就用厂商名（DeepSeek / 通义千问 / Kimi …），否则回落到主机名本身。
 *
 * 这样同一厂商下的多个模型天然归到一组，用户看到的两级结构与设计稿 G5 一致；
 * 想新增识别，只需在 `KNOWN_PROVIDERS` 里补一条，不改任何 UI 代码。
 *
 * ⚠️ 只做**展示分组**，不参与任何网络行为：URL 仍由 Background 自己拼（docs/00 §G-2 约束 2）。
 */

import type { ModelConfig } from './types'

/** 主机名后缀 → 厂商展示名。顺序无所谓，匹配时取最长后缀，避免 `api.x.com` 被 `x.com` 抢先命中。 */
const KNOWN_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['api.deepseek.com', 'DeepSeek'],
  ['dashscope.aliyuncs.com', '通义千问'],
  ['api.moonshot.cn', 'Kimi'],
  ['api.openai.com', 'OpenAI'],
  ['open.bigmodel.cn', '智谱 GLM'],
  ['api.siliconflow.cn', '硅基流动'],
  ['volces.com', '豆包'],
  ['api.hunyuan.cloud.tencent.com', '腾讯混元'],
  ['api.minimax.chat', 'MiniMax'],
  ['api.stepfun.com', '阶跃星辰'],
  ['api.baichuan-ai.com', '百川'],
  ['api.lingyiwanwu.com', '零一万物'],
]

export interface ProviderRef {
  /** 分组键（主机名），用于判定「当前供应商」 */
  key: string
  /** 展示名 */
  label: string
}

export interface ProviderGroup extends ProviderRef {
  models: ModelConfig[]
}

/** 取出 endpoint 的主机名与 host（host 带端口）；解析不了时返回空串（调用方退回到模型名） */
function hostOf(endpoint: string): { hostname: string; host: string } {
  try {
    const url = new URL(endpoint.trim())
    return { hostname: url.hostname.toLowerCase(), host: url.host.toLowerCase() }
  } catch {
    return { hostname: '', host: '' }
  }
}

/** 单个模型归属的供应商 */
export function providerOf(model: ModelConfig): ProviderRef {
  const { hostname, host } = hostOf(model.endpoint)
  if (!hostname) {
    // 地址还没填好（例如正在编辑中的配置）——用模型名兜底，保证界面上不出现空分组
    return { key: `name:${model.name}`, label: model.name }
  }

  // 取最长匹配后缀，`api.deepseek.com` 优先于 `deepseek.com` 这类粗匹配
  let best = ''
  let bestLabel = ''
  for (const [suffix, label] of KNOWN_PROVIDERS) {
    if ((hostname === suffix || hostname.endsWith(`.${suffix}`)) && suffix.length > best.length) {
      best = suffix
      bestLabel = label
    }
  }

  // 分组键用带端口的 host：自建网关/本地端口不会被并成一组；已知厂商的默认端口会被 URL 省略，键依然干净
  return { key: host, label: bestLabel || host }
}

/** 按供应商分组，保持传入顺序（调用方传进来的已是「已启用模型」） */
export function groupByProvider(models: readonly ModelConfig[]): ProviderGroup[] {
  const groups: ProviderGroup[] = []
  const index = new Map<string, ProviderGroup>()

  for (const model of models) {
    const ref = providerOf(model)
    let group = index.get(ref.key)
    if (!group) {
      group = { ...ref, models: [] }
      index.set(ref.key, group)
      groups.push(group)
    }
    group.models.push(model)
  }

  return groups
}
