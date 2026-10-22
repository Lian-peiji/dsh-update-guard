/**
 * test/patchfix.mjs —— 补丁重写的机械验收（不需要网络、不需要模型）
 *
 * 这里要证明的核心只有一句：**模型说什么都不算，只有能干净打上新版原文、
 * 并且没把原补丁新增的名字弄丢的补丁，才会被接受。**
 */
import {
  parseUnifiedDiff, applyHunksToText, declMarkers, verifyCandidate, fixPatch,
  buildFixPrompt, extractJson,
} from '../lib/patchfix.js'

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
  if (a !== b) throw new Error((msg ?? '') + ` 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
  return true
}

const OLD_FILE = [
  'function a() {',
  '  return 1',
  '}',
  'function b() {',
  '  return 2',
  '}',
].join('\n')

// 旧补丁：在 function a 后面加一个 const X
const OLD_PATCH = [
  'diff --git a/lib/x.js b/lib/x.js',
  '--- a/lib/x.js',
  '+++ b/lib/x.js',
  '@@ -1,3 +1,4 @@',
  ' function a() {',
  '   return 1',
  ' }',
  '+const X = 3',
].join('\n')

// 新版文件：顶部多了一段 import，位置全挪了
const NEW_FILE = [
  "import x from 'x'",
  '',
  'function a() {',
  '  return 1',
  '}',
  '',
  'function b() {',
  '  return 2',
  '}',
].join('\n')

// 模型给出的「重新对准」补丁
const FIXED_PATCH = [
  '--- a/lib/x.js',
  '+++ b/lib/x.js',
  '@@ -3,3 +3,4 @@',
  ' function a() {',
  '   return 1',
  ' }',
  '+const X = 3',
].join('\n')

// 只挪了位置但**丢了功能**的坏补丁（把 X 换成了 Y）
const LOSSY_PATCH = [
  '--- a/lib/x.js',
  '+++ b/lib/x.js',
  '@@ -3,3 +3,4 @@',
  ' function a() {',
  '   return 1',
  ' }',
  '+const Y = 3',
].join('\n')

console.log('\n=== patchfix：解析 ===')

t('parseUnifiedDiff 能切出文件与 hunk', () => {
  const files = parseUnifiedDiff(OLD_PATCH)
  eq(files.length, 1)
  eq(files[0].path, 'lib/x.js')
  eq(files[0].hunks.length, 1)
  eq(files[0].hunks[0].oldStart, 1)
  eq(files[0].hunks[0].oldLines, 3)
  return true
})

t('parseUnifiedDiff 空输入不炸', () => {
  eq(parseUnifiedDiff('').length, 0)
  eq(parseUnifiedDiff(null).length, 0)
  return true
})

t('declareMarkers 抠出新增加的名字', () => {
  eq(declMarkers(OLD_PATCH).join(','), 'X')
  return true
})

t('declMarkers 不把上下文行里的名字算进来', () => {
  const p = ['--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', ' function keepMe() {', '+const added = 1'].join('\n')
  eq(declMarkers(p).join(','), 'added')
  return true
})

console.log('\n=== patchfix：打补丁 ===')

t('原补丁打在原文件上是干净的（基线）', () => {
  const r = applyHunksToText(OLD_FILE, parseUnifiedDiff(OLD_PATCH)[0].hunks)
  eq(r.ok, true)
  if (!r.text.includes('const X = 3')) throw new Error('没加上')
  return true
})

t('原补丁直接打新版原文对不上（这就是冲突）', () => {
  const r = applyHunksToText(NEW_FILE, parseUnifiedDiff(OLD_PATCH)[0].hunks)
  // 上下文行逐字都在，但位置变了 —— 我们的"对齐"逻辑应该能找到它
  eq(r.ok, true)
  if (!r.text.includes('const X = 3')) throw new Error('没加上')
  return true
})

t('上下文真的不存在时明确报错，不瞎加', () => {
  const hunks = parseUnifiedDiff([
    '--- a/x', '+++ b/x', '@@ -100,3 +100,4 @@',
    ' 这一行在新版里根本没有()', ' 也不存在()', ' 更不存在()', '+const X = 3',
  ].join('\n'))[0].hunks
  const r = applyHunksToText(NEW_FILE, hunks)
  eq(r.ok, false)
  eq(r.errors.length, 1)
  eq(r.text, NEW_FILE)
  return true
})

t('多 hunk 按顺序往后走，不会互相踩', () => {
  const patch = [
    '--- a/x', '+++ b/x',
    '@@ -1,3 +1,4 @@', ' function a() {', '   return 1', ' }', '+const X = 3',
    '@@ -6,3 +7,4 @@', ' function b() {', '   return 2', ' }', '+const Z = 4',
  ].join('\n')
  const r = applyHunksToText(NEW_FILE, parseUnifiedDiff(patch)[0].hunks)
  eq(r.ok, true)
  if (!r.text.includes('const X = 3') || !r.text.includes('const Z = 4')) throw new Error('两个都没加上')
  return true
})

console.log('\n=== patchfix：验收闸门 ===')

t('合格候选：能打上 + 名字都在 → 通过', () => {
  const v = verifyCandidate({ candidatePatch: FIXED_PATCH, newFileText: NEW_FILE, requiredMarkers: ['X'] })
  eq(v.ok, true, v.reason)
  if (!v.text.includes('const X = 3')) throw new Error('结果里没有新增行')
  return true
})

t('丢功能的候选（X 变 Y）→ 拒绝', () => {
  const v = verifyCandidate({ candidatePatch: LOSSY_PATCH, newFileText: NEW_FILE, requiredMarkers: ['X'] })
  eq(v.ok, false)
  if (!/丢了这些/.test(v.reason)) throw new Error('理由不对：' + v.reason)
  return true
})

t('打不上的候选 → 拒绝并说明哪个 hunk', () => {
  const bad = ['--- a/x', '+++ b/x', '@@ -50,3 +50,4 @@', ' 不存在的一行', ' 也不存在', ' 还不存在', '+const X = 3'].join('\n')
  const v = verifyCandidate({ candidatePatch: bad, newFileText: NEW_FILE, requiredMarkers: ['X'] })
  eq(v.ok, false)
  if (!/打不上/.test(v.reason)) throw new Error('理由不对：' + v.reason)
  return true
})

t('不是 diff 的候选 → 拒绝', () => {
  const v = verifyCandidate({ candidatePatch: '好的我改好了：const X = 3', newFileText: NEW_FILE, requiredMarkers: ['X'] })
  eq(v.ok, false)
  return true
})

t('一次改两个文件的候选 → 拒绝（留给人）', () => {
  const two = FIXED_PATCH + '\n' + FIXED_PATCH.replace(/x\.js/g, 'y.js')
  const v = verifyCandidate({ candidatePatch: two, newFileText: NEW_FILE, requiredMarkers: ['X'] })
  eq(v.ok, false)
  if (!/只允许改一个文件/.test(v.reason)) throw new Error('理由不对：' + v.reason)
  return true
})

t('空改动 → 拒绝', () => {
  const noop = ['--- a/x', '+++ b/x', '@@ -3,3 +3,3 @@', ' function a() {', '   return 1', ' }'].join('\n')
  const v = verifyCandidate({ candidatePatch: noop, newFileText: NEW_FILE, requiredMarkers: [] })
  eq(v.ok, false)
  return true
})

console.log('\n=== patchfix：提示词与 JSON ===')

t('提示词里带上了新版原文、旧补丁、intent、必须保留的名字', () => {
  const { system, user, markers } = buildFixPrompt({
    targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
    intentText: '修的是日志涨到 4.6MB', failureNote: 'ERR_PNPM_UNUSED_PATCH',
  })
  if (!system.includes('不要改进')) throw new Error('system 少了铁律')
  if (!user.includes('修的是日志涨到 4.6MB')) throw new Error('user 少了 intent')
  if (!user.includes('ERR_PNPM_UNUSED_PATCH')) throw new Error('user 少了报错')
  if (!user.includes('function a() {')) throw new Error('user 少了新版原文')
  if (!user.includes('- X')) throw new Error('user 少了必须保留的名字')
  eq(markers.join(','), 'X')
  return true
})

t('extractJson 能从带废话的输出里捞出 JSON', () => {
  const obj = extractJson('好的，这是补丁：\n{"patch":"--- a/x","why":"挪了位置"}\n希望有用')
  eq(obj?.why, '挪了位置')
  return true
})

t('extractJson 遇到不完整 JSON 返回 null（不瞎猜）', () => {
  eq(extractJson('{"patch":"--- a/x"'), null)
  return true
})

console.log('\n=== patchfix：fixPatch 全流程（假模型）===')

const fakeAsk = (payload) => async () => ({ ok: true, text: typeof payload === 'string' ? payload : JSON.stringify(payload) })

await ta('模型给出合格补丁 → ok', async () => {
  const r = await fixPatch({
    ask: fakeAsk({ patch: FIXED_PATCH, why: '新版顶部多了 import，整体下移 2 行' }),
    targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
  })
  eq(r.ok, true, r.reason)
  if (!r.patchText.includes('const X = 3')) throw new Error('补丁内容不对')
  return true
})

await ta('模型说「这补丁该退役」→ skipped，不算通过', async () => {
  const r = await fixPatch({
    ask: fakeAsk({ skip: true, why: '上游自己修了同一个 bug' }),
    targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
  })
  eq(r.ok, false)
  eq(r.skipped, true)
  if (!/不该硬迁/.test(r.reason)) throw new Error('理由不对：' + r.reason)
  return true
})

await ta('模型胡写一段话 → 拒绝', async () => {
  const r = await fixPatch({
    ask: fakeAsk('我把补丁挪好了，应该没问题'), targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
  })
  eq(r.ok, false)
  return true
})

await ta('模型给的补丁打不上 → 拒绝（绝不写盘）', async () => {
  const r = await fixPatch({
    ask: fakeAsk({ patch: LOSSY_PATCH, why: '挪好了' }), targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
  })
  eq(r.ok, false)
  return true
})

await ta('模型包了 ```diff 代码围栏也能用', async () => {
  const r = await fixPatch({
    ask: fakeAsk({ patch: '```diff\n' + FIXED_PATCH + '\n```', why: '围栏' }),
    targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
  })
  eq(r.ok, true, r.reason)
  return true
})

await ta('模型没回话 → 明确失败', async () => {
  const r = await fixPatch({
    ask: async () => ({ ok: false, error: '上游 500' }),
    targetPath: 'lib/x.js', patchText: OLD_PATCH, newFileText: NEW_FILE,
  })
  eq(r.ok, false)
  if (!/模型没回话/.test(r.reason)) throw new Error('理由不对：' + r.reason)
  return true
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)