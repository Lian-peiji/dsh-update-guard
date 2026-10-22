/**
 * test/webapi.mjs —— 管理台接口的回归测试
 *
 * 测什么（按"最容易把主人坑到"的顺序）：
 *   ① 只认本机 —— 绑了 0.0.0.0 的时候不能让局域网看更新历史
 *   ② 只读 —— POST/DELETE 一律 405
 *   ③ 病历文件名不许带路径 —— `../package.json` 这种必须被挡
 *   ④ 数据源炸了只影响那一块，不能 500 整个接口
 *   ⑤ 字段形状 —— 客户端按这些字段渲染，改了要同步
 *
 * 全部用假的 req/res，不启真 HTTP 服务器（快，也不会占端口）。
 */
import { createApiHandler, buildSources, ROUTE, hostIsLoopback } from '../lib/webapi.js'

let pass = 0, failed = 0
const ok = (c, m) => { if (c) { pass++ } else { failed++; console.error('  ✗ ' + m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n      实际=${JSON.stringify(a)}\n      期望=${JSON.stringify(b)}`)

/** 假 req */
function req(url, { method = 'GET', host = '127.0.0.1:8437' } = {}) {
  return { url, method, headers: { host } }
}

/** 假 res —— 收集 writeHead 的 code 和 end 的 body */
function res() {
  const out = { code: 0, headers: null, body: null }
  out.writeHead = (code, headers) => { out.code = code; out.headers = headers }
  out.end = (text) => { out.body = text }
  out.json = () => { try { return JSON.parse(out.body) } catch { return null } }
  return out
}

/** 跑一次 handler，返回 { code, json } */
async function call(handler, url, opts) {
  const r = res()
  await handler(req(url, opts), r)
  return { code: r.code, json: r.json(), headers: r.headers }
}

// ── 假数据源 ────────────────────────────────────────────────────────────
const fakeMemory = {
  read: ({ name, limit } = {}) => {
    const all = [
      { at: '2026-10-22T07:00:00.000Z', name: 'dsh-meme', kind: 'update', from: '0.1.55', to: '0.1.56', result: 'applied', reason: '低风险' },
      { at: '2026-10-21T07:00:00.000Z', name: 'dsh-pocket', kind: 'update', from: '2.11.0', to: '2.12.0', result: 'rolled-back', reason: '加载失败' },
    ]
    let out = all
    if (name) out = out.filter((r) => r.name === name)
    return out.slice(0, limit ?? 200)
  },
  stats: () => ({ total: 2, applied: 1, rolledBack: 1, refused: 0 }),
  listErrors: () => [
    {
      file: 'J:/fake/errors/2026-10-21-pocket-401.md',
      filename: '2026-10-21-pocket-401.md',
      meta: {
        title: 'pocket 反代 401', packages: ['dsh-pocket'], symptoms: ['401', '白屏'],
        severity: 'high', createdAt: '2026-10-21T08:00:00.000Z', lastSeenAt: '2026-10-22T01:00:00.000Z', occurrences: 3,
      },
      body: '## 症状\n远程访问全崩',
    },
  ],
  searchErrors: ({ keywords = [], limit = 5 } = {}) => {
    const kw = String(keywords[0] ?? '').toLowerCase()
    const all = fakeMemory.listErrors()
    if (!kw) return all.slice(0, limit)
    return all.filter((d) =>
      String(d.meta.title).toLowerCase().includes(kw)
      || d.meta.packages.some((p) => p.toLowerCase().includes(kw))
      || d.meta.symptoms.some((s) => s.toLowerCase().includes(kw)))
      .slice(0, limit)
  },
}

const fakeSources = buildSources({
  memory: fakeMemory,
  profile: () => ({ dir: '/fake/profile', patchedDeps: { 'dsh-pocket@2.12.0': 'patches/dsh-pocket@2.12.0.patch' } }),
  scanPatches: () => [
    {
      key: 'dsh-pocket@2.12.0', name: 'dsh-pocket', version: '2.12.0', registered: true, hasPatch: true,
      files: ['lib/proxy.mjs'], stats: { files: 1, additions: 5, deletions: 1 },
      intent: '修 401', issue: '远程访问永久 401', retireWhen: '上游修好', issues: [], notes: [],
    },
    {
      key: 'dsh-fish-memory@1.2.1', name: 'dsh-fish-memory', version: '1.2.1', registered: false, hasPatch: true,
      files: ['lib/index.js'], stats: null, intent: null, issue: null, retireWhen: null,
      issues: ['磁盘上有 .patch 但 package.json 没登记 → 这个补丁永远不会被应用（静默失效）'],
      notes: ['没有 intent.md → 半年后没人记得这补丁为什么打'],
    },
  ],
  listBackups: () => [{ stamp: '2026-10-22T06-52-41-754Z', name: 'dsh-meme', version: '0.1.55' }],
})

const handler = createApiHandler(fakeSources)

// ══ ① 本机限制 ═══════════════════════════════════════════════════════════
console.log('\n① 只认本机')
ok(hostIsLoopback({ headers: { host: '127.0.0.1:8437' } }) === true, '127.0.0.1 算本机')
ok(hostIsLoopback({ headers: { host: 'localhost:8437' } }) === true, 'localhost 算本机')
ok(hostIsLoopback({ headers: { host: '[::1]:8437' } }) === true, '::1 算本机')
ok(hostIsLoopback({ headers: { host: '192.168.1.9:8437' } }) === false, '局域网 IP 不算本机')
ok(hostIsLoopback({ headers: {} }) === true, '没 Host 头当本机（同 dsh-meme 的判定）')
{
  const r = await call(handler, ROUTE + '/overview', { host: '192.168.1.9:8437' })
  eq(r.code, 403, '非本机请求被 403')
  ok(r.json && r.json.ok === false, '403 带 ok:false')
}

// ══ ② 只读 ═══════════════════════════════════════════════════════════════
console.log('\n② 只读')
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const r = await call(handler, ROUTE + '/overview', { method: m })
  eq(r.code, 405, m + ' 被 405')
}

// ══ ③ 目录穿越 ═══════════════════════════════════════════════════════════
console.log('\n③ 病历文件名不许带路径')
for (const bad of ['../package.json', '..\\win.ini', 'a/b.md', '/etc/passwd']) {
  const r = await call(handler, ROUTE + '/error?file=' + encodeURIComponent(bad))
  eq(r.code, 400, `${bad} 被 400 挡下`)
}

// ══ ④ 正常读取 ═══════════════════════════════════════════════════════════
console.log('\n④ overview 字段形状')
{
  const r = await call(handler, ROUTE + '/overview')
  eq(r.code, 200, 'overview 200')
  ok(r.json.ok === true, 'overview ok:true')
  eq(r.json.ledger.length, 2, 'overview 带 2 条档案')
  eq(r.json.stats.total, 2, 'overview 带统计')
  eq(r.json.errors.length, 1, 'overview 带 1 条病历')
  eq(r.json.patches.length, 2, 'overview 带 2 个补丁')
  eq(r.json.backups.length, 1, 'overview 带 1 个备份')
  // ⚠️ 绝对路径绝不能漏到浏览器
  const errStr = JSON.stringify(r.json.errors)
  ok(!errStr.includes('J:/fake'), '病历列表不泄露本机绝对路径')
}

console.log('\n⑤ 各子接口')
{
  const r = await call(handler, ROUTE + '/ledger?name=dsh-pocket')
  eq(r.code, 200, 'ledger 200')
  eq(r.json.items.length, 1, 'ledger 按包名过滤')
  eq(r.json.items[0].result, 'rolled-back', 'ledger 保留 result 字段')
}
{
  const r = await call(handler, ROUTE + '/errors?q=401')
  eq(r.json.items.length, 1, 'errors 按关键词搜到')
}
{
  const r = await call(handler, ROUTE + '/error?file=2026-10-21-pocket-401.md')
  eq(r.code, 200, 'error 详情 200')
  ok(r.json.doc.body.includes('远程访问全崩'), 'error 详情带正文')
  eq(r.json.doc.file, '2026-10-21-pocket-401.md', 'error 详情只给文件名')
}
{
  const r = await call(handler, ROUTE + '/error?file=nope.md')
  eq(r.code, 404, '不存在的病历 404')
}
{
  const r = await call(handler, ROUTE + '/patches')
  eq(r.json.items.length, 2, 'patches 2 个')
  eq(r.json.items[1].issues.length, 1, 'patches 带 issues')
  eq(r.json.items[1].notes.length, 1, 'patches 带 notes（缺备注 ≠ 有问题，分开传）')
  eq(r.json.items[0].notes.length, 0, '正常补丁 notes 为空')
}
{
  const r = await call(handler, ROUTE + '/backups')
  eq(r.json.items.length, 1, 'backups 1 个')
}
{
  const r = await call(handler, ROUTE + '/nonsense')
  eq(r.code, 404, '未知子接口 404')
}

// ══ ⑤ 数据源炸了 ═════════════════════════════════════════════════════════
console.log('\n⑤ 数据源炸了只影响那一块')
{
  const broken = createApiHandler(buildSources({
    memory: {
      read: () => { throw new Error('ledger 文件坏了') },
      stats: () => { throw new Error('统计炸了') },
      listErrors: () => [],
      searchErrors: () => [],
    },
    profile: () => { throw new Error('找不到 profile') },
    scanPatches: () => { throw new Error('扫不了') },
    listBackups: () => { throw new Error('列不出') },
  }))
  const r = await call(broken, ROUTE + '/overview')
  eq(r.code, 200, '数据源全炸时 overview 仍 200')
  eq(r.json.ledger, [], '炸了的档案退化成空数组')
  eq(r.json.stats, {}, '炸了的统计退化成空对象')
  eq(r.json.patches, [], '炸了的补丁退化成空数组')
}

// ══ ⑥ 数据源缺失 ═════════════════════════════════════════════════════════
console.log('\n⑥ 数据源缺失不崩')
{
  const empty = createApiHandler({})
  const r = await call(empty, ROUTE + '/overview')
  eq(r.code, 200, '没有数据源也 200')
  eq(r.json.ledger, [], '没有数据源 → 空数组')
}

console.log(`\n${failed === 0 ? '✅' : '❌'} webapi：${pass} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
