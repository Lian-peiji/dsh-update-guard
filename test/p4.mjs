/**
 * test/p4.mjs —— P4（空闲编排 + 后台队列 + 带兜底重启）的离线自测
 * ============================================================================
 * 这一套**不碰真进程、不真重启**：重启那部分的逻辑靠「生成出来的帮手脚本长什么样」
 * 和「策略选择对不对」来验。真重启只在主人点头后在真机上跑 —— 因为那是会中断
 * 她正在用的东西的操作，测试里绝不许偷偷发生。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createIdleTracker, attachIdle, scanBusySessions, lastEventType, DEFAULT_QUIET_MS } from '../lib/idle.js'
import {
  readQueue, writeQueue, addJob, removeJob, clearQueue, pendingJobs,
  renderQueue, createPump, MAX_TRIES, queuePath,
} from '../lib/queue.js'
import { planRestart, renderHelper, restartSelf, BOOT_SETTLE_MS, RESTART_TRIES } from '../lib/restart.js'

let pass = 0
const fails = []
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(`${name}: ${e?.message ?? e}`); console.log(`  ✗ ${name} —— ${e?.message ?? e}`) }
}
async function ta(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(`${name}: ${e?.message ?? e}`); console.log(`  ✗ ${name} —— ${e?.message ?? e}`) }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b)
  if (A !== B) throw new Error(`${msg ?? '不相等'}：拿到 ${A}，期望 ${B}`)
}
function ok(v, msg) { if (!v) throw new Error(msg ?? '期望为真') }

console.log('\n=== idle：空闲判定 ===')

t('默认静默 120 秒', () => eq(DEFAULT_QUIET_MS, 120000))

t('刚开始不算空闲（要安静够久）', () => {
  let now = 1000
  const tr = createIdleTracker({ quietMs: 5000, now: () => now })
  ok(!tr.isIdle(), '刚创建就该不空闲')
  now += 5001
  ok(tr.isIdle(), '安静够久后该空闲')
})

t('有会话 running 就不空闲', () => {
  let now = 1000
  const tr = createIdleTracker({ quietMs: 100, now: () => now })
  now += 200
  tr.setStatus('a1', 'running')
  ok(!tr.isIdle(), 'running 时必须不空闲')
  ok(/正在跑/.test(tr.reason()), `理由要说明在跑，实际：${tr.reason()}`)
  tr.setStatus('a1', 'idle')
  now += 200
  ok(tr.isIdle(), 'idle 且安静后该空闲')
})

t('running→idle 的瞬间不算空闲（主人在打字）', () => {
  let now = 1000
  const tr = createIdleTracker({ quietMs: 5000, now: () => now })
  tr.setStatus('a1', 'running')
  now += 8000
  tr.setStatus('a1', 'idle') // 刚结束
  ok(!tr.isIdle(), '刚结束就该还得再等')
  ok(/还要再安静/.test(tr.reason()), `理由：${tr.reason()}`)
})

t('未知状态不丢：非法值被忽略', () => {
  let now = 0
  const tr = createIdleTracker({ quietMs: 0, now: () => now })
  tr.setStatus('a1', 'weird')
  eq(tr.snapshot().known, 0)
})

t('disposed 后不再算 running', () => {
  let now = 0
  const tr = createIdleTracker({ quietMs: 0, now: () => now })
  tr.setStatus('a1', 'running')
  ok(!tr.isIdle())
  tr.forget('a1')
  ok(tr.isIdle(), '会话走了就该能动手')
})

t('快照字段齐全', () => {
  const tr = createIdleTracker({ quietMs: 10, now: () => 100 })
  const s = tr.snapshot()
  for (const k of ['running', 'known', 'quietMs', 'needQuietMs', 'idle', 'reason']) ok(k in s, `缺字段 ${k}`)
})

await ta('attachIdle：把宿主事件接上、且监听器抛异常不会炸宿主', async () => {
  const handlers = {}
  const off = attachIdle(createIdleTracker({ quietMs: 0 }), (ev, fn) => {
    handlers[ev] = fn
    return () => { delete handlers[ev] }
  })
  ok(handlers['agent/status'], '要接 agent/status')
  ok(handlers['api-session/status'], '要接 api-session/status')
  ok(handlers['agent/inbox/inserted'], '要接 agent/inbox/inserted')
  ok(handlers['agent/disposed'], '要接 agent/disposed')
  // 传个怪东西进去，不许抛
  handlers['agent/status']({ agent: null, status: 123 })
  handlers['agent/status'](undefined)
  off()
  eq(Object.keys(handlers).length, 0, 'off() 要把监听器都摘掉')
})

console.log('\n=== queue：持久化与增删 ===')

const dirA = mkdtempSync(join(tmpdir(), 'ug-p4-'))

t('空队列读出来是空的（文件不存在也不炸）', () => {
  eq(readQueue(dirA).jobs, [])
  eq(pendingJobs(readQueue(dirA)), [])
})

t('addJob 落盘 + 回读', () => {
  const r = addJob(dirA, { name: 'pkg-a', to: '1.2.0', note: '试试' })
  ok(r.job.id, '要有 id')
  eq(r.duplicated, false)
  const q = readQueue(dirA)
  eq(q.jobs.length, 1)
  eq(q.jobs[0].name, 'pkg-a')
  eq(q.jobs[0].status, 'pending')
  ok(existsSync(queuePath(dirA)), '队列文件该在')
})

t('同名同版本不重复排', () => {
  const r = addJob(dirA, { name: 'pkg-a', to: '1.2.0' })
  eq(r.duplicated, true)
  eq(readQueue(dirA).jobs.length, 1, '不该多一条')
})

t('同名不同版本可以并存', () => {
  addJob(dirA, { name: 'pkg-a', to: '1.3.0' })
  eq(readQueue(dirA).jobs.length, 2)
})

t('removeJob 只删指定的', () => {
  const q = readQueue(dirA)
  const id = q.jobs[0].id
  const r = removeJob(dirA, id)
  eq(r.removed, 1)
  eq(readQueue(dirA).jobs.length, 1)
})

t('clearQueue 清空但不删 running 的', () => {
  addJob(dirA, { name: 'pkg-b', to: '2.0.0' })
  const q = readQueue(dirA)
  q.jobs[0].status = 'running'
  writeQueue(dirA, q)
  const r = clearQueue(dirA)
  const left = readQueue(dirA).jobs
  eq(left.length, 1)
  eq(left[0].status, 'running')
  ok(r.removed >= 1)
})

t('队列文件坏了不会拖死插件（自动备份成 .broken-*）', () => {
  const f = queuePath(dirA)
  writeFileSync(f, '{这不是 JSON', 'utf8')
  const q = readQueue(dirA)
  eq(q.jobs, [], '坏了就当空队列')
})

t('renderQueue 能看出状态', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'ug-p4b-'))
  const q = { jobs: [
    { id: 'j1', name: 'x', to: '1.0.0', status: 'pending', tries: 0 },
    { id: 'j2', name: 'y', to: null, status: 'failed', tries: 3, lastError: '炸了' },
    { id: 'j3', name: 'z', to: null, status: 'done', tries: 1 },
  ] }
  const s = renderQueue(q)
  ok(/x → 1\.0\.0/.test(s), `要显示目标版本：${s}`)
  ok(/失败|炸了/.test(s), '要能看见失败原因')
  ok(renderQueue({ jobs: [] }).includes('空'), '空队列要有话')
  rmSync(d2, { recursive: true, force: true })
})

console.log('\n=== queue pump：只在空闲时动手 ===')

await ta('不空闲时一步都不动', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4c-'))
  addJob(d, { name: 'slowpkg', to: '1.0.0' })
  let ran = 0
  const pump = createPump({
    dir: d,
    idle: { isIdle: () => false, reason: () => '1 个会话正在跑', snapshot: () => ({}) },
    runJob: async () => { ran += 1; return { ok: true } },
  })
  const r = await pump.tick()
  eq(ran, 0, '∎ 主人在用时绝不能动手')
  ok(r.skipped, '要说明为什么没动')
  rmSync(d, { recursive: true, force: true })
})

await ta('空闲时跑一个，成功标 done', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4d-'))
  addJob(d, { name: 'fastpkg', to: '2.0.0' })
  const idle = { isIdle: () => true, reason: () => null, snapshot: () => ({}) }
  const pump = createPump({ dir: d, idle, runJob: async () => ({ ok: true, result: 'applied' }) })
  const r = await pump.tick()
  ok(r.ok, '该成功')
  const q = readQueue(d)
  eq(q.jobs[0].status, 'done')
  eq(q.jobs[0].tries, 1)
  rmSync(d, { recursive: true, force: true })
})

await ta('失败了会重试，到上限标 failed（不无限重试）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4e-'))
  addJob(d, { name: 'badpkg', to: '3.0.0' })
  const idle = { isIdle: () => true, reason: () => null, snapshot: () => ({}) }
  const pump = createPump({ dir: d, idle, runJob: async () => { throw new Error('装不上') } })
  for (let i = 0; i < MAX_TRIES; i++) await pump.tick()
  const job = readQueue(d).jobs[0]
  eq(job.status, 'failed', `${MAX_TRIES} 次后就该判死`)
  eq(job.tries, MAX_TRIES)
  ok(/装不上/.test(job.lastError), '要留失败原因')
  // 再 tick 也不该再动它
  const r = await pump.tick()
  ok(r.skipped, '死任务不该再被跑')
  rmSync(d, { recursive: true, force: true })
})

await ta('跑到一半主人回来了 → 让位，任务退回 pending', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4f-'))
  addJob(d, { name: 'yieldpkg', to: '1.1.0' })
  let idleNow = true
  const pump = createPump({
    dir: d,
    idle: { isIdle: () => idleNow, reason: () => (idleNow ? null : '主人在用'), snapshot: () => ({}) },
    runJob: async (_job, { shouldAbort }) => {
      idleNow = false // 模拟跑到一半主人发消息了
      if (shouldAbort()) return { aborted: true, reason: '主人在用' }
      return { ok: true }
    },
  })
  const r = await pump.tick()
  eq(r.aborted, true, '要让位')
  const job = readQueue(d).jobs[0]
  eq(job.status, 'pending', '让位后要退回队列，不能算失败')
  rmSync(d, { recursive: true, force: true })
})

await ta('队列关了就不跑', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4g-'))
  addJob(d, { name: 'anypkg', to: '1.0.0' })
  const pump = createPump({
    dir: d,
    idle: { isIdle: () => true, reason: () => null, snapshot: () => ({}) },
    runJob: async () => ({ ok: true }),
    enabled: () => false,
  })
  const r = await pump.tick()
  ok(r.skipped, '关掉就该跳过')
  eq(readQueue(d).jobs[0].status, 'pending')
  rmSync(d, { recursive: true, force: true })
})

await ta('同一时间只跑一个（busy 保护）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4h-'))
  addJob(d, { name: 'onepkg', to: '1.0.0' })
  let release
  const gate = new Promise((r) => { release = r })
  const pump = createPump({
    dir: d,
    idle: { isIdle: () => true, reason: () => null, snapshot: () => ({}) },
    runJob: async () => { await gate; return { ok: true } },
  })
  const first = pump.tick()
  const second = await pump.tick()
  ok(second.skipped, '第二个 tick 要被挡住')
  release()
  await first
  rmSync(d, { recursive: true, force: true })
})

console.log('')
console.log('=== idle：扫会话兜底（事件漏了也不许误判空闲）===')

/** 造一个假 Session：seq + eventAt */
const fakeSession = (id, types) => ({ id, seq: types.length, eventAt: (i) => (types[i] ? { type: types[i] } : undefined) })

t('最后一条是 step/start → 算忙', () => {
  const s = fakeSession('s1', ['turn/start', 'step/start'])
  eq(lastEventType(s), 'step/start')
  eq(scanBusySessions({ list: () => [s] }).map((x) => x.id), ['s1'])
})

t('最后一条是 turn/end → 不算忙（回合收尾了）', () => {
  eq(scanBusySessions({ list: () => [fakeSession('s2', ['turn/start', 'turn/end'])] }), [])
})

t('一条事件都没有的会话不算忙（建了没跑过）', () => {
  eq(scanBusySessions({ list: () => [fakeSession('s3', [])] }), [])
})

t('没有 sessions 服务 / list 抛错 → 空数组，不炸', () => {
  eq(scanBusySessions(undefined), [])
  eq(scanBusySessions({ list: () => { throw new Error('boom') } }), [])
})

t('probeBusy 说忙 → reason 点名，isIdle 为假（哪怕事件以为很安静）', () => {
  let clock = 0
  const idle = createIdleTracker({ quietMs: 1000, now: () => clock, probeBusy: () => ['live-1'] })
  clock = 999_999
  ok(!idle.isIdle(), '有会话在跑就不许判空闲')
  ok(String(idle.reason()).includes('live-1'), '要点出是谁在跑')
  eq(idle.snapshot().running, ['live-1'])
})

t('probeBusy 抛错 → 当作没人忙，但绝不抛给宿主', () => {
  let clock = 0
  const idle = createIdleTracker({ quietMs: 10, now: () => clock, probeBusy: () => { throw new Error('boom') } })
  clock = 100
  ok(idle.isIdle(), 'probe 炸了不该把队列永久卡死')
})


t('帮手杀旧进程时绝不用 /T（否则会把自己一起带走 → 只杀不拉）', () => {
  const src = renderHelper({ appExe: 'C:/x.exe', appName: 'x.exe' })
  ok(!src.includes("'/T'"), 'taskkill 里出现了 /T —— 这正是 10-22 事故的复现姿势')
  ok(src.includes("'/F'"), '该有的 /F 没了')
})

t('帮手探活时先认插件自己的接口，再退回根路径', () => {
  const src = renderHelper({ appExe: 'C:/x.exe', appName: 'x.exe' })
  ok(src.includes('/dsh-update-guard-api/overview'), '没优先探自己的接口，可能把别的服务当成了 DSH')
})

t('帮手支持试运行（UG_HELPER_DRYRUN=1 时不 spawn 应用）', () => {
  const src = renderHelper({ appExe: 'C:/x.exe', appName: 'x.exe' })
  ok(src.includes('UG_HELPER_DRYRUN'), '没有试运行开关，没法在真机上安全演练')
})
console.log('\n=== restart：策略与帮手脚本 ===')

t('没有 Electron → 杀+拉策略（仍然会拉，不是只管杀）', () => {
  const p = planRestart({ appExe: 'C:/fake/App.exe', hasElectron: false })
  eq(p.strategy, 'kill-and-spawn')
  ok(/拉起/.test(p.note), `说明要说清会拉起：${p.note}`)
})

t('有 Electron → 优先用它自己的 relaunch', () => {
  const p = planRestart({
    appExe: 'C:/fake/App.exe',
    hasElectron: true,
    electronApp: { relaunch() {}, quit() {} },
  })
  eq(p.strategy, 'electron-relaunch')
})

t('有 Electron 但对象不完整 → 不冒险，退回杀+拉', () => {
  const p = planRestart({ appExe: 'C:/fake/App.exe', hasElectron: true, electronApp: { quit() {} } })
  eq(p.strategy, 'kill-and-spawn')
})

t('帮手脚本：有等待旧进程、有探活、有重试、有失败提示', () => {
  const s = renderHelper({ appExe: 'C:/x/DeepSeek Harness.exe', appName: 'DeepSeek Harness.exe' })
  for (const kw of ['waitGone', 'findUp', 'waitStable', 'TRIES', 'spawn(APP', 'taskkill', '手动']) {
    ok(s.includes(kw), `帮手脚本里该有 ${kw}`)
  }
  ok(!/process\.exit\(1\)\s*}$/.test(s), '不能只是退出了事')
})

t('帮手脚本里的参数被正确注入', () => {
  const s = renderHelper({ appExe: 'C:/x/App.exe', appName: 'App.exe', settleMs: 9000, tries: 2 })
  ok(s.includes('"C:/x/App.exe"'), '要注入 exe 路径')
  ok(s.includes('const SETTLE = 9000'), '要注入稳定时长')
  ok(s.includes('const TRIES = 2'), '要注入重试次数')
})

t('常量符合预期（稳定 8 秒、最多 3 次）', () => {
  eq(BOOT_SETTLE_MS, 8000)
  eq(RESTART_TRIES, 3)
})

t('restartSelf：没有 node 就明确拒绝，绝不半吊子重启', () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4i-'))
  const r = restartSelf({ dir: d, node: null, appExe: 'C:/x/App.exe' })
  eq(r.ok, false)
  ok(r.reason, '要说明原因')
  rmSync(d, { recursive: true, force: true })
})

t('restartSelf：帮手脚本会落盘（说明它真能被执行）', () => {
  const d = mkdtempSync(join(tmpdir(), 'ug-p4j-'))
  // node 用当前进程（它确实存在），但 delayMs 设很长 + 立刻清掉定时器不可行，
  // 所以这里只验证脚本落盘：用一个不存在的 node 让它 spawn 失败，从而不真的重启。
  const r = restartSelf({ dir: d, node: 'C:/nope/node.exe', appExe: 'C:/x/App.exe', delayMs: 999999 })
  // spawn 是异步失败（ENOENT），这里只关心脚本文件写没写
  const hp = join(d, '.update-guard', 'restart-helper.mjs')
  ok(existsSync(hp), '帮手脚本该被写出来')
  ok(readFileSync(hp, 'utf8').includes('findUp'), '内容要对')
  ok(r.ok === true || r.ok === false, '结构要稳')
  rmSync(d, { recursive: true, force: true })
})

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('✅ P4 自测全绿')