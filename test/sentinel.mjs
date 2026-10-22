/**
 * test/sentinel.mjs —— 市场哨兵（不需要网络、不需要模型）
 *
 * 要证明的两句话：
 *   ① 市场那边出事时，我们能从 pnpm 输出里认出是哪一类坑、涉及哪个包；
 *   ② profile 被改了之后，我们能说出「谁变了、补丁表变了没」。
 *
 * 这里全部用临时目录造假 profile，不碰真环境。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  scanInstallLog, INSTALL_LOG_PATTERNS,
  fingerprintProfile, diffFingerprint, renderDiff, packageFromPatchKey,
  createSentinel,
} from '../lib/sentinel.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fail++
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}
async function ta(name, fn) {
  try {
    const r = await fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    fail++
    console.log('  ✗ ' + name + ' —— ' + (e?.message ?? e))
  }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) throw new Error(`${msg ?? '不相等'}：拿到 ${sa}，期望 ${sb}`)
}

// ── 造一个假 profile ─────────────────────────────────────────────────────────
function makeProfile({ deps = {}, patched = {}, patches = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ug-sentinel-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: deps }, null, 2))
  const ws = ['packages:', '  - .', '']
  if (Object.keys(patched).length > 0) {
    ws.push('patchedDependencies:')
    for (const [k, v] of Object.entries(patched)) ws.push(`  ${k}: ${v}`)
  }
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), ws.join('\n'))
  if (Object.keys(patches).length > 0) {
    mkdirSync(join(dir, 'patches'), { recursive: true })
    for (const [name, body] of Object.entries(patches)) writeFileSync(join(dir, 'patches', name), body)
  }
  for (const [pkg, version] of Object.entries(files)) {
    const p = join(dir, 'node_modules', pkg)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: pkg, version }, null, 2))
  }
  return dir
}

console.log('\n=== 一、pnpm 输出识别 ===')

t('认出「补丁没被用上」并抠出补丁 key', () => {
  const text = ` ERR_PNPM_UNUSED_PATCH  The following patches were not used: dsh-fish-memory@1.2.1\n`
  const r = scanInstallLog(text)
  eq(r.hits.map((h) => h.id).includes('unused-patch'), true)
  eq(r.patches, ['dsh-fish-memory@1.2.1'])
})

t('两条 unused-patch 只报一次（不刷屏）', () => {
  const text = 'The following patches were not used: a@1.0.0\nERR_PNPM_UNUSED_PATCH\n'
  const r = scanInstallLog(text)
  const ids = r.hits.map((h) => h.id)
  eq(ids.filter((x) => x.startsWith('unused-patch')).length, 2, 'unused-patch 与 unused-patch-code 是两个 id')
})

t('同一段里重复出现 generic 错误只算一次', () => {
  const text = 'ERR_PNPM_FOO foo\nERR_PNPM_FOO foo\n'
  const r = scanInstallLog(text)
  eq(r.hits.filter((h) => h.id === 'generic-pnpm-error').length, 1)
})

t('认出 ambiguous-install', () => {
  const r = scanInstallLog('更新前的构建未能验证恢复（{"code":"ambiguous-install"}）')
  eq(r.hits[0].id, 'ambiguous-install')
  eq(r.hits[0].severity, 'high')
})

t('认出 retarget 提示', () => {
  const r = scanInstallLog('Either retarget the patch to the new version and change its pnpm.patchedDependencies key')
  eq(r.hits[0].id, 'retarget-hint')
})

t('认出 frozen-lockfile', () => {
  const r = scanInstallLog('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"')
  eq(r.hits[0].id, 'frozen-lockfile')
})

t('干净的输出不误报', () => {
  const r = scanInstallLog('Packages: +1\nProgress: resolved 21, reused 21, downloaded 0\nDone in 4.2s')
  eq(r.hits.length, 0)
  eq(r.patches.length, 0)
})

t('空输入 / null 不炸', () => {
  eq(scanInstallLog('').hits.length, 0)
  eq(scanInstallLog(null).hits.length, 0)
})

t('每种 pattern 都带 severity 与 title', () => {
  for (const p of INSTALL_LOG_PATTERNS) {
    if (!p.severity || !p.title || !p.id) throw new Error('pattern 缺字段：' + p.id)
  }
})

t('补丁 key → 包名（带版本）', () => eq(packageFromPatchKey('dsh-pocket@2.12.0'), 'dsh-pocket'))
t('补丁 key → 包名（scoped）', () => eq(packageFromPatchKey('@scope/pkg@1.0.0'), '@scope/pkg'))
t('补丁 key → 包名（git 源）', () => eq(packageFromPatchKey('dsh-fish-memory@github:Yuuyuko-uu/dsh-fish-memory#35cf4a9'), 'dsh-fish-memory'))
t('补丁 key 空 → null', () => eq(packageFromPatchKey(''), null))

console.log('\n=== 二、指纹与 diff ===')

t('指纹能读出依赖/版本/补丁登记/patch 文件', () => {
  const dir = makeProfile({
    deps: { 'dsh-a': '^1.0.0', 'dsh-b': '1.2.3' },
    patched: { 'dsh-a@1.0.0': 'patches/dsh-a@1.0.0.patch' },
    patches: { 'dsh-a@1.0.0.patch': 'diff --git a/x b/x\n' },
    files: { 'dsh-a': '1.0.0', 'dsh-b': '1.2.3' },
  })
  const fp = fingerprintProfile(dir)
  eq(Object.keys(fp.deps).sort(), ['dsh-a', 'dsh-b'])
  eq(fp.deps['dsh-a'].version, '1.0.0')
  eq(Object.keys(fp.registered), ['dsh-a@1.0.0'])
  eq(Object.keys(fp.patchFiles), ['dsh-a@1.0.0.patch'])
  rmSync(dir, { recursive: true, force: true })
})

t('同一个 profile 拍两次，diff 说没变', () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  const d = diffFingerprint(fingerprintProfile(dir), fingerprintProfile(dir))
  eq(d.changed, false)
  rmSync(dir, { recursive: true, force: true })
})

t('版本变了 → versionChanged', () => {
  const before = { deps: { a: { version: '1.0.0', declared: '1.0.0' } }, registered: {}, patchFiles: {}, intents: {} }
  const after = { deps: { a: { version: '1.1.0', declared: '1.1.0' } }, registered: {}, patchFiles: {}, intents: {} }
  const d = diffFingerprint(before, after)
  eq(d.changed, true)
  eq(d.versionChanged[0].name, 'a')
  eq(d.versionChanged[0].to, '1.1.0')
})

t('版本没变但声明的源改了 → 标 specOnly（fish-memory 那种浮动 URL）', () => {
  const before = { deps: { fm: { version: '1.2.1', declared: 'https://.../35cf4a9.tar.gz' } }, registered: {}, patchFiles: {}, intents: {} }
  const after = { deps: { fm: { version: '1.2.1', declared: 'https://.../d722f30.tar.gz' } }, registered: {}, patchFiles: {}, intents: {} }
  const d = diffFingerprint(before, after)
  eq(d.changed, true)
  eq(d.versionChanged[0].specOnly, true)
})

t('新增/移除依赖', () => {
  const d = diffFingerprint(
    { deps: { a: { version: '1' }, b: { version: '1' } }, registered: {}, patchFiles: {}, intents: {} },
    { deps: { a: { version: '1' }, c: { version: '1' } }, registered: {}, patchFiles: {}, intents: {} },
  )
  eq(d.added, ['c'])
  eq(d.removed, ['b'])
})

t('补丁登记新增/消失都能看出来', () => {
  const d = diffFingerprint(
    { deps: {}, registered: { 'a@1': 'p' }, patchFiles: {}, intents: {} },
    { deps: {}, registered: { 'b@1': 'p' }, patchFiles: {}, intents: {} },
  )
  eq(d.patches.registeredAdded, ['b@1'])
  eq(d.patches.registeredRemoved, ['a@1'])
  eq(d.changed, true)
})

t('patch 文件被删 / 被改都能看出来', () => {
  const d = diffFingerprint(
    { deps: {}, registered: {}, patchFiles: { 'a.patch': { size: 10, mtimeMs: 1 }, 'b.patch': { size: 20, mtimeMs: 1 } }, intents: {} },
    { deps: {}, registered: {}, patchFiles: { 'b.patch': { size: 21, mtimeMs: 2 } }, intents: {} },
  )
  eq(d.patches.filesRemoved, ['a.patch'])
  eq(d.patches.filesChanged, ['b.patch'])
})

t('intent.md 增删也能看出来', () => {
  const d = diffFingerprint(
    { deps: {}, registered: {}, patchFiles: {}, intents: {} },
    { deps: {}, registered: {}, patchFiles: {}, intents: { 'a.intent.md': 123 } },
  )
  eq(d.patches.intentsAdded, ['a.intent.md'])
})

t('prev 为空时视为变了（第一次启动不能装作没事）', () => {
  const d = diffFingerprint(null, { deps: {}, registered: {}, patchFiles: {}, intents: {} })
  eq(d.changed, true)
})

t('renderDiff 对没变化给一句话', () => {
  eq(renderDiff({ changed: false }), 'profile 没有任何变化。')
})

t('renderDiff 会给「补丁登记没了」加警告', () => {
  const s = renderDiff({ changed: true, added: [], removed: [], versionChanged: [], patches: { registeredAdded: [], registeredRemoved: ['a@1'], filesAdded: [], filesRemoved: [], filesChanged: [], intentsAdded: [], intentsRemoved: [] } })
  eq(s.includes('⚠️'), true)
})

t('renderDiff 会点名版本变化', () => {
  const s = renderDiff({ changed: true, added: [], removed: [], versionChanged: [{ name: 'dsh-a', from: '1.0.0', to: '2.0.0' }], patches: { registeredAdded: [], registeredRemoved: [], filesAdded: [], filesRemoved: [], filesChanged: [], intentsAdded: [], intentsRemoved: [] } })
  eq(s.includes('dsh-a') && s.includes('2.0.0'), true)
})

console.log('\n=== 三、哨兵本体 ===')

await ta('拍基线 + 比一次：没变就不报', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  const s = createSentinel({ dir })
  s.snapshot()
  let fired = 0
  const { diff } = s.check()
  eq(diff.changed, false)
  s.onHostChange('install', { onDiff: () => fired++ })
  await new Promise((r) => setTimeout(r, 400))
  eq(fired, 0)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

await ta('装完版本变了 → onDiff 被叫一次，且带 diff', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  const s = createSentinel({ dir, debounceMs: 220 })
  s.snapshot()
  // 模拟市场装完：node_modules 里的版本变了
  writeFileSync(join(dir, 'node_modules', 'dsh-a', 'package.json'), JSON.stringify({ name: 'dsh-a', version: '1.1.0' }))
  let got = null
  s.onHostChange('install', { onDiff: (x) => { got = x } })
  await new Promise((r) => setTimeout(r, 600))
  eq(!!got, true, '没触发回调')
  eq(got.diff.versionChanged[0].to, '1.1.0')
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

await ta('连着来好几次 changed，只比一次（防抖）', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  const s = createSentinel({ dir, debounceMs: 200 })
  s.snapshot()
  let n = 0
  for (let i = 0; i < 5; i++) s.onHostChange('install', { onDiff: () => n++ })
  await new Promise((r) => setTimeout(r, 500))
  eq(n, 0, '没变化不该触发')
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

await ta('install-log 命中 → 回调带上包名', async () => {
  const dir = makeProfile({ deps: {} })
  const s = createSentinel({ dir })
  let got = null
  const r = s.noteChunk('The following patches were not used: dsh-pocket@2.13.0\n', { onLogIssue: (x) => { got = x } })
  eq(r.hits.length, 1)
  eq(got.packages, ['dsh-pocket'])
  rmSync(dir, { recursive: true, force: true })
})

await ta('同一次安装里同一个问题只回调一次，resetRun 之后能再报', async () => {
  const dir = makeProfile({ deps: {} })
  const s = createSentinel({ dir })
  let n = 0
  s.noteChunk('ERR_PNPM_UNUSED_PATCH', { onLogIssue: () => n++ })
  s.noteChunk('ERR_PNPM_UNUSED_PATCH', { onLogIssue: () => n++ })
  eq(n, 1)
  s.resetRun()
  s.noteChunk('ERR_PNPM_UNUSED_PATCH', { onLogIssue: () => n++ })
  eq(n, 2)
  rmSync(dir, { recursive: true, force: true })
})

await ta('回调自己炸了不能把哨兵带塌', async () => {
  const dir = makeProfile({ deps: {} })
  const s = createSentinel({ dir })
  const r = s.noteChunk('ERR_PNPM_UNUSED_PATCH', { onLogIssue: () => { throw new Error('boom') } })
  eq(r.hits.length >= 1, true)
  rmSync(dir, { recursive: true, force: true })
})

await ta('summary 能画出来（不依赖外部状态）', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, patched: { 'dsh-a@1.0.0': 'patches/dsh-a@1.0.0.patch' }, patches: { 'dsh-a@1.0.0.patch': 'x' }, files: { 'dsh-a': '1.0.0' } })
  const s = createSentinel({ dir })
  s.snapshot()
  s.noteChunk('ERR_PNPM_UNUSED_PATCH\nThe following patches were not used: dsh-a@1.0.0', {})
  const out = s.summary()
  eq(out.includes('市场哨兵'), true)
  eq(out.includes('1 个已登记补丁'), true)
  rmSync(dir, { recursive: true, force: true })
})

await ta('dispose 之后定时器不再触发', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  const s = createSentinel({ dir, debounceMs: 150 })
  s.snapshot()
  let n = 0
  s.onHostChange('install', { onDiff: () => n++ })
  s.dispose()
  writeFileSync(join(dir, 'node_modules', 'dsh-a', 'package.json'), JSON.stringify({ name: 'dsh-a', version: '9.9.9' }))
  await new Promise((r) => setTimeout(r, 400))
  eq(n, 0)
  rmSync(dir, { recursive: true, force: true })
})

await ta('基线会落盘，重启后还能接着比（市场更新经常连带重启）', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  const s1 = createSentinel({ dir })
  s1.snapshot()
  eq(existsSync(join(dir, '.update-guard', 'sentinel-baseline.json')), true, '基线没落盘')

  // 第二个进程（重启后）：版本被市场换掉了
  writeFileSync(join(dir, 'node_modules', 'dsh-a', 'package.json'), JSON.stringify({ name: 'dsh-a', version: '1.2.0' }))
  const s2 = createSentinel({ dir })
  const r = s2.resume()
  eq(r.firstRun, false)
  eq(r.diff.changed, true)
  eq(r.diff.versionChanged[0].to, '1.2.0')
  rmSync(dir, { recursive: true, force: true })
})

await ta('重启后什么都没变 → 不报', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  createSentinel({ dir }).snapshot()
  const r = createSentinel({ dir }).resume()
  eq(r.firstRun, false)
  eq(r.diff.changed, false)
  rmSync(dir, { recursive: true, force: true })
})

await ta('基线文件坏了 → 当第一次跑，不炸', async () => {
  const dir = makeProfile({ deps: { 'dsh-a': '1.0.0' }, files: { 'dsh-a': '1.0.0' } })
  mkdirSync(join(dir, '.update-guard'), { recursive: true })
  writeFileSync(join(dir, '.update-guard', 'sentinel-baseline.json'), '{坏的 json')
  const r = createSentinel({ dir }).resume()
  eq(r.firstRun, true)
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\nsentinel：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)