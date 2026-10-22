/**
 * test/p3-memory.mjs —— 记忆双库的自测
 * ============================================================================
 * 记忆这东西的特点是「平时看不出错，等你要用的时候才发现它一直是空的」。
 * 所以测试必须盯三件事：
 *   ① 写进去的东西读得出来（而且是原样）
 *   ② 坏数据不能带崩整个库（JSONL 一行坏、md 少个 --- 都得能活）
 *   ③ 检索得真的按相关性排序（不然等于没检索）
 *
 * 全部在临时目录里跑，不碰主人任何真实数据。
 * ============================================================================
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  normalizeEntry, appendLedger, readLedger, summarizeLedger, ledgerStats,
  parseFrontmatter, buildErrorDoc, saveErrorDoc, listErrorDocs, searchErrors,
  renderErrorsForPrompt, createMemory, LEDGER_FIELDS, errorFileName,
} from '../lib/memory.js'

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
    fails.push({ name, error: String(e?.stack ?? e) })
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e)}`)
  }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m ?? ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`) }

function tmpDir(tag) {
  const d = join(tmpdir(), `dsh-ug-mem-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(d, { recursive: true })
  return d
}

console.log('\n记忆双库：更新档案（ledger）')

t('normalizeEntry：缺的字段填 null，不留下 undefined', () => {
  const e = normalizeEntry({ name: 'dsh-foo', from: '1.0.0' })
  for (const k of LEDGER_FIELDS) {
    if (e[k] === undefined) throw new Error(`字段 ${k} 还是 undefined —— JSON 序列化时会消失`)
  }
  eq(e.name, 'dsh-foo')
  eq(e.to, null)
  eq(Object.keys(e).length, LEDGER_FIELDS.length)
})

t('appendLedger + readLedger：写进去能原样读出来', () => {
  const dir = tmpDir('rw')
  try {
    const p = join(dir, 'ledger.jsonl')
    appendLedger(p, { name: 'dsh-a', from: '1.0.0', to: '1.0.1', result: 'applied' })
    appendLedger(p, { name: 'dsh-b', from: '2.0.0', to: '3.0.0', result: 'rolled-back', rolledBack: true })
    const rows = readLedger(p)
    eq(rows.length, 2)
    // 新的排前面
    eq(rows[0].name, 'dsh-b')
    eq(rows[1].name, 'dsh-a')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('readLedger：坏行跳过，不影响其它行（JSONL 的核心好处）', () => {
  const dir = tmpDir('bad')
  try {
    const p = join(dir, 'ledger.jsonl')
    appendLedger(p, { name: 'dsh-good-1', result: 'applied' })
    appendFileSync(p, '{这行是坏的, 少个引号\n', 'utf8')
    appendFileSync(p, 'not json at all\n', 'utf8')
    appendLedger(p, { name: 'dsh-good-2', result: 'applied' })
    const rows = readLedger(p)
    eq(rows.length, 2, '两行坏数据不该带崩整个档案')
    eq(rows.map((r) => r.name).sort(), ['dsh-good-1', 'dsh-good-2'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('readLedger：文件不存在返回空数组，不抛', () => {
  eq(readLedger(join(tmpdir(), 'definitely-not-here-xyz', 'ledger.jsonl')), [])
})

t('readLedger：能按包名筛、能限量', () => {
  const dir = tmpDir('filter')
  try {
    const p = join(dir, 'ledger.jsonl')
    for (let i = 0; i < 5; i++) appendLedger(p, { name: 'dsh-a', to: `1.0.${i}` })
    for (let i = 0; i < 3; i++) appendLedger(p, { name: 'dsh-b', to: `2.0.${i}` })
    eq(readLedger(p, { name: 'dsh-a' }).length, 5)
    eq(readLedger(p, { name: 'dsh-b' }).length, 3)
    eq(readLedger(p, { name: 'dsh-a', limit: 2 }).length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('summarizeLedger：算得出这包的「事故率」', () => {
  const dir = tmpDir('sum')
  try {
    const p = join(dir, 'ledger.jsonl')
    appendLedger(p, { name: 'dsh-x', result: 'applied', rolledBack: false })
    appendLedger(p, { name: 'dsh-x', result: 'applied', rolledBack: false })
    appendLedger(p, { name: 'dsh-x', result: 'rolled-back', rolledBack: true })
    appendLedger(p, { name: 'dsh-x', result: 'refused' })
    appendLedger(p, { name: 'dsh-other', result: 'applied' })

    const s = summarizeLedger(p, 'dsh-x')
    eq(s.updates, 4)
    eq(s.rollbacks, 1)
    eq(s.failures, 1)
    eq(s.accidents, 2)
    eq(s.accidentRate, 0.5, '4 次更新里出事 2 次')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('summarizeLedger：没更新过的包返回全 0，不除零', () => {
  const dir = tmpDir('zero')
  try {
    const p = join(dir, 'ledger.jsonl')
    const s = summarizeLedger(p, 'never-seen')
    eq(s.updates, 0)
    eq(s.accidentRate, 0, '0 次更新时事故率必须是 0，不能是 NaN')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('ledgerStats：管理台首页要的总数/包数/结果分布', () => {
  const dir = tmpDir('stats')
  try {
    const p = join(dir, 'ledger.jsonl')
    appendLedger(p, { name: 'a', result: 'applied' })
    appendLedger(p, { name: 'b', result: 'applied' })
    appendLedger(p, { name: 'a', result: 'rolled-back' })
    const st = ledgerStats(p)
    eq(st.total, 3)
    eq(st.packages, 2)
    eq(st.byResult.applied, 2)
    eq(st.byResult['rolled-back'], 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('\n记忆双库：错误知识库（errors）')

t('parseFrontmatter：能解出数组、字符串、普通值', () => {
  const doc = buildErrorDoc({
    title: '更新后表情包发不出去',
    packages: ['dsh-meme'],
    symptoms: ['点表情没反应', 'meme 报错'],
    versions: ['0.1.50 -> 0.1.51'],
    severity: 'high',
    body: '## 症状\n点了没反应\n\n## 根因\n宿主 API 改名了',
  })
  const { meta, body } = parseFrontmatter(doc)
  eq(meta.title, '更新后表情包发不出去')
  eq(meta.packages, ['dsh-meme'])
  eq(meta.symptoms, ['点表情没反应', 'meme 报错'])
  eq(meta.severity, 'high')
  if (!body.includes('宿主 API 改名了')) throw new Error('正文丢了')
})

t('parseFrontmatter：没有 frontmatter 的纯 markdown 不崩', () => {
  const { meta, body } = parseFrontmatter('# 就是一段普通文字\n内容')
  eq(meta, {})
  if (!body.includes('普通文字')) throw new Error('正文没原样返回')
})

t('parseFrontmatter：只有开头 --- 没有结尾 --- 不崩', () => {
  const { meta } = parseFrontmatter('---\ntitle: "x"\n没结尾')
  eq(meta, {}, '不完整的 frontmatter 应该当没有处理')
})

t('errorFileName：中文标题也能变成合法文件名', () => {
  const f = errorFileName('更新后表情包发不出去！', new Date('2026-10-22T06:00:00Z'))
  if (!f.endsWith('.md')) throw new Error('没 .md 后缀')
  if (/[\\/:*?"<>|]/.test(f)) throw new Error(`文件名里有非法字符：${f}`)
  if (!f.includes('2026-10-22')) throw new Error(`文件名里没有日期：${f}`)
  if (!f.includes('更新后表情包')) throw new Error(`中文被吞了：${f}`)
})

t('saveErrorDoc + listErrorDocs：存进去能读回来，新的排前面', () => {
  const dir = tmpDir('err')
  try {
    saveErrorDoc(dir, { title: '旧问题', packages: ['a'], at: '2026-01-01T00:00:00Z', body: '旧' })
    saveErrorDoc(dir, { title: '新问题', packages: ['b'], at: '2026-06-01T00:00:00Z', body: '新' })
    const docs = listErrorDocs(dir)
    eq(docs.length, 2)
    eq(docs[0].meta.title, '新问题')
    eq(docs[1].meta.title, '旧问题')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('listErrorDocs：目录不存在返回空数组', () => {
  eq(listErrorDocs(join(tmpdir(), 'nope-xyz-123', 'errors')), [])
})

t('searchErrors：包名命中排最前（比关键词命中重要得多）', () => {
  const dir = tmpDir('search')
  try {
    saveErrorDoc(dir, { title: '别的包的问题', packages: ['dsh-other'], symptoms: ['闪退'], body: '闪退' })
    saveErrorDoc(dir, { title: '这个包的问题', packages: ['dsh-target'], symptoms: ['不显示'], body: '不显示' })
    const hits = searchErrors(dir, { name: 'dsh-target', keywords: ['闪退'] })
    if (hits.length < 2) throw new Error('两条都该命中')
    eq(hits[0].meta.packages[0], 'dsh-target', '包名命中必须排第一')
    if (!(hits[0].score > hits[1].score)) throw new Error('包名命中的分数应该更高')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('searchErrors：完全无关的病历不返回', () => {
  const dir = tmpDir('search2')
  try {
    saveErrorDoc(dir, { title: '完全无关', packages: ['dsh-zzz'], symptoms: ['别的东西'], body: '内容' })
    eq(searchErrors(dir, { name: 'dsh-target', keywords: ['不存在词'] }).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('searchErrors：limit 生效', () => {
  const dir = tmpDir('search3')
  try {
    for (let i = 0; i < 10; i++) {
      saveErrorDoc(dir, { title: `问题${i}`, packages: ['dsh-a'], symptoms: ['闪退'], body: '闪退' })
    }
    eq(searchErrors(dir, { name: 'dsh-a', limit: 3 }).length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('renderErrorsForPrompt：喂模型的是精简版，不是整篇 md', () => {
  const dir = tmpDir('render')
  try {
    const longBody = Array.from({ length: 60 }, (_, i) => `第 ${i} 行无关内容`).join('\n')
    saveErrorDoc(dir, { title: '长病历', packages: ['dsh-a'], symptoms: ['闪退'], body: longBody })
    const docs = listErrorDocs(dir)
    const out = renderErrorsForPrompt(docs)
    const lines = out.split('\n').length
    if (lines > 25) throw new Error(`喂给模型的太长了：${lines} 行（应该是精简版）`)
    if (!out.includes('长病历')) throw new Error('标题丢了')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('renderErrorsForPrompt：空输入返回空串，不返回半截标题', () => {
  eq(renderErrorsForPrompt([]), '')
  eq(renderErrorsForPrompt(null), '')
})

console.log('\n记忆双库：门面（createMemory）')

t('createMemory：两个库路径在同一根目录下，互不干扰', () => {
  const dir = tmpDir('facade')
  try {
    const m = createMemory(dir)
    eq(m.ledgerPath, join(dir, 'ledger.jsonl'))
    eq(m.errorsDir, join(dir, 'errors'))
    m.append({ name: 'dsh-a', result: 'applied' })
    m.saveError({ title: '出事了', packages: ['dsh-a'], body: '内容' })
    eq(m.read().length, 1)
    eq(m.listErrors().length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('createMemory.contextFor：一次拿齐审查模型需要的记忆', () => {
  const dir = tmpDir('ctx')
  try {
    const m = createMemory(dir)
    m.append({ name: 'dsh-a', result: 'rolled-back', rolledBack: true })
    m.append({ name: 'dsh-a', result: 'applied' })
    m.saveError({ title: '上次更新炸了', packages: ['dsh-a'], symptoms: ['白屏'], body: '根因是 xxx' })

    const ctx = m.contextFor('dsh-a', ['白屏'])
    eq(ctx.summary.updates, 2)
    eq(ctx.summary.rollbacks, 1)
    if (ctx.errors.length !== 1) throw new Error(`应该检索到 1 份病历，实际 ${ctx.errors.length}`)
    if (!ctx.prompt.includes('上次更新炸了')) throw new Error('prompt 里没带上病历')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

t('createMemory：根目录不存在时，读不抛、写会自动建', () => {
  const base = tmpDir('auto')
  const nested = join(base, 'deep', 'nested', 'dir')
  try {
    const m = createMemory(nested)
    eq(m.read(), [], '目录不存在时读应该返回空数组')
    const r = m.append({ name: 'x', result: 'applied' })
    if (!r.ok) throw new Error(`写失败：${r.error}`)
    if (!existsSync(nested)) throw new Error('写的时候没自动建目录')
    eq(m.read().length, 1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

console.log('\n────────────────────────────────────────')
if (fail > 0) {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const f of fails) console.log(`\n  ${f.name}\n  ${f.error}`)
  process.exitCode = 1
} else {
  console.log(`✅ ${pass} 通过 / 0 失败`)
}
