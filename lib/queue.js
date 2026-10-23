/**
 * lib/queue.js —— 后台队列（主人 m02199 说「留到P4吧」，这就是 P4）
 * ============================================================================
 * 为什么要有队列：
 *   一次更新 = 试跑（真装 20s~几分钟）+ 真装（几秒）+ 加载验证。
 *   主人 m01949 说得很清楚：「可以后台跑完再通知，不能因为浪费时间就不跑」。
 *   但如果马上跑，就会撞上她正在用的会话 —— 所以先**排进队列**，
 *   等 `lib/idle.js` 判定安静了再动手。
 *
 * 三条铁律：
 *   1. 队列文件里只放「要装什么」，不放 token、不放凭证。
 *   2. 一个任务失败最多重试 3 次，之后标 failed，**绝不无限重试**（会拖垮机器）。
 *   3. 每个阶段开始前都重新确认一次空闲；一旦主人回来，立刻让位（见 shouldAbort）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const QUEUE_VERSION = 1
export const MAX_TRIES = 3

export function queuePath(dir) {
  return join(dir, '.update-guard', 'queue.json')
}

export function readQueue(dir) {
  const f = queuePath(dir)
  const empty = { version: QUEUE_VERSION, jobs: [] }
  if (!existsSync(f)) return empty
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs : []
    return { version: QUEUE_VERSION, jobs }
  } catch {
    // 文件坏了不能拖死整个插件：留个备份继续用空队列
    try { renameSync(f, `${f}.broken-${Date.now()}`) } catch { /* ignore */ }
    return empty
  }
}

export function writeQueue(dir, q) {
  const f = queuePath(dir)
  mkdirSync(dirname(f), { recursive: true })
  // 先写临时文件再改名 —— 断电时不会留下半个 JSON 把队列永久搞坏
  const tmp = `${f}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: QUEUE_VERSION, jobs: q.jobs ?? [] }, null, 2), 'utf8')
  renameSync(tmp, f)
  return f
}

let seq = 0
function newId() {
  seq += 1
  return `j${Date.now().toString(36)}${seq.toString(36)}`
}

/**
 * 排进队列。同名同版本且还 pending 的不重复排。
 */
export function addJob(dir, { name, to, note = '' } = {}) {
  if (!name) throw new Error('addJob 需要包名')
  const q = readQueue(dir)
  const dup = q.jobs.find((j) => j.name === name && (j.to ?? null) === (to ?? null) && (j.status === 'pending' || j.status === 'running'))
  if (dup) return { job: dup, duplicated: true, queue: q }

  const job = {
    id: newId(),
    name,
    to: to ?? null,
    note,
    status: 'pending',
    tries: 0,
    addedAt: new Date().toISOString(),
    lastError: null,
    finishedAt: null,
  }
  q.jobs.push(job)
  writeQueue(dir, q)
  return { job, duplicated: false, queue: q }
}

export function removeJob(dir, id) {
  const q = readQueue(dir)
  const before = q.jobs.length
  q.jobs = q.jobs.filter((j) => j.id !== id)
  writeQueue(dir, q)
  return { removed: before - q.jobs.length, queue: q }
}

export function clearQueue(dir, { keepRunning = true } = {}) {
  const q = readQueue(dir)
  const before = q.jobs.length
  q.jobs = keepRunning ? q.jobs.filter((j) => j.status === 'running') : []
  writeQueue(dir, q)
  return { removed: before - q.jobs.length, queue: q }
}

export function pendingJobs(q) {
  return (q?.jobs ?? []).filter((j) => j.status === 'pending')
}

export function markJob(dir, id, patch) {
  const q = readQueue(dir)
  const job = q.jobs.find((j) => j.id === id)
  if (!job) return null
  Object.assign(job, patch)
  writeQueue(dir, q)
  return job
}

export function renderQueue(q) {
  const jobs = q?.jobs ?? []
  if (jobs.length === 0) return '队列是空的。'
  const lines = [`## 后台队列（${jobs.length} 个任务）`]
  for (const j of jobs) {
    const target = j.to ? ` → ${j.to}` : ''
    const tries = j.tries ? `（已试 ${j.tries} 次）` : ''
    const mark = j.status === 'done' ? '✅'
      : j.status === 'failed' ? '❌'
      : j.status === 'skipped' ? '⚪'
      : j.status === 'running' ? '⏳' : '⏸'
    lines.push(`- ${mark} ${j.name}${target}${tries}　${j.id}`)
    // 「没装成」和「上次失败」分开说，免得把「试跑没过」看成「系统坏了」
    if (j.lastError) {
      const label = j.status === 'skipped' ? '没装：' : j.status === 'failed' ? '没装成：' : j.status === 'pending' ? '上次失败：' : '备注：'
      lines.push(`  - ${label}${String(j.lastError).slice(0, 200)}`)
    }
  }
  return lines.join('\n')
}

/**
 * 队列泵：定期看一眼「队列有没有活 + 现在闲不闲」，闲就干一件。
 *
 * 它自己**不装包**——装包由调用方通过 runJob 注入，
 * 这样泵只负责「什么时候能动、动完之后记什么」，两件事分开好测。
 *
 * @param {object} o
 * @param {string} o.dir  profile 目录
 * @param {{isIdle(): boolean, reason(): string | null, snapshot(): object}} o.idle
 * @param {(job: object, ctx: {shouldAbort: () => boolean}) => Promise<object>} o.runJob
 * @param {(evt: object) => void} [o.log]
 * @param {() => boolean} [o.enabled] 运行中动态开关
 */
export function createPump({ dir, idle, runJob, log = () => {}, enabled = () => true }) {
  let timer = null
  let busy = false

  // 🔴 心跳记录（2026-10-23 加）：主人问「静默这么久，现在怎么样」，
  //    结果队列里的任务 tries 还是 0 —— 光看队列文件根本分不清
  //    「泵没转」还是「泵转了但每次都被空闲判定挡回去」。
  //    这种「静默失败」正是这个插件最该消灭的东西，所以把每次 tick 的结论记下来，
  //    让 `plugin_queue list` 能直接说出「上一次为什么没动、什么时候」。
  let last = { at: null, ms: null, result: { skipped: '还没跑过（刚启动）' } }

  async function tickOnce() {
    if (busy) return { skipped: '上一个任务还在跑' }
    if (!enabled()) return { skipped: '后台队列关了' }
    const q = readQueue(dir)
    const job = pendingJobs(q)[0]
    if (!job) return { skipped: '队列是空的' }
    const why = idle.reason()
    // 家庭作业：主人正在用，就安静等着，别去碰 node_modules
    if (why) return { skipped: why }

    busy = true
    markJob(dir, job.id, { status: 'running', tries: (job.tries ?? 0) + 1, startedAt: new Date().toISOString() })
    log({ kind: 'queue/start', job })
    try {
      // 每个阶段前都会再问一次 shouldAbort，主人回来就让位
      const r = await runJob(job, { shouldAbort: () => !idle.isIdle() })
      if (r && r.aborted) {
        markJob(dir, job.id, { status: 'pending', lastError: `让位：${r.reason ?? '主人在用'}` })
        log({ kind: 'queue/yield', job, why: r.reason })
        return { aborted: true, reason: r.reason }
      }
      // 🔴 不是「跑完就算成功」（2026-10-23 真机抓到）：
      //    原来不管 runJob 返回什么，一律标 done ✅。
      //    结果 cc-safety-net 2.6.17 那单试跑失败、disk 上还是 2.6.16，
      //    队列里却显示 ✅「已试 1 次」—— 看上去装好了，实际没装。
      //    现在按结果分：真装上才 done；被判「跳过/先等等」记 skipped；
      //    试跑失败/装失败直接记 failed（同一版本不再自动重试，免得死循环）。
      const outcome = String(r?.result ?? '')
      if (r && r.ok === false) {
        const refused = outcome === 'refused' || outcome === 'blocked'
        markJob(dir, job.id, {
          status: refused ? 'skipped' : 'failed',
          finishedAt: new Date().toISOString(),
          lastError: refused ? '审查没让装' : (r?.report ? String(r.report).split('\n')[0].slice(0, 200) : '没装成'),
          result: outcome || null,
        })
        log({ kind: refused ? 'queue/skipped' : 'queue/not-installed', job, result: outcome })
        return { ok: false, result: outcome, refused, report: r?.report ?? '' }
      }
      markJob(dir, job.id, { status: 'done', finishedAt: new Date().toISOString(), lastError: null, result: outcome || null })
      log({ kind: 'queue/done', job, result: r })
      return { ok: true, result: r }
    } catch (e) {
      const q2 = readQueue(dir)
      const cur = q2.jobs.find((j) => j.id === job.id)
      const tries = cur?.tries ?? 1
      const msg = String(e?.message ?? e)
      if (tries >= MAX_TRIES) {
        markJob(dir, job.id, { status: 'failed', lastError: msg, finishedAt: new Date().toISOString() })
        log({ kind: 'queue/failed', job, error: msg })
        return { ok: false, failed: true, error: msg }
      }
      markJob(dir, job.id, { status: 'pending', lastError: msg })
      log({ kind: 'queue/retry', job, error: msg, tries })
      return { ok: false, retry: true, error: msg }
    } finally {
      busy = false
    }
  }

  async function tick() {
    const t0 = Date.now()
    let r
    try {
      r = await tickOnce()
    } catch (e) {
      r = { error: String(e?.message ?? e) }
    }
    last = { at: new Date().toISOString(), ms: Date.now() - t0, result: r }
    return r
  }

  function start({ intervalMs = 60_000 } = {}) {
    if (timer) return
    timer = setInterval(() => { tick().catch(() => {}) }, Math.max(10_000, Number(intervalMs) || 60_000))
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop, isBusy: () => busy, lastTick: () => last }
}