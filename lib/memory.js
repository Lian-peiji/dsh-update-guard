/**
 * lib/memory.js —— 记忆双库
 * ============================================================================
 * 主人的原话（m00002）：「天天都上当，当当不一样」。
 *
 * 这句话翻译成需求就是：**同一个坑不能踩两次，而且踩过要知道怎么爬出来。**
 *
 * 所以记忆不是一个大杂烩，是两个库，读者不同：
 *
 *   ┌─────────────────┬──────────────┬──────────────┬────────────────────────┐
 *   │ 库              │ 格式         │ 谁读         │ 内容                    │
 *   ├─────────────────┼──────────────┼──────────────┼────────────────────────┤
 *   │ 更新档案 ledger │ .jsonl       │ 机器         │ 包/旧→新/判决/理由/      │
 *   │                 │              │              │ 补丁动作/结果/是否回滚    │
 *   │ 错误知识库 errs │ *.md         │ 人和模型     │ 症状关键词→根因→快修     │
 *   └─────────────────┴──────────────┴──────────────┴────────────────────────┘
 *
 * 为什么不全塞进一个 JSON：
 *   档案要**结构化查询**（「这包最近三次更新都干了啥」「回滚率多高」），
 *   JSONL 一行一条，追加不重写，读坏了也只坏一行。
 *   病历要**人也能看懂、能手改**，Markdown 带 frontmatter，模型直接吃正文。
 *
 * 为什么落盘在 $DSH_HOME 而不是包目录：
 *   包目录会被 pnpm 重装覆盖。记忆住在包目录里 = 一更新就失忆，
 *   而这插件存在的意义正是「记住更新发生过什么」。**记忆必须活得比插件久。**
 * ============================================================================
 */
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync,
  readdirSync, rmSync, renameSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'

// ─────────────────────────────────────────────────────────────────────────────
//  更新档案（ledger.jsonl）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 档案条目的固定形状。
 *
 * 字段一个都不能少，哪怕是 null —— 因为后面要拿它做统计（回滚率、按包聚合），
 * 缺字段会让统计代码到处写 `?.` 兜底，越写越丑，最后没人敢改。
 */
export const LEDGER_FIELDS = [
  'at',          // ISO 时间
  'name',        // 包名
  'from',        // 旧版本
  'to',          // 新版本
  'bump',        // patch | minor | major | unknown
  'verdict',     // install | hold | skip（模型的判决）
  'reason',      // 一句话理由
  'risks',       // 模型说的风险（数组）
  'predictedBugs', // 模型预测的 bug（数组）
  'patchActions', // [{ id, action: replay|rewrite|retire, reason }]
  'result',      // applied | rolled-back | refused | noop | trial-failed | unknown
  'rolledBack',  // 布尔：是不是被自动退回了
  'trialMs',     // 试跑耗时（没有试跑就是 null）
  'elapsedMs',   // 整个操作耗时
  'error',       // 失败原因（成功就是 null）
  'source',      // tool | auto | manual —— 这次是谁触发的
  'kind',        // review | trial | apply | apply-refused | rollback（哪一步记的）
  'note',        // 人话备注（模型的一句话结论 / 失败原因摘要）
  'snapshot',    // 备份目录（回滚时能顺着这条找到退回到哪）
]

/** 把一条记录补齐成固定形状（缺的填 null，不写 undefined —— JSON 里 undefined 会消失） */
export function normalizeEntry(e) {
  const out = {}
  for (const k of LEDGER_FIELDS) {
    const v = e?.[k]
    out[k] = v === undefined ? null : v
  }
  return out
}

/**
 * 追加一条更新档案。
 *
 * 🔴 为什么用 appendFileSync 而不是「读全量 → push → 写回」：
 *    后者在进程被 kill（主人重启 DSH 很频繁）时会丢掉整份档案，
 *    而追加写最多丢最后一行。记忆的第一要求是**别丢**，不是好看。
 */
export function appendLedger(ledgerPath, entry) {
  const rec = normalizeEntry(entry)
  // 🔴 `at` 兜底 + 保证单调递增。
  //    同一毫秒内连续写两条（批量更新插件时必然发生）会让「新的排前面」失效 ——
  //    实测就是这条：两条记录的 at 完全相同，排序退化成写入顺序的偶然结果。
  //    解决：新记录的 at 若 <= 上一条，就往后推 1ms。时间戳本来是给人看的，
  //    差 1ms 没人看得出来，但排序从此稳定。
  if (!rec.at) rec.at = new Date().toISOString()
  try {
    const last = lastAt(ledgerPath)
    if (last && String(rec.at) <= last) {
      const t = new Date(new Date(last).getTime() + 1).toISOString()
      if (String(t) > String(rec.at)) rec.at = t
    }
  } catch { /* 拿不到上一条就用原时间 */ }

  try {
    mkdirSync(dirname(ledgerPath), { recursive: true })
    appendFileSync(ledgerPath, JSON.stringify(rec) + '\n', 'utf8')
    return { ok: true, record: rec }
  } catch (e) {
    // 记不下就算了 —— 绝不能因为写档案把更新流程搞崩。
    // 但要把失败原因带回去，不然「档案悄悄不写了」没人会发现。
    return { ok: false, error: String(e?.message ?? e), record: rec }
  }
}

/** 读最后一条的 at（只读文件尾部，不解析全量） */
function lastAt(ledgerPath) {
  if (!existsSync(ledgerPath)) return null
  let raw
  try { raw = readFileSync(ledgerPath, 'utf8') } catch { return null }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s)
      if (rec?.at) return String(rec.at)
    } catch { /* 坏行继续往前找 */ }
  }
  return null
}

/**
 * 读档案，可筛选、可限量。
 *
 * 坏行直接跳过而不是整份报错：JSONL 的好处就是一行坏了不影响别的行，
 * 要是因为某一行少个引号就看不到全部历史，那这格式白选了。
 */
export function readLedger(ledgerPath, { name, limit = 0, since = null } = {}) {
  if (!existsSync(ledgerPath)) return []
  let raw
  try { raw = readFileSync(ledgerPath, 'utf8') } catch { return [] }

  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let rec
    try { rec = JSON.parse(s) } catch { continue } // 坏行跳过
    if (name && rec.name !== name) continue
    if (since && String(rec.at ?? '') < String(since)) continue
    out.push(rec)
  }
  // 新的排前面：看历史时最关心「最近发生了什么」
  out.sort((a, b) => (String(a.at) < String(b.at) ? 1 : String(a.at) > String(b.at) ? -1 : 0))
  return limit > 0 ? out.slice(0, limit) : out
}

/**
 * 按包聚合出「这包的老底」。
 *
 * 这是审查模型最需要的东西：不是「历史上发生过什么」的流水账，
 * 而是**判断这个包危不危险**的几个数字。
 *
 * @returns {{updates, rollbacks, failures, lastAt, lastResult, accidentRate}}
 *   accidentRate = 出事次数 / 更新次数。模型看到 0.5 就知道这包不能随便碰。
 */
export function summarizeLedger(ledgerPath, name) {
  const rows = readLedger(ledgerPath, { name })
  const updates = rows.length
  const rollbacks = rows.filter((r) => r.rolledBack === true || r.result === 'rolled-back').length
  const failures = rows.filter((r) => r.result === 'refused' || r.result === 'trial-failed').length
  const accidents = rollbacks + failures
  return {
    updates,
    rollbacks,
    failures,
    accidents,
    lastAt: rows[0]?.at ?? null,
    lastResult: rows[0]?.result ?? null,
    accidentRate: updates > 0 ? Math.round((accidents / updates) * 100) / 100 : 0,
  }
}

/**
 * 档案整体的统计（管理台首页要显示的数字）。
 */
export function ledgerStats(ledgerPath) {
  const rows = readLedger(ledgerPath)
  const byResult = {}
  for (const r of rows) {
    const k = String(r.result ?? 'unknown')
    byResult[k] = (byResult[k] ?? 0) + 1
  }
  const pkgs = new Set(rows.map((r) => r.name).filter(Boolean))
  return {
    total: rows.length,
    packages: pkgs.size,
    byResult,
    firstAt: rows.length ? rows[rows.length - 1].at : null,
    lastAt: rows.length ? rows[0].at : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  错误知识库（errors/*.md）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一份病历的 frontmatter 长这样：
 *
 *   ---
 *   title: "更新后表情包发送失败"
 *   packages: ["dsh-meme"]
 *   symptoms: ["发送表情包没反应", "meme 报错"]
 *   versions: ["0.1.50 -> 0.1.51"]
 *   severity: high
 *   createdAt: 2026-10-22T...
 *   ---
 *
 * 正文四段：症状 / 根因 / 快修 / 关联补丁
 *
 * 🔴 为什么用 frontmatter 而不是纯 JSON：
 *    主人自己也想看得懂、能手改、能直接扔给模型当上下文。
 *    纯 JSON 一改就少个逗号全废；Markdown 改坏了顶多索引不到，正文还在。
 */

/** 极简 frontmatter 解析（只支持我们自己的格式，不引第三方 yaml） */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  if (!src.startsWith('---')) return { meta: {}, body: src }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: src }
  const head = src.slice(3, end)
  const body = src.slice(end + 4).replace(/^\s*\n/, '')

  const meta = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      // 行内数组：["a", "b"]
      try {
        val = JSON.parse(val)
      } catch {
        val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      }
    } else if (/^".*"$/.test(val) || /^'.*'$/.test(val)) {
      val = val.slice(1, -1)
    }
    meta[key] = val
  }
  return { meta, body }
}

/** 把 meta + body 组装回一份可落盘的 markdown */
export function buildErrorDoc({ title, packages = [], symptoms = [], versions = [], severity = 'medium', createdAt = new Date().toISOString(), lastSeenAt = null, occurrences = 1, body = '' }) {
  const q = (s) => JSON.stringify(String(s))
  const lines = [
    '---',
    `title: ${q(title || '（未命名）')}`,
    `packages: [${packages.map(q).join(', ')}]`,
    `symptoms: [${symptoms.map(q).join(', ')}]`,
    `versions: [${versions.map(q).join(', ')}]`,
    `severity: ${severity}`,
    `createdAt: ${createdAt}`,
  ]
  // 只在真的重复发生时才写这两个字段 —— 一次性问题不需要"第几次"这种噪音
  if (lastSeenAt) lines.push(`lastSeenAt: ${lastSeenAt}`)
  if (Number(occurrences) > 1) lines.push(`occurrences: ${Number(occurrences)}`)
  lines.push(
    '---',
    '',
    String(body || '').trim(),
    '',
  )
  return lines.join('\n')
}

/** 病历文件名：可读 + 不会撞 */
export function errorFileName(title, at = new Date()) {
  const slug = String(title || 'error')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'error'
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  return `${stamp}-${slug}.md`
}

/**
 * 写一份病历。
 *
 * 接受两种输入：
 *   - **对象** → 内部渲染成 markdown
 *   - **已渲染好的 markdown 字符串** → 从 frontmatter 反解，原样落盘
 *
 * 🔴 为什么要兼容字符串：
 *    `buildErrorDoc()` 返回的是**渲染好的文本**，名字看起来像"造对象"，实际不是。
 *    第一版这里只认对象，于是 `saveError(buildErrorDoc({...}))` 会静默写出一份
 *    标题为"（未命名）"、正文全空的病历 —— 不报错、不丢文件、就是没内容。
 *    这种"看起来成功"的失败最难查，所以这里两种都收，并且在拿不到 title 时直接报错。
 *
 * 🔴 同一个坑踩第二次时不新建文件，而是**续写**：
 *    主人要的是「这个坑踩了 3 次」这个信息，不是三份内容雷同的 md 互相打架。
 *    续写时保留最新一次的正文（最贴近现状），并把症状/包名/版本合并去重。
 */
export function saveErrorDoc(errorsDir, doc) {
  try {
    const isText = typeof doc === 'string'
    const text = isText ? doc : buildErrorDoc(doc)
    const parsed = parseFrontmatter(text)

    const title = String((isText ? parsed.meta.title : doc.title) ?? '').trim()
    if (!title) {
      return { ok: false, error: '病历没有 title —— 没标题的病历以后检索不到，等于白记' }
    }

    const atRaw = isText ? parsed.meta.createdAt : (doc.at ?? doc.createdAt)
    const atDate = atRaw ? new Date(atRaw) : new Date()
    const at = Number.isNaN(atDate.getTime()) ? new Date() : atDate

    mkdirSync(errorsDir, { recursive: true })

    // ① 先找有没有同标题的旧病历
    const existing = findByTitle(errorsDir, title)
    if (existing) {
      const merged = mergeDoc(existing, { text, meta: isText ? parsed.meta : doc, at })
      writeFileSync(existing.file, merged, 'utf8')
      return { ok: true, file: existing.file, occurrences: occurrenceOf(merged), merged: true }
    }

    // ② 没有就新建
    const file = join(errorsDir, errorFileName(title, at))
    writeFileSync(file, text, 'utf8')
    return { ok: true, file, occurrences: 1, merged: false }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 按标题找已有病历（标题是"同一个坑"的身份） */
function findByTitle(errorsDir, title) {
  let names = []
  try { names = readdirSync(errorsDir).filter((f) => f.endsWith('.md')) } catch { return null }
  for (const f of names) {
    const full = join(errorsDir, f)
    let text
    try { text = readFileSync(full, 'utf8') } catch { continue }
    const { meta } = parseFrontmatter(text)
    if (String(meta.title ?? '').trim() === String(title).trim()) return { file: full, text, meta }
  }
  return null
}

function occurrenceOf(text) {
  const n = Number(parseFrontmatter(text).meta.occurrences ?? 1)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** 把新一次的病历合并进旧的那份 */
function mergeDoc(existing, { text, meta, at }) {
  const old = existing.meta ?? {}
  const neu = meta ?? {}
  const uniq = (a, b) => {
    const out = []
    for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      const s = String(v ?? '').trim()
      if (s && !out.includes(s)) out.push(s)
    }
    return out
  }
  const next = {
    title: old.title ?? neu.title,
    packages: uniq(old.packages, neu.packages),
    symptoms: uniq(old.symptoms, neu.symptoms),
    versions: uniq(old.versions, neu.versions),
    // 严重程度取更严重的那个：同一个坑第二次发生时更严重，不能因为这次轻就降级
    severity: worstSeverity(old.severity, neu.severity),
    createdAt: old.createdAt ?? neu.createdAt ?? at.toISOString(),
    lastSeenAt: at.toISOString(),
    occurrences: occurrenceOf(existing.text) + 1,
    // 正文用最新的 —— 最新一次的症状和修法才贴近现状
    body: parseFrontmatter(text).body || parseFrontmatter(existing.text).body || '',
  }
  return buildErrorDoc(next)
}

const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 }
function worstSeverity(a, b) {
  const ra = SEV_RANK[String(a)] ?? 1
  const rb = SEV_RANK[String(b)] ?? 1
  return Object.keys(SEV_RANK).find((k) => SEV_RANK[k] === Math.max(ra, rb)) ?? 'medium'
}

/** 读全部病历（按创建时间新→旧） */
export function listErrorDocs(errorsDir) {
  if (!existsSync(errorsDir)) return []
  let names = []
  try { names = readdirSync(errorsDir).filter((f) => f.endsWith('.md')) } catch { return [] }

  const out = []
  for (const f of names) {
    const full = join(errorsDir, f)
    let text
    try { text = readFileSync(full, 'utf8') } catch { continue }
    const { meta, body } = parseFrontmatter(text)
    out.push({ file: full, filename: f, meta, body })
  }
  out.sort((a, b) => (String(a.meta.createdAt ?? '') < String(b.meta.createdAt ?? '') ? 1 : -1))
  return out
}

/**
 * 按「包名 + 关键词」检索病历 —— 审查模型开饭前的那一勺。
 *
 * 打分规则（简单但有效）：
 *   - 包名命中：+10（这个包出过事，比什么都重要）
 *   - 症状词命中：+3 每个
 *   - 标题词命中：+2 每个
 *
 * @returns 按分数降序，最多 limit 条
 */
export function searchErrors(errorsDir, { name, keywords = [], limit = 5 } = {}) {
  const docs = listErrorDocs(errorsDir)
  const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean)

  const scored = []
  for (const d of docs) {
    let score = 0
    const pkgs = Array.isArray(d.meta.packages) ? d.meta.packages : [d.meta.packages].filter(Boolean)
    if (name && pkgs.some((p) => String(p) === String(name))) score += 10

    const hay = [
      ...(Array.isArray(d.meta.symptoms) ? d.meta.symptoms : []),
      String(d.meta.title ?? ''),
      d.body,
    ].join(' ').toLowerCase()

    for (const k of kws) if (hay.includes(k)) score += 3
    for (const k of kws) if (String(d.meta.title ?? '').toLowerCase().includes(k)) score += 2

    if (score > 0) scored.push({ ...d, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * 把病历渲染成喂给模型的一段文本。
 *
 * 为什么单独一个函数：喂模型的东西要**短**。整篇 md 塞进去，
 * 模型会被无关段落带偏，还白烧 token。这里只给症状/根因/快修三段。
 */
export function renderErrorsForPrompt(docs) {
  if (!docs || docs.length === 0) return ''
  const parts = ['## 这个包以前出过的事（病历，供你判断风险）']
  for (const d of docs) {
    const n = Number(d.meta?.occurrences ?? 1)
    // 「踩了 N 次」必须让模型看见 —— 同一个坑反复踩，比一次性的严重问题更能说明
    // 这次更新会不会又把它带回来。这是判断「值不值得冒险」的关键权重。
    const times = n > 1 ? `，**已经踩过 ${n} 次**` : ''
    parts.push(`\n### ${d.meta.title ?? d.filename}（${d.meta.severity ?? 'unknown'}${times}）`)
    if (d.meta.versions?.length) parts.push(`涉及版本：${d.meta.versions.join(', ')}`)
    const body = String(d.body || '')
      .replace(/^#+\s*/gm, '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 12)
      .join('\n')
    parts.push(body)
  }
  return parts.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
//  统一入口：一个对象管两个库
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 记忆门面。
 *
 * 为什么包一层而不是让调用方自己拼路径：
 *   两个库的位置规则、目录创建、失败兜底都得一致。散在各处的话，
 *   迟早出现「档案写 A 目录、病历读 B 目录」这种查不出原因的怪事。
 */
export function createMemory(rootDir) {
  const ledgerPath = join(rootDir, 'ledger.jsonl')
  const errorsDir = join(rootDir, 'errors')

  return {
    rootDir,
    ledgerPath,
    errorsDir,

    // 档案
    append: (entry) => appendLedger(ledgerPath, entry),
    read: (opts) => readLedger(ledgerPath, opts),
    summary: (name) => summarizeLedger(ledgerPath, name),
    stats: () => ledgerStats(ledgerPath),

    // 病历
    saveError: (doc) => saveErrorDoc(errorsDir, doc),
    listErrors: () => listErrorDocs(errorsDir),
    searchErrors: (opts) => searchErrors(errorsDir, opts),
    renderForPrompt: (docs) => renderErrorsForPrompt(docs),

    /** 一次拿齐「审查模型该看的记忆」 */
    contextFor(name, keywords = []) {
      const docs = searchErrors(errorsDir, { name, keywords, limit: 3 })
      return {
        summary: summarizeLedger(ledgerPath, name),
        errors: docs,
        prompt: renderErrorsForPrompt(docs),
      }
    },
  }
}
