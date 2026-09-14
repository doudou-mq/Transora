/**
 * 「供应商 / 模型」两级分组（G5 ④）的单测。
 *
 * 为什么单独测这层：它是纯函数，而 e2e 只能覆盖「本地端口」这种回落路径，
 * 厂商识别表与「带端口分组」这两个分支只有在单测里才能稳定断言。
 */

import { describe, expect, it } from 'vitest'
import { langShortName } from '@/shared/langs'
import { groupByProvider, providerOf } from '@/shared/providers'
import type { ModelConfig } from '@/shared/types'

function model(partial: Partial<ModelConfig> & { id: string }): ModelConfig {
  return {
    name: 'Mock',
    provider: 'openai-compatible',
    endpoint: 'https://api.deepseek.com/v1',
    apiKey: 'sk-x',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 0,
    enabled: true,
    ...partial,
  }
}

describe('providerOf', () => {
  it('识别已知厂商（含子域后缀匹配）', () => {
    expect(providerOf(model({ id: '1', endpoint: 'https://api.deepseek.com/v1' })).label).toBe(
      'DeepSeek',
    )
    expect(
      providerOf(model({ id: '2', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }))
        .label,
    ).toBe('通义千问')
    expect(providerOf(model({ id: '3', endpoint: 'https://api.moonshot.cn/v1' })).label).toBe('Kimi')
  })

  it('取最长后缀，避免 api.x.com 被更短的 x.com 抢先命中', () => {
    expect(providerOf(model({ id: '1', endpoint: 'https://api.openai.com/v1' })).label).toBe(
      'OpenAI',
    )
  })

  it('未知厂商回落到主机名，并用「带端口的 host」当分组键', () => {
    const a = providerOf(model({ id: '1', endpoint: 'http://127.0.0.1:8802/v1' }))
    const b = providerOf(model({ id: '2', endpoint: 'http://127.0.0.1:8899/v1' }))
    expect(a.label).toBe('127.0.0.1:8802')
    // 同主机不同端口不能被并成一组
    expect(a.key).not.toBe(b.key)
  })

  it('已知厂商的默认端口会被 URL 省略，分组键保持干净', () => {
    expect(providerOf(model({ id: '1', endpoint: 'https://api.deepseek.com/v1' })).key).toBe(
      'api.deepseek.com',
    )
  })

  it('地址还没填好时用模型名兜底，不产生空分组', () => {
    const ref = providerOf(model({ id: '1', endpoint: '', name: '我的网关' }))
    expect(ref.label).toBe('我的网关')
    expect(ref.key).toBe('name:我的网关')
  })
})

describe('groupByProvider', () => {
  it('按供应商聚合且保持传入顺序', () => {
    const groups = groupByProvider([
      model({ id: 'a', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
      model({ id: 'b', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' }),
      model({ id: 'c', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' }),
    ])
    expect(groups.map((g) => g.label)).toEqual(['DeepSeek', 'Kimi'])
    expect(groups[0].models.map((m) => m.model)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(groups[1].models).toHaveLength(1)
  })

  it('空输入返回空数组', () => {
    expect(groupByProvider([])).toEqual([])
  })
})

describe('langShortName', () => {
  it('语言对缩写按设计稿口径（英 → 中），中文变体可区分', () => {
    expect(langShortName('en')).toBe('英')
    expect(langShortName('zh-CN')).toBe('中')
    expect(langShortName('zh-TW')).toBe('繁')
    expect(langShortName('es')).toBe('西')
    expect(langShortName('auto')).toBe('自动')
  })

  it('未知取值原样返回', () => {
    expect(langShortName('xx-YY')).toBe('xx-YY')
  })
})
