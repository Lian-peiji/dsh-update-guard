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

  /**
   * 续期：只在**已经判定为 running** 的会话上把时间戳往后推。
   * 绝不新建状态、绝不把 idle 改回 running —— 那是 2026-10-25 那次误判的入口。
   */
  function keepAlive(agentId) {
    if (!agentId) return
    const rec = status.get(agentId)
    if (rec?.s === 'running') rec.at = now()
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
  function busyIds() {
    const running = runningAgents()
    const probed = probedBusy().filter((id) => !running.includes(id))
    return [...running, ...probed]
  }

  function reason() {
    const all = busyIds()
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
    const all = busyIds()
    return {
      running: all,
      known: status.size,
      quietMs: quietFor(),
      needQuietMs: quietMs,
      idle: all.length === 0 && quietFor() >= quietMs,
      reason: reason(),
    }
  }

  return { touch, setStatus, keepAlive, forget, isIdle, reason, snapshot, quietFor, runningAgents }
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
  //    而 session/event 是「宿主刚写了一条事件」的直接事实。
  //
  //    🔴 2026-10-25 真机事故（主人：「我没进行任何对话，怎么显示 5 个正在运行？」）：
  //       原来是「**任何**非 turn/end 事件都置 running」—— 这会把刚收尾的回合重新点着。
  //       宿主的写盘顺序是 `turn/end` 之后**紧跟一条 `session/end-seed`**（还有
  //       session/title、todo/write、model/selection、compaction/* 这些回合之外的记账事件）。
  //       于是 turn/end 先置 idle、下一条 end-seed 又把它摁回 running，
  //       四条早就聊完的会话全被算成「正在跑」，队列一动不动。
  //       现在的规矩：**记账事件只续命、不改判**；回合内事件（tool/call、step/start…）
  //       照旧算 running（保守优先：宁可多等，也别在主人干活时动 node_modules）。
  offs.push(on('session/event', guard((session, event) => {
    const id = session?.id
    const t = String(event?.type ?? '')
    tracker.touch()
    if (!id) return
    if (CLOSED_TURN.has(t)) tracker.setStatus(id, 'idle')
    else if (isBookkeeping(t)) tracker.keepAlive(id) // 只续命，绝不把 idle 改回 running
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

/** 回合收尾的事件（宿主目录里只有 turn/end 一种；stopped/error 留作兼容） */
export const CLOSED_TURN = new Set(['turn/end', 'turn/stopped', 'turn/error'])

/**
 * 「回合之外的记账事件」—— 它们**不能**说明会话在跑。
 *
 * 🔴 这就是 2026-10-25 那次「5 个会话正在跑」的元凶：
 *    宿主在 `turn/end` 之后紧跟一条 `session/end-seed`（另有 session/title、
 *    todo/write、model/selection、compaction/*、job/* 等），旧逻辑把任何非 turn/end
 *    的事件都当成 running，于是刚收尾的回合立刻被重新点着，四条早聊完的会话永远在跑。
 */
export const BOOKKEEPING = new Set([
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'session/flush',
  'todo/write',
  'model/selection',
  'permission/preset',
  'approval/policy',
  'approval/asked',
  'approval/decided',
  'sandbox/mode',
  'working-directory/change',
  'agent-preset/selected',
  'agent/inbox/spliced',
  'subagent/model-selection-policy',
  'subagent/descriptor',
  'subagent/catalog',
  'request/header',
  'request/context',
  'job/registered',
  'job/settled',
  'command/run',
  'command/done',
  'image/offload',
])

/** 记账事件的前缀族（compaction、plugin: 开头的那一大家子，别一个个列） */
const BOOKKEEPING_PREFIXES = ['compaction/', 'plugin:']

/** 这条事件是不是「回合之外的记账」—— 是的话它无权改变忙闲判定 */
export function isBookkeeping(type) {
  const t = String(type ?? '')
  if (!t) return true
  if (BOOKKEEPING.has(t)) return true
  return BOOKKEEPING_PREFIXES.some((p) => t.startsWith(p))
}

/**
 * 扫一段会话事件，找出「回合边界」的结论：'running' | 'idle' | ''（判断不出来）。
 *
 * 关键：**不能只看最后一条事件**。收尾后宿主还会写记账事件，
 * 必须往回找到最近一条 `turn/*`，那才是这个会话真实的回合状态。
 *
 * 🔴 回看预算为什么是 20000 而不是 200（2026-10-25 实测踩到）：
 *    当前这个会话 230 条事件，`turn/start` 在第 6 条 —— 一个回合里能堆两百多条事件
 *    （每个 step 都有 user/message、translator/request、assistant/message…）。
 *    只回看 200 条会直接越过 turn/start，把正在跑的会话判成「不知道」。
 *
 * 为什么敢扫这么多：结果按 (session, seq) 缓存。seq 不变就直接复用上次判决，
 * 所以每来一条新事件才会真扫一次，平时 probe 是零成本的。
 */
const TURN_SCAN_BUDGET = 20_000
const verdictCache = new WeakMap() // session -> { seq, result }

export function turnStateOf(session) {
  if (!session) return { state: '', lastType: '', turnType: '' }
  try {
    const n = Number(session.seq)
    if (!Number.isFinite(n) || n <= 0 || typeof session.eventAt !== 'function') {
      return { state: '', lastType: lastEventType(session), turnType: '' }
    }
    // seq 没变 → 上次的判决仍然成立（这是 probe 高频调用下的性能保证）
    const hit = verdictCache.get(session)
    if (hit && hit.seq === n) return hit.result

    const lastType = lastEventType(session)
    let result = { state: '', lastType, turnType: '' }
    // 从尾部往前找最近一条 turn/*（eventAt 是 0-based：合法下标 0 … n-1）
    for (let i = n - 1; i >= 0 && i > n - 1 - TURN_SCAN_BUDGET; i--) {
      const t = String(session.eventAt(i)?.type ?? '')
      if (!t.startsWith('turn/')) continue
      if (t === 'turn/start') result = { state: 'running', lastType, turnType: t }
      else if (CLOSED_TURN.has(t)) result = { state: 'idle', lastType, turnType: t }
      else result = { state: '', lastType, turnType: t }
      break
    }
    verdictCache.set(session, { seq: n, result })
    return result
  } catch {
    return { state: '', lastType: '', turnType: '' }
  }
}

/**
 * 直接扫一遍活着的会话，判断谁还在跑（宿主事实，不依赖事件是否补发）。
 * 返回 `[{ id, lastType, turnType }]`，只含**忙**的。
 */
export function scanBusySessions(sessions) {
  const out = []
  if (!sessions || typeof sessions.list !== 'function') return out
  let list
  try { list = sessions.list() } catch { return out }
  if (!Array.isArray(list)) return out
  for (const s of list) {
    const { state, lastType, turnType } = turnStateOf(s)
    if (state !== 'running') continue // idle / 判断不出来 都不拦人（保守 = 别把队列卡死）
    out.push({ id: String(s?.id ?? ''), lastType, turnType })
  }
  return out
}