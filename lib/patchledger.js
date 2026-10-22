/**
 * lib/patchledger.js —— 补丁账本：每个补丁**为什么存在**、现在**能不能用**
 * ============================================================================
 * 🔴 这个文件解决的问题，是主人那句「原本的补丁打回去不要被覆盖」里最容易被忽略的一半：
 *
 *   **光有 .patch 文件不够，还得有"意图"**。
 *   半年后上游把 bug 修了，我们那个补丁还在 → 打上去 = 冲突 = 反而搞坏。
 *   到时候没人记得"这补丁当初为什么打"。所以每个补丁必须配一份 intent：
 *   修什么、上游 issue 号、什么条件下该退役。
 *
 *   有了 intent，审查模型才能回答"上游这次是不是自己修了" —— 这是它最该干的活。
 *
 * 目录约定（跟 P0 落地的完全一致，不另起炉灶）：
 *   <profile>/patches/dsh-pocket@2.12.0.patch     ← pnpm 认这个
 *   <profile>/patches/dsh-pocket@2.12.0.intent.md ← 我们认这个
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 补丁文件名格式：`包名@版本.patch`（pnpm patchedDependencies 的 key 就是这个） */
const PATCH_RE = /^(.+)@([^@]+)\.patch$/i

/** 把 patchedDependencies 的 key（`dsh-pocket@2.12.0`）拆成 {name, version} */
export function parsePatchKey(key) {
  const at = key.lastIndexOf('@')
  if (at <= 0) return { name: key, version: null }
  return { name: key.slice(0, at), version: key.slice(at + 1) }
}

/** 补丁在磁盘上的路径（相对 profile 目录，因为 pnpm 的路径是相对 package.json 的） */
export function patchPaths(profileDir, key) {
  return {
    patch: join(profileDir, 'patches', `${key}.patch`),
    intent: join(profileDir, 'patches', `${key}.intent.md`),
  }
}

/**
 * 读一个补丁的意图说明。
 * 格式故意用 markdown + 简单 frontmatter —— 主人能直接改，模型也能直接读。
 */
export function readIntent(profileDir, key) {
  const { intent: path } = patchPaths(profileDir, key)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
    const meta = {}
    let body = raw
    if (fm) {
      body = raw.slice(fm[0].length)
      for (const line of fm[1].split(/\r?\n/)) {
        const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim())
        if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
      }
    }
    return {
      path,
      meta,
      body: body.trim(),
      // 常用字段的便捷访问（读不到就 null，别编）
      issue: meta.issue ?? null,
      retireWhen: meta.retireWhen ?? meta['retire-when'] ?? null,
      summary: meta.summary ?? null,
    }
  } catch (e) {
    return { path, meta: {}, body: '', error: String(e?.message ?? e) }
  }
}

/** 补丁改了哪些文件（从 unified diff 的 `+++` / `---` 头里抠，不靠猜） */
export function patchFiles(patchText) {
  const files = new Set()
  for (const line of String(patchText ?? '').split(/\r?\n/)) {
    const m = /^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\t\n]+)/.exec(line)
    if (m) {
      const p = m[1].trim()
      if (p && p !== '/dev/null') files.add(p.replace(/^[ab]\//, ''))
    }
  }
  return [...files]
}

/** 补丁的行数规模（判断"这个补丁多大、重放风险多高"） */
export function patchStats(patchText) {
  const lines = String(patchText ?? '').split(/\r?\n/)
  let added = 0; let removed = 0; let hunks = 0
  for (const l of lines) {
    if (l.startsWith('@@')) hunks++
    else if (l.startsWith('+') && !l.startsWith('+++')) added++
    else if (l.startsWith('-') && !l.startsWith('---')) removed++
  }
  return { added, removed, hunks, lines: lines.length }
}

/**
 * 盘一遍这个 profile 的所有补丁（磁盘 + package.json 双向核对）。
 *
 * 🔴 为什么要双向核对：
 *   - package.json 里有、磁盘上没 .patch  → pnpm install 会直接失败
 *   - 磁盘上有 .patch、package.json 里没登记 → 这个补丁**永远不会被应用**（静默失效，最危险）
 */
export function scanPatches(profileDir, patchedDeps) {
  const dir = join(profileDir, 'patches')
  const onDisk = []
  try {
    for (const f of readdirSync(dir)) {
      const m = PATCH_RE.exec(f)
      if (m) onDisk.push({ key: `${m[1]}@${m[2]}`, name: m[1], version: m[2], file: join(dir, f) })
    }
  } catch { /* 没有 patches 目录 = 没有补丁 */ }

  const registered = Object.entries(patchedDeps ?? {}).map(([key, rel]) => {
    const { name, version } = parsePatchKey(key)
    return { key, name, version, registeredPath: rel }
  })

  const byKey = new Map()
  for (const p of onDisk) byKey.set(p.key, { ...p, registered: false })
  for (const r of registered) {
    const hit = byKey.get(r.key)
    if (hit) hit.registered = true
    else byKey.set(r.key, { ...r, file: null, registered: true })
  }

  const out = []
  for (const entry of byKey.values()) {
    const patchText = entry.file && existsSync(entry.file) ? readFileSync(entry.file, 'utf8') : null
    const intent = readIntent(profileDir, entry.key)
    // issues = 补丁本身坏了（打不上 / 静默失效）→ 红色「有问题」
    // notes  = 补丁是好的，只是缺说明之类的保养建议 → 黄色「建议补充」，不吓人
    const issues = []
    const notes = []
    if (entry.registered && !entry.file) issues.push('package.json 登记了但磁盘上没有 .patch 文件 → pnpm install 会直接失败')
    if (!entry.registered && entry.file) issues.push('磁盘上有 .patch 但 package.json 没登记 → 这个补丁永远不会被应用（静默失效）')
    if (entry.file && !intent) notes.push('没有 intent.md → 半年后没人记得这补丁为什么打')

    out.push({
      key: entry.key,
      name: entry.name,
      version: entry.version,
      registered: entry.registered,
      patchPath: entry.file,
      intentPath: intent?.path ?? null,
      hasPatch: !!patchText,
      intent: intent?.summary ?? intent?.body?.slice(0, 200) ?? null,
      issue: intent?.issue ?? null,
      retireWhen: intent?.retireWhen ?? null,
      files: patchText ? patchFiles(patchText) : [],
      stats: patchText ? patchStats(patchText) : null,
      issues,
      notes,
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** 取某个包的所有补丁（按包名，不限版本 —— 旧版本的补丁也要能看到，好判断怎么迁移） */
export function patchesFor(profileDir, patchedDeps, packageName) {
  return scanPatches(profileDir, patchedDeps).filter((p) => p.name === packageName)
}

/**
 * 写一份 intent.md 模板（P2 迁移旧补丁时用；也可以给主人手写打底）。
 */
export function writeIntentTemplate(profileDir, key, { issue = '', retireWhen = '', summary = '' } = {}) {
  const { intent: path } = patchPaths(profileDir, key)
  if (existsSync(path)) return { path, created: false }
  mkdirSync(join(profileDir, 'patches'), { recursive: true })
  const text = `---
issue: ${issue}
retireWhen: ${retireWhen || '上游自己修好这个问题时'}
summary: ${summary}
---

## 修的是什么问题

（写清楚：什么现象、什么时候触发、影响谁）

## 为什么不能等上游

（写清楚：等不起的原因 / 上游态度 / 我们绕不过去）

## 补丁做了什么

（写清楚：改了哪几行、改成什么、为什么这样改）

## 退役条件

（写清楚：看到什么就可以把这个补丁删了 —— 这是审查模型判断"上游是否已修"的唯一依据）
`
  writeFileSync(path, text, 'utf8')
  return { path, created: true }
}

/**
 * 生成补丁的**上下文摘要**（喂给审查模型用，不是全文）。
 * 全文动辄 300 行，模型看前 50 行就够判断"改的是哪一片"。
 */
export function patchBrief(p, { maxChars = 6000 } = {}) {
  if (!p?.patchPath) return null
  let text = ''
  try { text = readFileSync(p.patchPath, 'utf8') } catch { return null }
  const brief = text.length > maxChars ? text.slice(0, maxChars) + '\n…（截断）' : text
  return {
    id: `${p.name}@${p.version}`,
    files: p.files,
    stats: p.stats,
    intent: p.intent,
    issue: p.issue,
    retireWhen: p.retireWhen,
    patchText: brief,
  }
}
