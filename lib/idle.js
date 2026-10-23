/**
 * lib/idle.js —— 「现在能不能动手」的判定
 * ============================================================================
 * 🔴 主人 m01471：「回滚要先斩后奏，不能让桌面端崩了，稳定，稳定，还是tm的稳定！」
 * 🔴 主人 m01949：「可以后台跑完再通知，不能因为浪费时间就不跑」
 *
 * 这两条要求合起来就是 P4 的第一块砖：**排队等空闲**。
 *   - 试跑/装包要跑 pnpm install，会占 CPU/磁盘几十秒；
 *   - 如果主人正在跟 DSH 对话时我们在底下换 node_modules，
 *     轻则她的会话报错，重则宿主蹦掉 —— 那正是我们存在的理由被自己踩碎。
 *
 * 所以后台队列只在「**没有任何会话处于 running，且已经安静够久**」时才动手。
 *
 * 空闲信号从哪来（实测的宿主事件，别猜）：
 *   - `agent/status`  payload `{ agent, status }`，status 是 `idle` ⇄ `running`
 *   - `agent/disposed`  一个会话没了
 *   - `agent/inbox/inserted` 有人往里塞了消息（说明马上要跑）
 *   - `api-session/status` `(sessionId, running)` 客户端侧的同义信号
 *
 * 为什么还要「安静够久」：
 *   running→idle 的那一刻，主人往往正在打字（下一条消息 3 秒后就来）。
 *   只看 status 会在她打字的间隙里开工，等于什么都没防住。
 *   默认静默 120 秒，可配。
 */

export const DEFAULT_QUIET_MS = 120_000

/**
 * 「running 状态最多信多久」。
 *
 * 🔴 为什么需要这个（2026-10-23 真机事故）：主人静默了 2 小时，
 *    后台队列里两个任务 `tries` 还是 0 —— 一次都没跑。
 *    查出来 tracker 的 Map 里那条会话**一直停在 running**：`agent/status` 的
 *    那次 `idle` 我们没收到（插件是在宿主跑起来之后才装/重载的，漏事件是常态）。
 *    running 状态没有保质期，就等于「永远不敢动」，队列变成摆设。
 *    现在每条状态都带时间戳，超过这个时限又没有任何新事件，就当它「不确定」不再拦人。
 *    真正的长回合不会踩坑：它每次工具调用都会发 `session/event`，我们会 touch + 续期。
 */
export const DEFAULT_STALE_MS = 15 * 60_000

/**
 * @param {{quietMs?: number, staleMs?: number, now?: () => number, probeBusy?: null | (() => string[])}} opts
 */
export function createIdleTracker({ quietMs = DEFAULT_QUIET_MS, staleMs = DEFAULT_STALE_MS, now = Date.now, probeBusy = null } = {}) {
  const status = new Map() // agentId -> { s: 'idle'|'running', at: number }
  const unknown = new Set() // 只在 disposed 时清
  let lastActivity = now()

  const touch = () => { lastActivity = now() }

  function setStatus(agentId, s) {
    if (!agentId) return
    const v = String(s)
    if (v !== 'running' && v !== 'idle') return
    status.set(agentId, { s: v, at: now() })
    unknown.delete(agentId)
    touch()
  }

  function forget(agentId) {
    if (!agentId) return
    status.delete(agentId)
    unknown.delete(agentId)
    touch()
  }

  /** 只算「还在保质期内」的 running —— 过期状态不再拦人（见 DEFAULT_STALE_MS 的由来） */
  function runningAgents() {
    const out = []
    const t = now()
    for (const [id, rec] of status) {
      if (rec?.s !== 'running') continue
      if (staleMs > 0 && t - (rec.at ?? 0) > staleMs) continue
      out.push(id)
    }
    return out
  }

  const quietFor = () => now() - lastActivity

  /**
   * 事件之外的兜底：直接看每个会话的最后一条事件。
   *
   * 为什么必须有这一层：`agent/status` 只在**状态变化**时发声。
   * 插件是在宿主已经跑起来之后才装上/重载的，那个时刻正在跑的会话
   * 永远不会再补发一次 running —— 只看事件就会出现「主人正在干活，
   * 我们却以为全场安静」这种最危险的误判（实测过：0 个已知会话）。
   * 会话的最后一条事件是 turn/start 还是 turn/end，是宿主自己写的事实。
   */
  function probedBusy() {
    if (typeof probeBusy !== 'function') return []
    try {
      const r = probeBusy()
      return Array.isArray(r) ? r.filter(Boolean).map(String) : []
    } catch { return [] }
  }

  /** 还有谁在跑？为什么不能动手？（能动手时返回 null） */
  function reason() {
    const running = runningAgents()
    const probed = probedBusy().filter((id) => !running.includes(id))
    const all = [...running, ...probed]
    if (all.length > 0) {
      const head = all.slice(0, 3).join('、')
      return `${all.length} 个会话正在跑（${head}${all.length > 3 ? '…' : ''}）`
    }
    if (quietFor() < quietMs) {
      return `刚有活动，还要再安静 ${Math.ceil((quietMs - quietFor()) / 1000)} 秒`
    }
    return null
  }

  const isIdle = () => reason() === null

  function snapshot() {
    return {
      running: [...runningAgents(), ...probedBusy().filter((id) => !runningAgents().includes(id))],
      known: status.size,
      quietMs: quietFor(),
      needQuietMs: quietMs,
      idle: isIdle(),
      reason: reason(),
    }
  }

  return { touch, setStatus, forget, isIdle, reason, snapshot, quietFor, runningAgents }
}

/**
 * 把这些宿主事件接到 tracker 上。
 * 返回一个 off()，调用方放在 ctx.effect 里。
 *
 * 注意：这里**只观察**，不拦任何事件；监听器里抛异常会污染宿主，
 * 所以每个回调都包 try/catch，宁可漏记也不许炸。
 */
export function attachIdle(tracker, on) {
  const offs = []
  const guard = (fn) => (...a) => { try { fn(...a) } catch { /* 观察者不许炸宿主 */ } }

  // agent/status：payload { agent, status }
  offs.push(on('agent/status', guard((payload) => {
    const id = payload?.agent?.id
    if (id) tracker.setStatus(id, payload.status)
  })))

  // api-session/status：(sessionId, running: boolean)
  offs.push(on('api-session/status', guard((sessionId, running) => {
    if (sessionId) tracker.setStatus(sessionId, running ? 'running' : 'idle')
  })))

  // 有人往 inbox 塞消息 = 马上要跑
  offs.push(on('agent/inbox/inserted', guard((payload) => {
    const id = payload?.agent?.id
    if (id) tracker.setStatus(id, 'running')
    tracker.touch()
  })))

  // 会话关掉了
  offs.push(on('agent/disposed', guard((payload) => {
    const id = payload?.agent?.id
    if (id) tracker.forget(id)
  })))

  // 🔴 session/event：((session, event) => …) 每一次追加事件都会发。
  //
  //    为什么这条是**主力**（2026-10-23 补）：`agent/status` 只在状态**变化**时发声，
  //    插件重载/漏事件一次，那条会话就永远卡在 running，队列 2 小时一动不动。
  //    而 session/event 是「宿主刚写了一条事件」的直接事实：
  //      · `turn/end`（回合收尾）→ 立刻置 idle
  //      · 其它任何事件（turn/start、tool/call、assistant 增量…）→ 置 running 并续期
  //    顺带解决了另一个洞：长回合里我们会一直 touch，quiet 计时不会误判成「安静了」。
  offs.push(on('session/event', guard((session, event) => {
    const id = session?.id
    const t = String(event?.type ?? '')
    tracker.touch()
    if (!id) return
    if (t === 'turn/end' || t === 'turn/stopped' || t === 'turn/error') tracker.setStatus(id, 'idle')
    else if (t) tracker.setStatus(id, 'running')
  })))

  return () => { for (const f of offs) { try { f?.() } catch { /* ignore */ } } }
}

/**
 * 一个会话的最后一条事件类型。拿不到就返回 ''。
 * 宿主的 Session：`seq` 是已写事件数，`eventAt(seq)` 取事件。
 */
export function lastEventType(session) {
  if (!session) return ''
  try {
    const n = Number(session.seq)
    if (!Number.isFinite(n) || n <= 0) return ''
    if (typeof session.eventAt !== 'function') return ''
    for (const idx of [n - 1, n]) {
      const ev = session.eventAt(idx)
      if (ev && typeof ev.type === 'string') return ev.type
    }
    return ''
  } catch { return '' }
}

/** 「回合已收尾」的事件类型；不是这些就认为还在忙（保守优先） */
const CLOSED_TYPES = new Set(['turn/end'])

/**
 * 直接扫一遍活着的会话，判断谁还在跑（宿主事实，不依赖事件是否补发）。
 * 返回 `[{ id, lastType }]`，只含**忙**的。
 */
export function scanBusySessions(sessions) {
  const out = []
  if (!sessions || typeof sessions.list !== 'function') return out
  let list
  try { list = sessions.list() } catch { return out }
  if (!Array.isArray(list)) return out
  for (const s of list) {
    const t = lastEventType(s)
    if (!t) continue // 一条事件都没有 = 建了没跑过，不算忙
    if (CLOSED_TYPES.has(t)) continue
    out.push({ id: String(s?.id ?? ''), lastType: t })
  }
  return out
}