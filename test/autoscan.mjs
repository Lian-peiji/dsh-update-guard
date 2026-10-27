/**
 * test/autoscan.mjs —— 「插件自己巡场」的自测（主人 m06608 / m06618）
 *
 * 这个文件只测纯逻辑：不联网、不碰真 profile。
 *   · autoScanIntervalMs —— 小时换毫秒，非法值不许炸
 *   · pickEnqueueCandidates —— 谁能排、谁不能排（去重 / 没有更新 / 已有任务 / 上限）
 *   · createAutoScan —— 一轮巡场的编排：扫描 → 排队 → 记账；失败不许把循环搞死
 */

import { autoScanIntervalMs, pickEnqueueCandidates, createAutoScan, DEFAULT_AUTO_SCAN_HOURS, DEFAULT_ENQUEUE_MAX } from '../lib/autoscan.js'

let pass = 0
let failed = 0
const fails = []

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { failed++; fails.push(name); console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`) }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}
function group(t) { console.log(`\n── ${t} ──`) }

// ═══════════════════════════════════════════════════════════════════════════
group('autoScanIntervalMs')

eq('6 小时 = 21600000ms', autoScanIntervalMs(6), 21_600_000)
eq('1 小时 = 3600000ms', autoScanIntervalMs(1), 3_600_000)
eq('小数也行（1.5 小时）', autoScanIntervalMs(1.5), 5_400_000)
eq('0 → 退回默认', autoScanIntervalMs(0), DEFAULT_AUTO_SCAN_HOURS * 3_600_000)
eq('负数 → 退回默认', autoScanIntervalMs(-5), DEFAULT_AUTO_SCAN_HOURS * 3_600_000)
eq('字符串数字认', autoScanIntervalMs('3'), 10_800_000)
eq('乱七八糟 → 退回默认', autoScanIntervalMs('abc'), DEFAULT_AUTO_SCAN_HOURS * 3_600_000)
eq('undefined → 退回默认', autoScanIntervalMs(undefined), DEFAULT_AUTO_SCAN_HOURS * 3_600_000)

// ═══════════════════════════════════════════════════════════════════════════
group('pickEnqueueCandidates：谁能排')

{
  const updates = [
    { name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true },
    { name: 'b', current: '1.0.0', latest: '1.1.0', bump: 'minor', hasUpdate: true },
    { name: 'c', current: '2.0.0', latest: '2.0.0', bump: 'none', hasUpdate: false },
  ]
  const r = pickEnqueueCandidates({ updates, existing: [], max: 10 })
  eq('只挑有更新的', r.candidates.map((x) => x.name), ['b', 'a'])
  ok('没更新的进 skipped 并说明原因', r.skipped.some((s) => s.name === 'c' && /没有更新|最新/.test(s.why)))
}

{
  const r = pickEnqueueCandidates({
    updates: [{ name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true }],
    existing: [{ name: 'a', status: 'pending' }],
  })
  eq('已在队列里的不重复排', r.candidates, [])
  ok('并说明「已经在队列里」', r.skipped.some((s) => s.name === 'a' && /已经在队列里/.test(s.why)))
}

{
  const r = pickEnqueueCandidates({
    updates: [
      { name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true },
      { name: 'b', current: '1.0.0', latest: '1.0.2', bump: 'patch', hasUpdate: true },
      { name: 'c', current: '1.0.0', latest: '1.0.3', bump: 'patch', hasUpdate: true },
    ],
    existing: [],
    max: 2,
  })
  eq('上限 2 只排两个', r.candidates.length, 2)
  ok('超出的进 skipped 且提示下一轮', r.skipped.some((s) => /下一轮/.test(s.why)))
}

{
  const r = pickEnqueueCandidates({
    updates: [
      { name: 'x', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true },
      { name: 'y', current: '1.0.0', latest: '2.0.0', bump: 'major', hasUpdate: true },
      { name: 'z', current: '1.0.0', latest: '1.1.0', bump: 'minor', hasUpdate: true },
    ],
    existing: [],
    max: 2,
  })
  eq('大版本优先（上限 2 → major+minor）', r.candidates.map((c) => c.name), ['y', 'z'])
}

{
  const r = pickEnqueueCandidates({ updates: [], existing: [] })
  eq('空输入 → 空候选', r.candidates, [])
  eq('空输入 → skipped 也空', r.skipped, [])
}

{
  const r = pickEnqueueCandidates({
    updates: [
      { name: '', latest: '1.0.1', hasUpdate: true },
      { name: 'ok', current: '1.0.0', latest: '1.0.1', hasUpdate: true },
    ],
  })
  eq('没有包名的丢掉', r.candidates.map((c) => c.name), ['ok'])
}

{
  const r = pickEnqueueCandidates({
    updates: [
      { name: 'dup', current: '1.0.0', latest: '1.0.1', hasUpdate: true },
      { name: 'dup', current: '1.0.0', latest: '1.0.1', hasUpdate: true },
    ],
  })
  eq('重复的只留一个', r.candidates.length, 1)
  ok('重复的记 skipped', r.skipped.some((s) => /重复/.test(s.why)))
}

{
  const r = pickEnqueueCandidates({
    updates: [{ name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch' }], // 没给 hasUpdate
  })
  eq('有 bump 时按 bump 推断有更新', r.candidates.map((c) => c.name), ['a'])
}

{
  const r = pickEnqueueCandidates({ updates: [], existing: [], max: 0 })
  eq('max=0 一个都不排', r.candidates, [])
}

// ═══════════════════════════════════════════════════════════════════════════
group('createAutoScan：一轮巡场')

// 🔴 2026-10-25：scan() 卡住时 running 会永久为 true，巡场从此静默死掉。
{
  let scans = 0
  const s = createAutoScan({
    // 第一次永不返回（模拟 registry 抽风），第二次正常
    scan: async () => { scans++; if (scans === 1) return new Promise(() => {}); return [] },
    existing: () => [],
    enqueue: async () => {},
    timeoutMs: 50,
  })
  const r1 = await s.tick({ reason: 'first' })
  ok('卡住的那轮要报超时，不能永远挂着', String(r1.error ?? '').includes('超时'), `实际：${JSON.stringify(r1)}`)
  const r2 = await s.tick({ reason: 'second' })
  ok('超时后 running 必须放掉，下一轮还能跑', r2.reason === 'second' && !r2.error && !r2.skipped?.length, `被卡成 busy 了：${JSON.stringify(r2)}`)
}

{
  const added = []
  const logs = []
  const s = createAutoScan({
    now: () => 1000,
    scan: async () => [
      { name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true },
      { name: 'b', current: '1.0.0', latest: '1.0.0', bump: 'none', hasUpdate: false },
    ],
    existing: () => [],
    enqueue: async (c) => { added.push(c.name) },
    log: (m) => logs.push(m),
  })
  const r = await s.tick({ reason: 'test' })
  eq('排进去的只有一个', added, ['a'])
  eq('结果带 reason 与时间', [r.reason, r.at], ['test', 1000])
  ok('结果记了扫到几个', r.found === 2)
  ok('有日志', logs.length > 0)
  eq('last() 拿到同一份', s.last(), r)
}

{
  let calls = 0
  const s = createAutoScan({
    scan: async () => { calls++; return [] },
    existing: () => [],
    enqueue: async () => {},
  })
  await s.tick()
  await s.tick()
  eq('没更新时也会跑扫描', calls, 2)
}

{
  // 扫描抛错：不许把循环搞死，也不许排任何东西
  const added = []
  const s = createAutoScan({
    scan: async () => { throw new Error('registry 挂了') },
    existing: () => [],
    enqueue: async (c) => { added.push(c.name) },
  })
  const r = await s.tick()
  ok('出错被记进结果', /registry 挂了/.test(String(r.error)))
  eq('出错时不排队', added, [])
  ok('isRunning 复位', s.isRunning() === false)
}

{
  // enqueue 抛错：其余候选照常排，失败的那个进 skipped
  const added = []
  const s = createAutoScan({
    scan: async () => [
      { name: 'bad', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true },
      { name: 'good', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true },
    ],
    existing: () => [],
    enqueue: async (c) => { if (c.name === 'bad') throw new Error('磁盘满了'); added.push(c.name) },
  })
  const r = await s.tick()
  eq('好的那个照样排', added, ['good'])
  ok('坏的那个记进 skipped', r.skipped.some((x) => x.name === 'bad' && /磁盘满了/.test(x.why)))
}

{
  // 上一轮没跑完就 tick：直接跳过，不叠罗汉
  let release
  const gate = new Promise((res) => { release = res })
  let scans = 0
  const s = createAutoScan({
    scan: async () => { scans++; await gate; return [] },
    existing: () => [],
    enqueue: async () => {},
  })
  const first = s.tick()
  const second = await s.tick()
  eq('第二轮被跳过', second.skipped, 'busy')
  release()
  await first
  eq('扫描只真跑了一次', scans, 1)
}

{
  const s = createAutoScan({
    scan: async () => [{ name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', hasUpdate: true }],
    existing: () => [{ name: 'a' }],
    enqueue: async () => { throw new Error('不该被调用') },
  })
  const r = await s.tick()
  eq('已在队列里 → 一个都不排', r.added, [])
}

{
  let created = null
  try { created = createAutoScan({ enqueue: async () => {} }) } catch (e) { created = e }
  ok('缺 scan 直接报错', created instanceof Error && /scan/.test(created.message))
}

{
  // start() 返回 stop()，且定时器不拖住进程（unref 过）
  const s = createAutoScan({ scan: async () => [], existing: () => [], enqueue: async () => {} })
  const stop = s.start({ intervalMs: 60_000 })
  ok('start 返回函数', typeof stop === 'function')
  stop()
  ok('stop 后不抛', true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failed === 0 ? '✅' : '❌'} autoscan：${pass} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}