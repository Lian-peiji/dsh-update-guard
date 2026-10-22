/**
 * lib/patchfix.js —— 补丁打不上时，让模型把它「重新对准」新版本
 * ============================================================================
 * 🔴 这个文件补的是方案定稿里 P2 的最后一个缺口。
 *
 *   现状（没有它的时候）：补丁 key 改名成功、pnpm install 报
 *   `ERR_PNPM_UNUSED_PATCH` / `Failed to apply patch`，我们只能整单回滚，
 *   主人的原话是「补丁修不好 → 放弃更新保留旧版」。
 *   但有一批冲突其实是**机械错位**：上游在补丁改的那几行附近挪了代码、
 *   加了参数、多插了几行。补丁的**意图**没变，只是上下文对不上了。
 *   这种活人眼一看就能挪，模型也能挪 —— 挪完还能机械验证。
 *
 *   所以这里的定位是：**只做"对齐"，不做"重新发明"**。
 *   三条硬约束，缺一条就放弃（宁可回滚，也不塞一个猜出来的补丁）：
 *     ① 输出必须是一段合法的 unified diff，而且能**干净地**打在**新版原文件**上；
 *     ② 原补丁新增的每个函数/常量名，在打完之后必须**仍然存在**；
 *     ③ 改动后不能比原来"少做事"（新增标识符数量不得减少）。
 *   三条都过，才写回磁盘；任何一条不过，返回失败，调用方照常回滚。
 * ============================================================================
 */

/**
 * 把 unified diff 解析成 { 文件路径 → 若干 hunk }。
 * 只支持 git diff / diff -u 的常规形态（我们自己的补丁就是这个形态）。
 */
export function parseUnifiedDiff(patchText) {
  const lines = String(patchText ?? '').split(/\r?\n/)
  const files = []
  let cur = null
  let hunk = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('diff --git ')) { cur = null; hunk = null; continue }
    if (l.startsWith('--- ')) {
      // `--- a/path` / `--- path`；`/dev/null` 表示新增文件
      const p = l.slice(4).trim().split('\t')[0]
      const next = lines[i + 1] ?? ''
      if (!next.startsWith('+++ ')) continue
      const np = next.slice(4).trim().split('\t')[0]
      const path = np === '/dev/null' ? p.replace(/^[ab]\//, '') : np.replace(/^[ab]\//, '')
      cur = { path, oldPath: p.replace(/^[ab]\//, ''), hunks: [] }
      files.push(cur)
      i++ // 吃掉 +++ 行
      continue
    }
    if (!cur) continue
    if (l.startsWith('@@')) {
      const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(l)
      if (!m) continue
      hunk = {
        header: l,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        body: [],
      }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (l.startsWith('\\')) continue // "\ No newline at end of file"
    if (l === '' ) { hunk.body.push(' '); continue } // 空行按上下文行处理
    if (/^[ +\-]/.test(l)) hunk.body.push(l)
  }
  return files
}

/** hunk 的「旧侧」行（去掉前缀），用于在原文里找位置 */
function hunkOldSide(hunk) {
  return hunk.body.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1))
}

/**
 * 把补丁打在**一段文本**上（单文件）。
 * 找不到位置时优先按行号附近找，再退回全文搜索 —— 这就是「对齐」，
 * 也是为什么模型只需要挪 context，而不需要重写整个函数。
 */
export function applyHunksToText(original, hunks) {
  let lines = String(original ?? '').split(/\r?\n/)
  const errors = []
  let cursor = 0 // 上一处改动之后的起点，保证按顺序往后走
  for (const [idx, hunk] of hunks.entries()) {
    const oldSide = hunkOldSide(hunk)
    const newSide = hunk.body.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1))
    if (oldSide.length === 0) {
      // 纯新增：插到 newStart 附近
      const at = Math.max(0, Math.min(lines.length, hunk.newStart - 1))
      lines = [...lines.slice(0, at), ...newSide, ...lines.slice(at)]
      cursor = at + newSide.length
      continue
    }
    let at = findBlock(lines, oldSide, { from: cursor, prefer: hunk.oldStart - 1 })
    if (at === -1) at = findBlock(lines, oldSide, { from: 0, prefer: hunk.oldStart - 1 })
    if (at === -1) {
      errors.push({ hunk: idx + 1, header: hunk.header, reason: '在上游原文里找不到这段上下文（模型漏看了新版的变化）' })
      continue
    }
    lines = [...lines.slice(0, at), ...newSide, ...lines.slice(at + oldSide.length)]
    cursor = at + newSide.length
  }
  return { ok: errors.length === 0, text: lines.join('\n'), errors }
}

/** 在 lines 里找 oldSide 连续出现的位置；优先靠近 prefer，其次往后，最后往前 */
function findBlock(lines, block, { from = 0, prefer = 0 } = {}) {
  const max = lines.length - block.length
  if (max < 0) return -1
  // ① 精确命中 prefer 附近
  for (let d = 0; d <= 200; d++) {
    for (const at of [prefer + d, prefer - d]) {
      if (at < from || at > max) continue
      if (sameAt(lines, block, at)) return at
    }
  }
  // ② 全文后向扫描
  for (let at = Math.max(from, 0); at <= max; at++) if (sameAt(lines, block, at)) return at
  return -1
}

function sameAt(lines, block, at) {
  for (let i = 0; i < block.length; i++) {
    if ((lines[at + i] ?? '') !== block[i]) return false
  }
  return true
}

/**
 * 抠出补丁「新增了哪些具名东西」。用来验证重写后的补丁没有偷偷缩水。
 */
export function declMarkers(patchText) {
  const out = new Set()
  for (const l of String(patchText ?? '').split(/\r?\n/)) {
    if (!l.startsWith('+') || l.startsWith('+++')) continue
    const body = l.slice(1)
    const pats = [
      /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    ]
    for (const re of pats) {
      const m = re.exec(body)
      if (m) out.add(m[1])
    }
  }
  return [...out]
}

/**
 * 机械验收：把候选补丁打在新版原文件上，再检查「原来新增的那些名字」还在不在。
 * @returns {{ok:boolean, reason?:string, text?:string, missing?:string[]}}
 */
export function verifyCandidate({ candidatePatch, newFileText, requiredMarkers = [] }) {
  const files = parseUnifiedDiff(candidatePatch)
  if (files.length === 0) return { ok: false, reason: '模型输出的不是能解析的 unified diff（连 --- / +++ / @@ 都没有）' }
  if (files.length > 1) return { ok: false, reason: `一次改了 ${files.length} 个文件；只允许改一个文件（多文件补丁请人工处理）` }
  const res = applyHunksToText(newFileText, files[0].hunks)
  if (!res.ok) {
    return { ok: false, reason: `打不上新版原文：${res.errors.map((e) => `hunk ${e.hunk} ${e.reason}`).join('；')}`, errors: res.errors }
  }
  const patched = res.text
  const missing = requiredMarkers.filter((m) => !new RegExp(`\\b${escapeRe(m)}\\b`).test(patched))
  if (missing.length > 0) {
    return { ok: false, reason: `重写后丢了这些原本新增的名字：${missing.join('、')}（说明它删功能了）`, missing }
  }
  if (patched === String(newFileText ?? '')) return { ok: false, reason: '候选补丁没有产生任何变化' }
  return { ok: true, text: patched }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const PATCHFIX_SYSTEM = `你是 DSH（DeepSeek Harness）插件管家的「补丁迁移工」。

你的活只有一个：把一份**打不上的旧补丁**，挪到**新版文件**上，并且**行为保持不变**。

## 铁律

1. **不要改进、不要重构、不要顺手修 bug。** 你只做「对齐」：新版把代码挪了位置、加了参数、
   插了几行，你就把补丁的上下文跟着挪过去。
2. **不许删功能。** 旧补丁新增的每个函数、常量、导出，新补丁里必须还在，名字不能变。
3. **只改一个文件。** 旧补丁改了哪个文件，新补丁就只改哪个文件。
4. **对齐优先用新版原文的真实内容**：你写进上下文行的每一行，都必须在新版文件里**逐字存在**。
   不要凭记忆写上下文。
5. 如果这份补丁在新版上**语义已经失效**（上游自己修了同一个 bug、或那段代码整段被重写了，
   硬挪会打坏功能），那就**不要硬凑**——输出 {"skip": true, "why": "..."}。

## 输出格式（只输出这段 JSON，不要解释、不要代码围栏）

{"patch": "--- a/<路径>\\n+++ b/<路径>\\n@@ -旧起,旧行数 +新起,新行数 @@\\n 上下文行\\n+新增行\\n-删除行\\n...", "why": "一句话说明你把哪几行挪到了哪里"}

或者

{"skip": true, "why": "为什么这份补丁不该硬迁"}
`

/**
 * 组装一次「补丁重写」的提示词。
 * 里面对模型最重要的两个东西：① 旧补丁（要保住什么）② 新版原文（要对齐到什么）。
 */
export function buildFixPrompt({ targetPath, patchText, newFileText, intentText = '', failureNote = '' }) {
  const markers = declMarkers(patchText)
  const user = `## 要迁移的补丁（旧版本能打上）

\`\`\`diff
${patchText}
\`\`\`

## 这个补丁为什么存在（intent.md，判断"语义是否已失效"的依据）

${intentText || '（没有 intent.md，只能从补丁本身推断意图）'}

## 它新增了这些具名成员（新补丁里必须都还在）

${markers.length ? markers.map((m) => `- ${m}`).join('\n') : '-（这份补丁没有新增具名成员）'}

## 它打不上的原因

${failureNote || '（没拿到具体报错，多半是上下文行对不上了）'}

## 新版文件原文：${targetPath}

（行首的 \`NNN|\` 是行号，**不要**写进你输出的补丁里）

\`\`\`
${numberLines(newFileText)}
\`\`\`

请把它重新对准，输出 JSON。`
  return { system: PATCHFIX_SYSTEM, user, markers }
}

function numberLines(text, { maxChars = 60_000 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/)
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const add = `${String(i + 1).padStart(5, ' ')}|${lines[i]}\n`
    if (out.length + add.length > maxChars) { out += `…（后面还有 ${lines.length - i} 行，已截断）\n`; break }
    out += add
  }
  return out
}

/**
 * 走一次完整的「问模型 + 机械验收」。**验收不过就当没发生过**。
 *
 * @param {object} a
 * @param {Function} a.ask (system, user, {tier, maxTokens}) => {ok, text, error}
 * @returns {Promise<{ok:boolean, patchText?:string, why?:string, reason?:string, skipped?:boolean}>}
 */
export async function fixPatch({ ask, tier = 'strong', maxTokens = 8000, targetPath, patchText, newFileText, intentText, failureNote }) {
  const { system, user, markers } = buildFixPrompt({ targetPath, patchText, newFileText, intentText, failureNote })
  const res = await ask(system, user, { tier, maxTokens })
  if (!res?.ok) return { ok: false, reason: `模型没回话：${res?.error ?? '未知原因'}` }

  const obj = extractJson(res.text)
  if (!obj) return { ok: false, reason: '模型输出不是合法 JSON（没法机械验收）' }
  if (obj.skip) return { ok: false, skipped: true, reason: `模型判断不该硬迁：${obj.why ?? ''}` }

  const candidate = String(obj.patch ?? '').trim()
  if (!candidate) return { ok: false, reason: '模型没给出补丁内容' }

  // 模型爱把 diff 包在 ```diff 里，或者把行号带进来 —— 这里做最小清洗
  const cleaned = stripFences(candidate)
  const verified = verifyCandidate({ candidatePatch: cleaned, newFileText, requiredMarkers: markers })
  if (!verified.ok) return { ok: false, reason: verified.reason }
  return { ok: true, patchText: cleaned, why: String(obj.why ?? ''), markers }
}

function stripFences(s) {
  let t = String(s).trim()
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t)
  if (m) t = m[1]
  return t.replace(/\r\n/g, '\n')
}

/** 从一段输出里捞第一个完整 JSON 对象（容忍前后废话） */
export function extractJson(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}