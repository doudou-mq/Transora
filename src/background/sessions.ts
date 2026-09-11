/**
 * 翻译会话（取消控制）。
 *
 * 一个「会话」= 一次全文翻译（或一次划词请求）。内容脚本发起时带上 sessionId，
 * 长页面中途取消时下发 cancel，Background 立即 abort 掉该会话所有在途 fetch。
 *
 * 会话对象是 SW 内的脆弱状态：SW 一旦休眠即丢失，但丢失只会让「取消」失效
 * （在途请求自行跑完），不影响正确性。
 */

interface Session {
  controller: AbortController
  canceled: boolean
  createdAt: number
}

const sessions = new Map<string, Session>()

const SESSION_TTL_MS = 5 * 60 * 1000

function sweep(): void {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }
}

export function getSession(sessionId: string): Session {
  sweep()
  let session = sessions.get(sessionId)
  if (!session) {
    session = { controller: new AbortController(), canceled: false, createdAt: Date.now() }
    sessions.set(sessionId, session)
  }
  return session
}

export function cancelSession(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.canceled = true
  session.controller.abort('canceled')
  sessions.delete(sessionId)
  return true
}

export function finishSession(sessionId: string): void {
  sessions.delete(sessionId)
}
