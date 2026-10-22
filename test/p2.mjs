/**
 * test/p2.mjs —— P2 三个模块的自测
 * ============================================================================
 * P2 加了三样东西：沙箱试跑（sandbox-trial）、真装+回滚（apply）、两个新工具。
 * 这三样都**会碰磁盘**，所以测试必须格外小心：
 *   ① 绝对不碰主人的真实 profile —— 全部在临时目录里造一个假 profile
 *   ② 绝对不真装东西 —— pnpm 调用会被替换成假的
 *   ③ 测完必须删干净 —— 否则临时目录越堆越多
 *
 * 覆盖的关键行为：
 *   - 补丁重定位：key 改名 / 文件改名 / 别的包的补丁不受影响
 *   - 快照：存了什么、能不能还原
 *   - 试跑：造环境 → 失败路径（装不上 / 加载崩）→ 临时目录一定被删
 *   - 回滚：快照盖回去后文件内容真的变回去了
 * ============================================================================
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

import { retargetPatches, snapshot, listBackups, renderApply, backupBase, pruneBackups, APPLY_RESULT } from '../lib/apply.js'
import { findToolchain, stageProfile, renderTrial, TRIAL_VERDICT } from '../lib/sandbox-trial.js'
import { parsePatchKey } from '../lib/patchledger.js'

let pass = 0
let fail = 0
const fails = []

function t(name, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    fails.push({ name, error: String(e?.message ?? e) })
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
  }
}

async function ta(name, fn) {
  try {
    const r = await fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    fails.push({ name, error: String(e?.message ?? e) })
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
  }
}

function eq(a, b, msg) {
  const A = JSON.stringify(a)
  const B = JSON.stringify(b)
  if (A !== B) throw new Error(`${msg ?? '不相等'}：拿到 ${A}，期望 ${B}`)
}

/** 造一个假 profile，形状跟真的一样（package.json + patches + 一个装好的包） */
function makeFakeProfile({ patches = {}, withPkg = true } = {}) {
  const dir = join(tmpdir(), `dsh-p2-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })

  const patchedDeps = {}
  for (const [key, content] of Object.entries(patches)) {
    // ⚠️ 用真实命名（`pkg@ver.patch`），别用 `+` —— 线上 profile 里就是这种，
    //    用错形式会让「补丁文件改名」这条路径永远测不到。
    patchedDeps[key] = `patches/${key}.patch`
  }

  const manifest = {
    name: 'fake-profile',
    version: '1.0.0',
    dependencies: { 'dsh-foo': '1.0.0', 'other-pkg': '2.0.0' },
    pnpm: { patchedDependencies: patchedDeps },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')

  if (Object.keys(patches).length > 0) {
    mkdirSync(join(dir, 'patches'), { recursive: true })
    for (const [key, content] of Object.entries(patches)) {
      writeFileSync(join(dir, 'patches', `${key}.patch`), content, 'utf8')
    }
  }

  if (withPkg) {
    const pkgDir = join(dir, 'node_modules', 'dsh-foo')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-foo', version: '1.0.0', main: 'index.js',
    }, null, 2), 'utf8')
    writeFileSync(join(pkgDir, 'index.js'), 'export function apply() {}\n', 'utf8')
  }

  return dir
}

const SAMPLE_PATCH = `diff --git a/client/client.js b/client/client.js
--- a/client/client.js
+++ b/client/client.js
@@ -1,3 +1,3 @@
-const a = 1
+const a = 2
 const b = 3
 const c = 4
`

console.log('\napply（真装 + 补丁重定位 + 回滚）')

t('parsePatchKey 认得出 scoped 和普通包名', () => {
  eq(parsePatchKey('dsh-foo@1.0.0'), { name: 'dsh-foo', version: '1.0.0' })
  eq(parsePatchKey('@scope/pkg@2.3.4'), { name: '@scope/pkg', version: '2.3.4' })
})

t('retargetPatches：把补丁 key 从旧版本改到新版本', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  try {
    const r = retargetPatches(dir, 'dsh-foo', '2.0.0')
    eq(r.changed, 1, '应该改了 1 个补丁')
    eq(r.changes[0].newKey, 'dsh-foo@2.0.0')

    // 假 profile 的补丁表住在 package.json 里，所以改完必须写回 package.json
    // （writePatchedDependencies 会跟着原位置走，不会凭空搬到 yaml）
    const mf = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const keys = Object.keys(mf.pnpm.patchedDependencies)
    if (!keys.includes('dsh-foo@2.0.0')) throw new Error(`改完的 key 没写进 manifest：${keys.join(',')}`)
    if (keys.includes('dsh-foo@1.0.0')) throw new Error('旧 key 还留着')
    eq(r.writeTarget, 'manifest', '应该写回 package.json')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('retargetPatches：补丁文件也复制了一份新名字的', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  try {
    retargetPatches(dir, 'dsh-foo', '2.0.0')
    const newFile = join(dir, 'patches', 'dsh-foo@2.0.0.patch')
    if (!existsSync(newFile)) throw new Error(`新补丁文件不存在：${newFile}`)
    // 旧文件必须还在（回滚要用）
    const oldFile = join(dir, 'patches', 'dsh-foo@1.0.0.patch')
    if (!existsSync(oldFile)) throw new Error('旧补丁文件被删了 —— 回滚会没东西可退')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('retargetPatches：别的包的补丁一个字都不许动', () => {
  const dir = makeFakeProfile({
    patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH, 'other-pkg@2.0.0': SAMPLE_PATCH },
  })
  try {
    retargetPatches(dir, 'dsh-foo', '3.0.0')
    const mf = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const keys = Object.keys(mf.pnpm.patchedDependencies)
    if (!keys.includes('other-pkg@2.0.0')) throw new Error(`other-pkg 的补丁被动了：${keys.join(',')}`)
    if (keys.includes('dsh-foo@1.0.0')) throw new Error('dsh-foo 的旧 key 还在')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('retargetPatches：补丁已经是目标版本时不动（keep）', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@2.0.0': SAMPLE_PATCH } })
  try {
    const r = retargetPatches(dir, 'dsh-foo', '2.0.0')
    eq(r.changed, 0)
    eq(r.changes[0].action, 'keep')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('retargetPatches：dryRun 不写盘', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  try {
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    retargetPatches(dir, 'dsh-foo', '9.9.9', { dryRun: true })
    const after = readFileSync(join(dir, 'package.json'), 'utf8')
    if (before !== after) throw new Error('dryRun 居然改了 manifest')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('retargetPatches：能看出补丁改的是哪些文件（判断要不要重写）', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  try {
    const r = retargetPatches(dir, 'dsh-foo', '2.0.0', { dryRun: true })
    const targets = r.changes[0].targetFiles ?? []
    if (!targets.includes('client/client.js')) throw new Error(`没认出目标文件：${JSON.stringify(targets)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('snapshot：存下 manifest / patches / 包目录', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  try {
    const snap = snapshot(dir, 'dsh-foo')
    if (!existsSync(join(snap.root, 'package.json'))) throw new Error('没存 manifest')
    if (!existsSync(join(snap.root, 'patches'))) throw new Error('没存补丁目录')
    if (!existsSync(join(snap.root, 'pkg'))) throw new Error('没存包目录（回滚会变慢）')
    if (!snap.hasPkgCopy) throw new Error('hasPkgCopy 标记错了')
    eq(snap.currentVersion, '1.0.0')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('snapshot：备份放在 profile **旁边**，不放进 profile 里', () => {
  const dir = makeFakeProfile()
  try {
    const snap = snapshot(dir, 'dsh-foo')
    // 🔴 这条约束是踩过坑换来的：备份原本放在 profileDir/.update-guard 下，
    //    结果一次测试清理把整个目录删了，真实升级的备份一起没了，回滚时
    //    「备份 0 份」。备份必须活得比它保护的对象久。
    if (snap.root.startsWith(dir)) {
      throw new Error(`备份不该在 profile 里面：${snap.root}`)
    }
    if (!snap.root.startsWith(dirname(dir))) {
      throw new Error(`备份应该在 profile 的父目录下：${snap.root}`)
    }
    if (!existsSync(join(snap.root, 'package.json'))) throw new Error('没备份 manifest')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(backupBase(dir), { recursive: true, force: true })
  }
})

t('listBackups：认得出给这个包做的备份，最新的排最前', () => {
  const dir = makeFakeProfile()
  try {
    snapshot(dir, 'dsh-foo')
    // 造两个时间不同的备份目录，验证排序
    const b2 = join(backupBase(dir), '2099-01-01T00-00-00-000Z')
    mkdirSync(join(b2, 'pkg'), { recursive: true })
    writeFileSync(join(b2, 'package.json'), JSON.stringify({ dependencies: { 'dsh-foo': '0.9.0' } }), 'utf8')

    const list = listBackups(dir, 'dsh-foo')
    if (list.length !== 2) throw new Error(`应该有 2 个备份，拿到 ${list.length}`)
    if (list[0].stamp !== '2099-01-01T00-00-00-000Z') throw new Error(`最新备份没排第一：${list[0].stamp}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(backupBase(dir), { recursive: true, force: true })
  }
})

t('listBackups：没有 pkg 副本的目录不算这个包的备份', () => {
  const dir = makeFakeProfile()
  try {
    const bad = join(backupBase(dir), '2020-01-01T00-00-00-000Z')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'package.json'), '{}', 'utf8')
    eq(listBackups(dir, 'dsh-foo').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(backupBase(dir), { recursive: true, force: true })
  }
})

t('renderApply 对任何报告都不崩', () => {
  for (const r of [null, undefined, {}, { result: APPLY_RESULT.APPLIED, reason: 'x' },
    { result: APPLY_RESULT.ROLLED_BACK, reason: 'y', steps: [{ step: 'a', ok: false, output: 'boom' }] }]) {
    const s = renderApply(r)
    if (typeof s !== 'string') throw new Error('没返回字符串')
  }
})

console.log('\nsandbox-trial（沙箱试跑）')

t('findToolchain：至少找得到 node（不然什么都别干了）', () => {
  const tc = findToolchain()
  if (!tc.node) throw new Error('连 node 都找不到 —— 这个插件的基本盘就没了')
  if (!existsSync(tc.node)) throw new Error(`找到的 node 路径不存在：${tc.node}`)
})

t('findToolchain：pnpm 找不到时返回 null 而不是抛', () => {
  const tc = findToolchain({ pnpmPath: '/nonexistent/pnpm-xyz' })
  // 找不到就是 null（宿主那边会降级成 skip），关键是别抛
  if (tc.pnpm !== null && !existsSync(tc.pnpm)) throw new Error('返回了一个不存在的 pnpm 路径')
})

t('stageProfile：临时目录里造出了改好版本的 package.json', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  let staged = null
  try {
    const r = stageProfile(dir, { name: 'dsh-foo', toVersion: '2.0.0' })
    staged = r.stage
    const mf = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))
    eq(mf.dependencies['dsh-foo'], '2.0.0', '版本没换成新的')
    eq(mf.dependencies['other-pkg'], '2.0.0', '别的依赖被动了')
    // 补丁也重定位了 —— 🔴 表在 stage 的 pnpm-workspace.yaml 里，不在 package.json。
    //    （统一写 yaml 是刻意的：真 profile 就是 pnpm 11 的 yaml 写法，
    //      两处都写会造出「一份生效一份是孤儿」的鬼状态。）
    if (mf.pnpm?.patchedDependencies) throw new Error('stage 的 package.json 里不该再有补丁表')
    const ws = readFileSync(join(staged, 'pnpm-workspace.yaml'), 'utf8')
    if (!ws.includes('dsh-foo@2.0.0')) throw new Error(`补丁 key 没重定位到 yaml：\n${ws}`)
    if (ws.includes('dsh-foo@1.0.0')) throw new Error('yaml 里旧版本的补丁 key 还在')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (staged) rmSync(staged, { recursive: true, force: true })
  }
})

t('stageProfile：复制了补丁文件，且新名字的那份也在', () => {
  const dir = makeFakeProfile({ patches: { 'dsh-foo@1.0.0': SAMPLE_PATCH } })
  let staged = null
  try {
    const r = stageProfile(dir, { name: 'dsh-foo', toVersion: '2.0.0' })
    staged = r.stage
    if (!existsSync(join(staged, 'patches'))) throw new Error('没复制补丁目录')
    if (!existsSync(join(staged, 'patches', 'dsh-foo@2.0.0.patch'))) {
      throw new Error(`重定位后的补丁文件不在：${join(staged, 'patches')} 里是 ${existsSync(join(staged, 'patches')) ? '有目录' : '没目录'}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (staged) rmSync(staged, { recursive: true, force: true })
  }
})

t('stageProfile：没有 patches 目录时也不崩', () => {
  const dir = makeFakeProfile({ withPkg: false })
  let staged = null
  try {
    const r = stageProfile(dir, { name: 'dsh-foo', toVersion: '2.0.0' })
    staged = r.stage
    if (!existsSync(join(staged, 'package.json'))) throw new Error('没造出 manifest')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (staged) rmSync(staged, { recursive: true, force: true })
  }
})

t('renderTrial 对任何结果都不崩', () => {
  for (const r of [null, {}, { ok: true, reason: 'x' }, { ok: false, verdict: 'skip', reason: 'y' },
    { ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL, reason: 'z', steps: [{ step: 'load', ok: false, detail: 'd' }] }]) {
    const s = renderTrial(r)
    if (typeof s !== 'string') throw new Error('没返回字符串')
  }
})

await ta('sandboxTrial：找不到 pnpm 时返回 skip，不假装成功也不假装失败', async () => {
  const dir = makeFakeProfile()
  try {
    const { sandboxTrial } = await import('../lib/sandbox-trial.js')
    const r = await sandboxTrial({
      profileDir: dir, name: 'dsh-foo', fromVersion: '1.0.0', toVersion: '2.0.0',
      toolchain: { node: process.execPath, pnpm: null },
      installTimeoutMs: 5000,
    })
    eq(r.verdict, TRIAL_VERDICT.SKIP, '应该是 skip')
    eq(r.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await ta('sandboxTrial：无论成败，临时目录都被删干净了', async () => {
  const dir = makeFakeProfile()
  try {
    const { sandboxTrial } = await import('../lib/sandbox-trial.js')
    const before = new Set(
      (await import('node:fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('dsh-trial-')),
    )
    await sandboxTrial({
      profileDir: dir, name: 'dsh-foo', fromVersion: '1.0.0', toVersion: '2.0.0',
      toolchain: { node: process.execPath, pnpm: null },
      installTimeoutMs: 3000,
    })
    const after = (await import('node:fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('dsh-trial-') && !before.has(f))
    if (after.length > 0) throw new Error(`试跑留下了垃圾：${after.join(', ')}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('pruneBackups：只留最近 N 份，但最后一份永远不删', () => {
  const dir = makeFakeProfile()
  try {
    // 造 8 个时间戳备份
    for (let i = 1; i <= 8; i++) {
      const stamp = `2026-01-0${i}T00-00-00-000Z`
      const d = join(backupBase(dir), stamp)
      mkdirSync(join(d, 'pkg'), { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { 'dsh-foo': `1.0.${i}` } }), 'utf8')
    }
    const r = pruneBackups(dir, { keep: 3 })
    if (r.removed.length !== 5) throw new Error(`应该删 5 份，实际 ${r.removed.length}`)
    const left = listBackups(dir, 'dsh-foo')
    if (left.length !== 3) throw new Error(`应该剩 3 份，实际 ${left.length}`)
    if (left[0].stamp !== '2026-01-08T00-00-00-000Z') throw new Error('最新的备份被删了！')

    // keep=0 也不能把最后一份删掉 —— 没备份就没兜底
    const r2 = pruneBackups(dir, { keep: 0 })
    if (r2.removed.length !== 2) throw new Error(`keep=0 时应该删 2 份留 1 份，实际删 ${r2.removed.length}`)
    if (listBackups(dir, 'dsh-foo').length !== 1) throw new Error('最后一份备份被删了 —— 没有兜底了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(backupBase(dir), { recursive: true, force: true })
  }
})

console.log('\n────────────────────────────────────────')
if (fail > 0) {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const f of fails) console.log(`\n  ${f.name}\n  ${f.error}`)
  process.exitCode = 1
} else {
  console.log(`✅ ${pass} 通过 / 0 失败`)
}
