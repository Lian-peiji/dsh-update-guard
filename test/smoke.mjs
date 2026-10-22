/**
 * test/smoke.mjs —— 离线冒烟：不碰网络、不碰宿主，只验纯逻辑。
 *
 * 跑法：
 *   node test/smoke.mjs
 *
 * 🔴 为什么要先有这个：
 *   插件要装进主人的 profile 才能真跑，而"装进去发现炸了"的代价是 DSH 可能起不来。
 *   所以在装之前，把所有**不需要宿主**的部分先跑一遍 —— 语法、纯函数、真实 profile 的解析。
 */
import { strict as assert } from 'node:assert'
import { join } from 'node:path'

import { compare, bumpType, satisfies, maxVersion, parse, isUpgrade } from '../lib/semver.js'
import { classifySpec, scanProfile, readPatchedDependencies, guessActiveProfile, profileDir, listProfiles } from '../lib/profile.js'
import { scanPatches, patchBrief, parsePatchKey } from '../lib/patchledger.js'
import { diffFileMaps, sliceChangelog, findChangelog, renderDiffForPrompt } from '../lib/recon.js'
import { parseVerdict, normalizeVerdict, pickTier, salvageJson, VERDICTS } from '../lib/review.js'
import { extractBareImports, parsePatchIds, staticCheck, renderReport } from '../lib/install-guard.js'
import { jsonSafe, safeString } from '../lib/jsonsafe.js'

let pass = 0
let failed = 0
const results = []

function t(name, fn) {
  try { fn(); pass++; results.push(`  ✓ ${name}`) }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e?.message ?? e}`) }
}

function group(title) { results.push(`\n${title}`) }

// ─────────────────────────────────────────────────────────────────────────────
group('semver')
// ─────────────────────────────────────────────────────────────────────────────
t('compare 基本序', () => {
  assert.equal(compare('1.2.3', '1.2.3'), 0)
  assert.equal(compare('1.2.4', '1.2.3'), 1)
  assert.equal(compare('1.3.0', '1.2.9'), 1)
  assert.equal(compare('2.0.0', '1.99.99'), 1)
})
t('compare 处理预发布（1.0.0-beta < 1.0.0）', () => {
  assert.equal(compare('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compare('1.0.0', '1.0.0-beta.1'), 1)
})
t('bumpType 分级', () => {
  assert.equal(bumpType('1.2.3', '1.2.4'), 'patch')
  assert.equal(bumpType('1.2.3', '1.3.0'), 'minor')
  assert.equal(bumpType('1.2.3', '2.0.0'), 'major')
})
t('satisfies 支持 ^ ~ >=', () => {
  assert.equal(satisfies('^1.2.0', '1.5.0'), true)
  assert.equal(satisfies('^1.2.0', '2.0.0'), false)
  assert.equal(satisfies('~1.2.0', '1.2.9'), true)
  assert.equal(satisfies('~1.2.0', '1.3.0'), false)
  assert.equal(satisfies('>=22', '24.21.0'), true)
  assert.equal(satisfies('>=22', '18.0.0'), false)
})
t('maxVersion / isUpgrade', () => {
  assert.equal(maxVersion(['1.0.0', '2.1.0', '1.9.9']), '2.1.0')
  assert.equal(isUpgrade('1.0.0', '1.0.1'), true)
  assert.equal(isUpgrade('1.0.1', '1.0.0'), false)
})
t('非法版本不崩', () => {
  assert.doesNotThrow(() => compare('not-a-version', '1.0.0'))
  assert.equal(parse('garbage'), null)
})

// ─────────────────────────────────────────────────────────────────────────────
group('profile（真实 profile 解析）')
// ─────────────────────────────────────────────────────────────────────────────
t('classifySpec 分清三种源', () => {
  assert.equal(classifySpec('2.12.0').kind, 'registry')
  assert.equal(classifySpec('^1.0.0').kind, 'registry')
  assert.equal(classifySpec('https://codeload.github.com/x/y/tar.gz/abc').kind, 'git')
  assert.equal(classifySpec('file:./local-plugins/x').kind, 'local')
  assert.equal(classifySpec('./x').kind, 'local')
})

const active = guessActiveProfile()
const dir = active ? profileDir(active) : null
t('能猜出活跃 profile', () => {
  assert.ok(active, '一个 profile 都没找到')
  assert.ok(dir, 'profile 目录为空')
})

if (dir) {
  t(`scanProfile 能读出依赖（${active}）`, () => {
    const list = scanProfile(dir)
    assert.ok(Array.isArray(list))
    assert.ok(list.length > 0, '一个依赖都没读出来')
    for (const p of list) {
      assert.ok(typeof p.name === 'string' && p.name.length > 0)
      assert.ok(['registry', 'git', 'local', 'alias', 'unknown'].includes(p.sourceKind), `未知源类型 ${p.sourceKind}`)
    }
  })
  t('readPatchedDependencies 返回对象', () => {
    const pd = readPatchedDependencies(dir)
    assert.equal(typeof pd, 'object')
    assert.ok(pd !== null)
  })
  t('scanPatches 双向核对能跑（真实数据）', () => {
    const pd = readPatchedDependencies(dir)
    const list = scanPatches(dir, pd)
    assert.ok(Array.isArray(list))
    // 每个条目都必须有 key / registered 字段，且 issues 是数组
    for (const p of list) {
      assert.ok(p.key.includes('@'), `key 不像 pkg@ver：${p.key}`)
      assert.equal(typeof p.registered, 'boolean')
      assert.ok(Array.isArray(p.issues))
      // 缺 intent.md 是「建议补充」（notes），不是「有问题」（issues）——
      // 补丁本身好好的，红色标签会吓人（主人 2026-10-22 反馈）
      assert.ok(Array.isArray(p.notes))
      for (const i of p.issues) assert.ok(!i.includes('intent.md'), '缺 intent.md 不该进 issues')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
group('patchledger（纯函数）')
// ─────────────────────────────────────────────────────────────────────────────
t('parsePatchKey 拆分', () => {
  assert.deepEqual(parsePatchKey('dsh-pocket@2.12.0'), { name: 'dsh-pocket', version: '2.12.0' })
  // scope 包：只按最后一个 @ 切
  assert.deepEqual(parsePatchKey('@scope/pkg@1.0.0'), { name: '@scope/pkg', version: '1.0.0' })
})

// ─────────────────────────────────────────────────────────────────────────────
group('recon（diff 引擎，纯内存）')
// ─────────────────────────────────────────────────────────────────────────────
t('diffFileMaps 认出 新增/删除/修改', () => {
  const oldMap = new Map([
    ['a.js', Buffer.from('line1\nline2\nline3\n')],
    ['gone.js', Buffer.from('bye\n')],
  ])
  const newMap = new Map([
    ['a.js', Buffer.from('line1\nCHANGED\nline3\n')],
    ['new.js', Buffer.from('hello\n')],
  ])
  const d = diffFileMaps(oldMap, newMap)
  assert.equal(d.summary.added, 1, '新增文件数不对')
  assert.equal(d.summary.removed, 1, '删除文件数不对')
  assert.equal(d.summary.changed, 1, '修改文件数不对')
  const a = d.files.find((f) => f.path === 'a.js')
  assert.equal(a.kind, 'changed')
  assert.ok(a.diff.includes('-line2') && a.diff.includes('+CHANGED'), `diff 内容不对：\n${a.diff}`)
})
t('diffFileMaps 跳过 node_modules / *.map / 测试目录', () => {
  const oldMap = new Map()
  const newMap = new Map([
    ['node_modules/x/index.js', Buffer.from('noise\n')],
    ['lib/a.js.map', Buffer.from('{}')],
    ['test/a.test.js', Buffer.from('t()')],
    ['lib/real.js', Buffer.from('real\n')],
  ])
  const d = diffFileMaps(oldMap, newMap)
  const paths = d.files.map((f) => f.path)
  assert.ok(!paths.includes('node_modules/x/index.js'), 'node_modules 没被跳过')
  assert.ok(!paths.includes('lib/a.js.map'), 'sourcemap 没被跳过')
  assert.ok(paths.includes('lib/real.js'), '真源码被误杀')
})
t('diffFileMaps 遵守 budgetChars', () => {
  // 注意：单个文件的 diff 先被 lineDiff 的 maxLines=200 截过一次，
  // 所以预算要比"200 行文本"更小才能触发 budget 截断。
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  const oldMap = new Map([['big.js', Buffer.from('old\n')]])
  const newMap = new Map([['big.js', Buffer.from(big)]])
  const d = diffFileMaps(oldMap, newMap, { budgetChars: 300 })
  assert.equal(d.truncated, true, '没有标记截断')
  const total = d.files.reduce((n, f) => n + (f.diff?.length ?? 0), 0)
  assert.ok(total < 1000, `预算没生效：${total}`)
})
t('findChangelog 认出常见文件名', () => {
  const files = new Map([['CHANGELOG.md', Buffer.from('# Changelog\n\n## 1.1.0\n- new\n\n## 1.0.0\n- old\n')]])
  const cl = findChangelog(files)
  assert.ok(cl, '没找到 changelog')
  assert.equal(cl.path, 'CHANGELOG.md')
})
t('sliceChangelog 只取目标区间', () => {
  const text = '# Changelog\n\n## 2.0.0\n- major stuff\n\n## 1.1.0\n- minor stuff\n\n## 1.0.0\n- old stuff\n'
  const s = sliceChangelog(text, '1.0.0', '1.1.0')
  assert.ok(s.text.includes('minor stuff'), `没取到 1.1.0：${s.text}`)
  assert.ok(!s.text.includes('major stuff'), '越界取到了 2.0.0')
})
t('renderDiffForPrompt 在 dive 报错时不崩', () => {
  const s = renderDiffForPrompt({ error: '下载失败' })
  assert.ok(s.includes('下载失败'))
  assert.equal(renderDiffForPrompt(null).length > 0, true)
})

// ─────────────────────────────────────────────────────────────────────────────
group('review（判决容错）')
// ─────────────────────────────────────────────────────────────────────────────
t('parseVerdict 能抠纯 JSON', () => {
  const r = parseVerdict('{"verdict":"install","confidence":0.9,"summary":"修了个崩溃"}')
  assert.equal(r.ok, true)
  assert.equal(r.verdict.verdict, 'install')
})
t('parseVerdict 能抠 ```json 围栏', () => {
  const r = parseVerdict('好的，判决如下：\n```json\n{"verdict":"hold","summary":"补丁冲突"}\n```\n以上。')
  assert.equal(r.ok, true)
  assert.equal(r.verdict.verdict, 'hold')
})
t('parseVerdict 能抠裸花括号', () => {
  const r = parseVerdict('我觉得 {"verdict":"skip","unlock":"等有功能再说"} 这样')
  assert.equal(r.ok, true)
  assert.equal(r.verdict.verdict, 'skip')
})
t('parseVerdict 对垃圾输入返回 ok:false 而不是抛', () => {
  assert.equal(parseVerdict('完全没有 JSON').ok, false)
  assert.equal(parseVerdict('').ok, false)
  assert.equal(parseVerdict(null).ok, false)
})
// ── 真机撞过的坑：输出被 maxTokens 截断 → JSON 不合法 → 静默放行，等于没审
t('parseVerdict 能救回被截断的 JSON（真机事故回归）', () => {
  const cut = '{"verdict":"install","confidence":0.84,"summary":"修复桌面端插件更新被中断后插件消失的 bug'
  const r = parseVerdict(cut)
  assert.equal(r.ok, true, '截断的 JSON 没被救回来')
  assert.equal(r.verdict.verdict, 'install')
  assert.equal(r.salvaged, true, '没标记成"修复过的"（字段可能不全，得提醒）')
})
t('parseVerdict 能救回截断在数组中间的 JSON', () => {
  const cut = '{"verdict":"hold","summary":"冲突","features":["a","b","未写完的第三项'
  const r = parseVerdict(cut)
  assert.equal(r.ok, true)
  assert.equal(r.verdict.verdict, 'hold')
})
t('parseVerdict 能救回多砍几刀的截断 JSON', () => {
  const cut = '{"verdict":"skip","summary":"等","risks":[{"symptom":"闪退","why":"x","mit'
  const r = parseVerdict(cut)
  assert.equal(r.ok, true, '嵌套对象截断后没救回来')
})
t('salvageJson 对没有花括号的输入返回 null（不抛）', () => {
  assert.equal(salvageJson('啥也没有'), null)
  assert.equal(salvageJson(''), null)
})
t('normalizeVerdict：非法判决降级成 install', () => {
  const v = normalizeVerdict({ verdict: 'maybe', confidence: 0.5 })
  assert.ok(VERDICTS.includes(v.verdict), `判决不在枚举里：${v.verdict}`)
  assert.equal(v.verdict, 'install', '非法判决没有降级到 install')
})
t('normalizeVerdict：skip 没说清放弃什么 → 改判 install', () => {
  const v = normalizeVerdict({ verdict: 'skip', confidence: 0.8 })
  assert.equal(v.verdict, 'install', '主人要新功能，说不清就不许 skip')
})
t('normalizeVerdict：hold 没具体理由 → 改判 install', () => {
  const v = normalizeVerdict({ verdict: 'hold', confidence: 0.8 })
  assert.equal(v.verdict, 'install')
})
t('normalizeVerdict：hold 有具体风险 → 保留', () => {
  const v = normalizeVerdict({ verdict: 'hold', confidence: 0.8, risks: ['删了 foo() 导出，我们依赖它'] })
  assert.equal(v.verdict, 'hold')
})
t('pickTier 按风险分级', () => {
  assert.equal(pickTier('patch', {}), 'cheap')
  assert.equal(pickTier('minor', {}), 'strong')
  assert.equal(pickTier('major', {}), 'strong')
  assert.equal(pickTier('patch', { hasPatches: true }), 'strong')
  assert.equal(pickTier('patch', { badHistory: true }), 'strong')
})

// ─────────────────────────────────────────────────────────────────────────────
group('install-guard（新装体检）')
// ─────────────────────────────────────────────────────────────────────────────
t('extractBareImports 只挑裸包名', () => {
  const code = `
    import a from 'node:fs'
    import b from '@deepseek-ai/cordis'
    import c from './local.js'
    import d from '../up.js'
    import e from 'schemastery'
    const f = await import('dynamic-pkg')
  `
  const specs = extractBareImports(code)
  assert.ok(specs.includes('@deepseek-ai/cordis'), '没抓到 scope 包')
  assert.ok(specs.includes('schemastery'), '没抓到普通包')
  assert.ok(!specs.includes('node:fs'), 'node: 内置被误抓')
  assert.ok(!specs.some((s) => s.startsWith('.')), `相对路径被误抓：${specs.join(',')}`)
})
t('parsePatchIds 能从 bundle patch yml 里抠 id', () => {
  const yml = `
- insert:
    - id: my-plugin
      name: my-plugin
  override:
    - id: existing-one
      disabled: true
`
  const ids = parsePatchIds(yml)
  assert.ok(ids.includes('my-plugin'), `没抠到 my-plugin：${ids.join(',')}`)
  assert.ok(ids.includes('existing-one'), `没抠到 existing-one：${ids.join(',')}`)
})
t('staticCheck 拦住"没有 package.json"', () => {
  const r = staticCheck({ files: new Map(), name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  assert.equal(r.ok, false)
  assert.equal(r.blockers[0].code, 'NO_MANIFEST')
})
t('staticCheck 拦住 engines 不满足', () => {
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', engines: { node: '>=99' }, dsh: {} }))],
  ])
  const r = staticCheck({ files, name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  assert.equal(r.ok, false)
  assert.ok(r.blockers.some((b) => b.code === 'ENGINES_MISMATCH'), JSON.stringify(r.blockers))
})
t('staticCheck 拦住 dsh.bundle.patch 指向缺失文件', () => {
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))],
  ])
  const r = staticCheck({ files, name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  assert.equal(r.ok, false)
  assert.ok(r.blockers.some((b) => b.code === 'MISSING_BUNDLE_PATCH'), JSON.stringify(r.blockers))
})
t('staticCheck 对干净包给 ok:true', () => {
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({
      name: 'clean-plugin', version: '1.0.0',
      description: 'a clean plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
    }))],
    ['cordis.patch.yml', Buffer.from('- insert:\n    - id: clean-plugin\n      name: clean-plugin\n')],
    ['lib/index.js', Buffer.from("export const name = 'clean'\nexport function apply() {}\n")],
    ['README.md', Buffer.from('# clean plugin\n')],
  ])
  const r = staticCheck({ files, name: 'clean-plugin', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  assert.equal(r.blockers.length, 0, `不该有拦截项：${JSON.stringify(r.blockers)}`)
  assert.equal(r.ok, true)
})
t('staticCheck 拦住 UNDECLARED_IMPORT（裸 import 找不到包）', () => {
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({ name: 'x', version: '1.0.0', dsh: {} }))],
    ['lib/index.js', Buffer.from("import { thing } from 'totally-missing-pkg'\nexport const name='x'\n")],
    ['README.md', Buffer.from('# x\n')],
  ])
  const r = staticCheck({ files, name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  // ★ 这是**拦截项**不是普通 finding —— 这种包装上，整条插件会 failed to import
  const hit = r.blockers.find((b) => b.code === 'UNDECLARED_IMPORT')
  assert.ok(hit, `没拦住未声明的裸 import：${JSON.stringify(r.blockers.map((b) => b.code))}`)
  assert.equal(r.ok, false)
})
t('staticCheck 不把 client 半边的 react 当缺失（宿主注入）', () => {
  // 回归用例：dsh-meme@0.1.56 的 client.js 写 require('react')，profile 里没 react，
  // 但宿主 Web 运行时注入它 —— 旧版会误报 UNDECLARED_IMPORT 把好包拦下来。
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({
      name: 'x', version: '1.0.0', dsh: {},
      exports: { '.': './index.js', './client': './client.js' },
    }))],
    ['index.js', Buffer.from("export const name='x'\n")],
    ['client.js', Buffer.from("const React = require('react')\nmodule.exports = {}\n")],
  ])
  const r = staticCheck({ files, name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  assert.equal(r.ok, true, `client 侧 react 被误拦：${JSON.stringify(r.blockers)}`)
  assert.equal(r.blockers.length, 0)
})
t('staticCheck 仍拦 client 半边真正缺失的包（只是降级为 medium）', () => {
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({
      name: 'x', version: '1.0.0', dsh: {},
      exports: { '.': './index.js', './client': './client.js' },
    }))],
    ['index.js', Buffer.from("export const name='x'\n")],
    ['client.js', Buffer.from("import lodash from 'totally-missing-pkg'\n")],
  ])
  const r = staticCheck({ files, name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  const hit = r.findings.find((f) => f.code === 'UNDECLARED_CLIENT_IMPORT')
  assert.ok(hit, `client 侧真缺失没报：${JSON.stringify(r.findings.map((f) => f.code))}`)
})
t('renderReport 任何报告都不崩', () => {
  const r = staticCheck({ files: new Map(), name: 'x', version: '1.0.0', profileDir: '/nonexistent', nodeVersion: '24.0.0' })
  const s = renderReport(r, { name: 'x', version: '1.0.0' })
  assert.ok(s.includes('体检结论'))
})

// ─────────────────────────────────────────────────────────────────────────────
group('jsonsafe（真机事故回归：value is not lossless JSON）')
// ─────────────────────────────────────────────────────────────────────────────
const roundTrip = (v) => JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)
t('jsonSafe：undefined 变 null（不然键会静默消失）', () => {
  const r = jsonSafe({ a: undefined, b: 1 })
  assert.equal(r.value.a, null)
  assert.equal(roundTrip(r.value), true)
})
t('jsonSafe：NaN / Infinity 变 null', () => {
  const r = jsonSafe({ a: NaN, b: Infinity, c: -Infinity })
  assert.equal(r.value.a, null)
  assert.equal(r.value.b, null)
  assert.equal(roundTrip(r.value), true)
})
t('jsonSafe：-0 变 0', () => {
  assert.equal(Object.is(jsonSafe({ a: -0 }).value.a, 0), true)
})
t('jsonSafe：BigInt 变字符串，不抛', () => {
  const r = jsonSafe({ a: 10n })
  assert.equal(r.value.a, '10')
})
t('jsonSafe：孤立代理项被换掉（命令行输出的重灾区）', () => {
  const bad = 'abc\uD800def'
  const r = jsonSafe({ s: bad })
  assert.equal(roundTrip(r.value), true, '孤立代理项没修好，往返坏了')
  assert.equal(r.fixed.length, 1)
})
t('jsonSafe：Date / Map / Set 变成 JSON 能表达的', () => {
  const r = jsonSafe({ d: new Date('2026-10-22T00:00:00.000Z'), m: new Map([['a', 1]]), s: new Set([1, 2]) })
  assert.equal(typeof r.value.d, 'string')
  assert.deepEqual(r.value.m, { a: 1 })
  assert.deepEqual(r.value.s, [1, 2])
  assert.equal(roundTrip(r.value), true)
})
t('jsonSafe：嵌套数组/对象里的坏东西也收拾干净', () => {
  const r = jsonSafe({ steps: [{ detail: undefined, n: NaN }, { ok: true }] })
  assert.equal(roundTrip(r.value), true)
  assert.equal(r.value.steps[0].detail, null)
})
t('jsonSafe：好数据原样不动、fixed 为空', () => {
  const good = { ok: true, report: '正常', steps: [{ step: 'install', ok: true }] }
  const r = jsonSafe(good)
  assert.deepEqual(r.value, good)
  assert.equal(r.fixed.length, 0)
})
t('safeString 不改变正常中文/emoji', () => {
  const s = '鲸鱼娘🐳正常字符串'
  assert.equal(safeString(s), s)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log(results.join('\n'))
console.log(`\n${failed === 0 ? '✅' : '❌'} ${pass} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
