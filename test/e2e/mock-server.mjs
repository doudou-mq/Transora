/**
 * e2e 用的本地服务：提供测试网页 + 一个 OpenAI 兼容的模拟模型接口。
 *
 * 为什么需要一个「假模型」：扩展的翻译链路必须真的发一次 HTTP 请求才算跑通，
 * 而真实服务商需要密钥、会花钱、结果还不稳定。这里用一个本地 mock，
 * 既验证了「Background 代理请求 → 解析 → 回填」的完整链路，又保证用例可重复。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixture.html')

/**
 * 从 prompt 里抽出 `<编号>原文` 并逐个生成译文，模拟真实模型的分段返回。
 *
 * 译文标记里**带上本次请求的 model 名**：多模型对比（FR-09）必须能证明
 * 「同一块的两列译文分别来自两个模型」，否则两列拿到同样的字符串也测不出串味。
 */
function mockCompletion(userContent, model) {
  const tag = model ? `【译·${model}】` : '【译】'
  const pairs = [...userContent.matchAll(/<(\d{1,4})>([^\n]*)/g)]
  if (pairs.length === 0) return `<1>${tag}ok`
  return pairs.map(([, id, text]) => `<${id}>${tag}${text.trim().slice(0, 160)}`).join('\n')
}

export function startMockServer(port = 8787) {
  const page = fs.readFileSync(FIXTURE, 'utf-8')
  /** 模型请求计数：供「应用不重新请求（D-3）」这类断言使用 */
  let requestCount = 0

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      requestCount += 1
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        let userContent = ''
        let model = ''
        try {
          const payload = JSON.parse(body)
          model = payload.model ?? ''
          for (const message of payload.messages ?? []) {
            if (message.role === 'user') userContent = message.content ?? ''
          }
        } catch {
          /* 请求体不是 JSON 时按空内容处理，让扩展侧走到解析失败分支 */
        }

        const payload = {
          choices: [
            {
              message: { role: 'assistant', content: mockCompletion(userContent, model) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        getRequestCount: () => requestCount,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

// 允许单独启动，方便手工在浏览器里调
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8787)
  const handle = await startMockServer(port)
  console.log(`mock server on ${handle.baseUrl}`)
}
