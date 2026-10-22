/**
 * lib/review.js —— 审查：让模型看一眼，然后给出「装 / 不装 / 等等」的判决
 * ============================================================================
 * 🔴 这个文件的全部难点，是**怎么让模型别瞎判**。
 *
 *   已踩过 / 预见到的坑：
 *   ① **只喂 changelog → 模型编故事**
 *      "本次更新优化了性能" → 模型："可能导致内存泄漏！"。必须喂真实 diff。
 *   ② **不问「我们怎么用这个包」→ 模型判"有风险"判得没意义**
 *      同一个改动，对"只用了一个导出函数"的包和对"深度改了它的内部"的包，
 *      风险差十倍。所以要把**我们打过的补丁**和**这个包的历史病历**一起喂。
 *   ③ **模型爱说"建议谨慎"这种废话**
 *      → 判决必须落在三个枚举值上，且**默认 install**（主人要新功能）。
 *      "skip" 必须写出"放弃的是什么"和"怎么解锁"，否则驳回重判。
 *   ④ **JSON 不一定听话**
 *      模型会在 JSON 前后加 ```json 围栏、加解释、写中文全角引号。
 *      → 三级容错：直接 parse → 抠 ``` 块 → 抠第一个 { 到最后一个 }。
 * ============================================================================
 */
import { bumpType } from './semver.js'

/**
 * 一次审查给模型的输出额度。
 *
 * 真机教训（2026-10-22）：原来给 2000，模型把 JSON 写到一半被截断 →
 * 解析失败 → **静默按"放行"处理**，看着有判决其实啥也没审。
 * 判决 JSON 带 summary + 四个数组，2000 真的不够。
 */
const REVIEW_TOKENS = 6000

/** 判决枚举 —— 只有这三个，别的都算无效 */
export const VERDICTS = ['install', 'hold', 'skip']

/** 审查模型的系统提示词（**每一句都是为了让判决可执行**） */
export const REVIEW_SYSTEM = `你是 DSH（DeepSeek Harness）的「插件管家」。你的工作不是"提醒风险"，而是**替主人做一个能执行的判决**。

## 你的判决只有三种
- install：装。**这是默认答案** —— 主人要新功能，不能因为"可能有问题"就不装。
- hold：这次先不装，保留旧版。**只有下面三种情况允许 hold**，其余一律 install：
  1. 我们打过的补丁在新版上冲突，而且你判断**修不好**（看不懂新代码 / 改动太大 / 会破坏功能）
  2. 这次更新**删掉或改了正在用的 API**（证据：diff 里删除了我们依赖的导出、改了函数签名）
  3. 病历显示这个包**更新后出过事 ≥2 次**，且这次改动又碰到同一片代码
- skip：这次更新对我们**没有实质价值**（纯 CI/文档/依赖版本号变动），记录但不动。
  **必须写清楚放弃了什么**，以及怎么解锁（比如"下个有实质功能的版本再装"）。

## 判断"补丁还能不能用"的要点
- 我们的补丁是**为了修某个具体问题**打的，intent 里写着修什么。
- 看新版 diff：**上游自己修了那个问题吗？**
  - 修了 → 补丁可以**退役**（retire），这是最好的结局，不是失败。
  - 没修，但补丁要改的那几行还在 → **重放**（replay）。
  - 没修，但那几行被重写了 → **重写**（rewrite）：说明要改哪几行、改成什么。
  - 完全找不到对应位置 → 补丁会丢，判 hold。

## 输出格式
**只输出一个 JSON 对象**，不要 markdown 围栏、不要任何解释文字：
{
  "verdict": "install|hold|skip",
  "confidence": 0.0~1.0,
  "summary": "一句话说这次更新干了什么（具体，不要'优化体验'这种空话）",
  "features": ["这次带来的新功能/修复，主人会想要的那种"],
  "risks": ["具体风险；没有就空数组。不要写'建议测试'这种废话"],
  "predictedBugs": [{"symptom":"主人会看到什么现象","why":"为什么会这样（指到具体文件/函数）","mitigation":"怎么防/怎么修"}],
  "patchPlan": [{"patchId":"补丁文件名","action":"replay|rewrite|retire","reason":"为什么","rewriteHint":"action=rewrite 时，写清楚要改哪几行、改成什么"}],
  "unlock": "verdict=skip 时必填：放弃了什么、什么时候再考虑"
}

## 铁律
- **不确定就 install**。你判 hold 的代价是主人用不上新功能，这个代价很高。
- 风险必须**指到具体代码**。写不出具体位置的风险，说明是你猜的，别写。
- 不要复述 diff。主人要看的是"这意味着什么"。`

/**
 * 把侦察结果整理成喂模型的材料
 *
 * @param {object} o
 * @param {string} [o.errorPrompt] —— 记忆双库里检出的病历（已渲染成文本）。
 *   为什么单独一路传进来而不是混在 history 里：
 *    history 是「更新流水账」（机器读的结构化记录），
 *    errorPrompt 是「以前踩过的坑怎么爬出来的」（人写的病历）。
 *    模型对两者的用法不同：流水账用来算事故率，病历来防同一个坑踩第二次。
 */
export function buildEvidence({ pkg, recon, dive, patches = [], history = [], usage = null, errorPrompt = '' }) {
  const parts = []

  parts.push(`# 待审：${pkg.name}`)
  parts.push(`当前版本 ${recon.current} → 目标版本 ${recon.latest}（${recon.bump} 级变动）`)
  if (recon.deprecated) parts.push(`⚠️ 目标版本已被上游标记弃用：${recon.deprecated}`)

  if (pkg.description) parts.push(`\n包说明：${pkg.description}`)

  // ① 我们怎么用这个包
  if (usage) {
    parts.push(`\n## 我们怎么用这个包`)
    parts.push(usage)
  }

  // ② 我们打过的补丁（这是最关键的上下文）
  if (patches.length > 0) {
    parts.push(`\n## 我们在这个包上打了 ${patches.length} 个补丁`)
    for (const p of patches) {
      parts.push(`\n### 补丁：${p.id}`)
      if (p.intent) parts.push(`修的问题：${p.intent}`)
      if (p.files?.length) parts.push(`改的文件：${p.files.join(', ')}`)
      if (p.patchText) {
        parts.push('补丁内容（unified diff）：')
        parts.push('```diff')
        parts.push(p.patchText.length > 8000 ? p.patchText.slice(0, 8000) + '\n…（截断）' : p.patchText)
        parts.push('```')
      }
    }
  } else {
    parts.push(`\n## 这个包上没有我们的补丁`)
  }

  // ③ 历史病历
  if (history.length > 0) {
    parts.push(`\n## 这个包的历史病历（以前更新出过什么事）`)
    for (const h of history.slice(0, 8)) {
      const when = h.at ? String(h.at).slice(0, 10) : '未知日期'
      parts.push(`- ${when} ${h.from ?? '?'} → ${h.to ?? '?'}：${h.outcome ?? '?'}${h.note ? `（${h.note}）` : ''}`)
    }
  } else {
    parts.push(`\n## 这个包以前没出过事（没有病历）`)
  }

  // ③b 错误知识库：以前踩过的坑和怎么爬出来的
  //     跟上面的流水账不是一回事 —— 流水账说「出过事」，这里说「出的是什么事、怎么修的」。
  //     主人要的「防止重复踩坑」，靠的就是这一段。
  if (errorPrompt) {
    parts.push(`\n${errorPrompt}`)
    parts.push(`\n⚠️ 如果这次更新会重新触发上面这些坑，必须在 predictedBugs 里指出来，并在 mitigation 里写清怎么防。`)
  }

  // ④ changelog
  if (dive?.changelog?.text) {
    parts.push(`\n## 上游 changelog（${dive.changelog.path}）`)
    if (dive.changelog.note) parts.push(`（${dive.changelog.note}）`)
    parts.push(dive.changelog.text)
  }

  return parts.join('\n')
}

/** 从模型回复里抠出 JSON（五级容错） */
export function parseVerdict(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, error: '模型返回空' }

  const attempts = []

  // ① 直接 parse
  attempts.push(() => JSON.parse(raw))

  // ② ```json ... ``` 围栏
  attempts.push(() => {
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
    if (!m) throw new Error('没有围栏')
    return JSON.parse(m[1].trim())
  })

  // ③ 第一个 { 到最后一个 }
  attempts.push(() => {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('没有花括号')
    return JSON.parse(raw.slice(s, e + 1))
  })

  // ④ 修常见的模型手滑：全角引号、尾逗号
  attempts.push(() => {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    let body = raw.slice(s, e + 1)
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(body)
  })

  for (const fn of attempts) {
    try {
      const obj = fn()
      if (obj && typeof obj === 'object') return { ok: true, verdict: obj }
    } catch { /* 下一个 */ }
  }

  // ⑤ 最狠的一级：模型输出被 maxTokens 截断了（真机上撞到过 —— 截断后
  //    整个 JSON 不合法，于是静默按"放行"处理，等于白审）。
  //    这里把尾巴修好：补引号、去掉悬空逗号、按栈补齐括号。
  const salvaged = salvageJson(raw)
  if (salvaged) return { ok: true, verdict: salvaged, salvaged: true }

  return { ok: false, error: '模型返回的不是合法 JSON', raw: raw.slice(0, 500) }
}

/**
 * 尽力修复一个被截断的 JSON。
 *
 * 思路：从第一个 `{` 起，先在末尾补引号/去悬空逗号/按括号栈补齐收尾，
 * 不成就从后往前逐个逗号砍掉最后一个不完整字段再试。
 *
 * @returns {object|null} 修好返回对象，修不好返回 null（**不抛异常**）
 */
export function salvageJson(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  if (start < 0) return null

  const body = s.slice(start)
  const commas = []
  for (let i = 0; i < body.length; i++) if (body[i] === ',') commas.push(i)

  // 候选截断点：原样末尾 + 最后 40 个逗号（从后往前）
  const cuts = [body.length, ...commas.slice(-40).reverse()]
  for (const cut of cuts) {
    try {
      const obj = JSON.parse(repairJson(body.slice(0, cut)))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    } catch { /* 下一个截断点 */ }
  }
  return null
}

/** 补引号 / 去悬空分隔符 / 按括号栈补齐收尾 */
function repairJson(src) {
  const stack = []
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
  }

  let t = src.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  if (inStr) t += '"'                    // 截断在字符串中间
  t = t.replace(/[,:]\s*$/, '')          // 悬空的逗号/冒号
  t = t.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) t += stack[i] === '{' ? '}' : ']'
  return t
}

/** 校验 + 规整判决（模型爱偷懒，这里补齐并纠正） */
export function normalizeVerdict(obj) {
  const out = {
    verdict: VERDICTS.includes(obj?.verdict) ? obj.verdict : 'install',
    confidence: typeof obj?.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.5,
    summary: String(obj?.summary ?? '').trim(),
    features: Array.isArray(obj?.features) ? obj.features.map(String).filter(Boolean) : [],
    risks: Array.isArray(obj?.risks) ? obj.risks.map(String).filter(Boolean) : [],
    predictedBugs: [],
    patchPlan: [],
    unlock: obj?.unlock ? String(obj.unlock).trim() : '',
    warnings: [],
  }

  for (const b of Array.isArray(obj?.predictedBugs) ? obj.predictedBugs : []) {
    if (!b || typeof b !== 'object') continue
    const symptom = String(b.symptom ?? '').trim()
    if (!symptom) continue
    out.predictedBugs.push({
      symptom,
      why: String(b.why ?? '').trim(),
      mitigation: String(b.mitigation ?? '').trim(),
    })
  }

  for (const p of Array.isArray(obj?.patchPlan) ? obj.patchPlan : []) {
    if (!p || typeof p !== 'object') continue
    const action = ['replay', 'rewrite', 'retire'].includes(p.action) ? p.action : 'replay'
    out.patchPlan.push({
      patchId: String(p.patchId ?? '').trim(),
      action,
      reason: String(p.reason ?? '').trim(),
      rewriteHint: String(p.rewriteHint ?? '').trim(),
    })
  }

  // 兜底规则（不信任模型的地方，硬编码）
  if (!out.summary) out.warnings.push('模型没给出 summary，已用 diff 概览兜底')

  // skip 必须说清楚放弃什么 —— 说不清就降级成 install（"不能放弃新功能"）
  if (out.verdict === 'skip' && !out.unlock) {
    out.warnings.push('模型判了 skip 但没说清放弃了什么 → 按主人的策略改判 install')
    out.verdict = 'install'
  }

  // hold 必须有具体理由，不能是"建议谨慎"
  if (out.verdict === 'hold') {
    const hasRealReason = out.risks.length > 0 || out.patchPlan.some((p) => p.action === 'rewrite') || out.predictedBugs.length > 0
    if (!hasRealReason) {
      out.warnings.push('模型判了 hold 但没给出任何具体理由 → 改判 install（hold 必须有证据）')
      out.verdict = 'install'
    }
  }

  return out
}

/**
 * 按风险分级挑模型档位（主人选的策略）。
 * patch 级 → 便宜模型；minor/major 或补丁冲突 → 强模型。
 */
export function pickTier(bump, { hasPatches, patchConflict, badHistory }) {
  if (patchConflict) return 'strong'
  if (bump === 'major' || bump === 'minor') return 'strong'
  if (badHistory) return 'strong'
  if (hasPatches) return 'strong'
  return 'cheap'
}

/**
 * 一次完整的审查。
 *
 * @param {object} deps
 * @param {Function} deps.ask  (system, user, {tier, maxTokens}) => {ok, text, error, provider, model}
 * @returns 规整后的判决
 */
export async function review({ pkg, recon, dive, patches, history, usage, errorPrompt, ask, tiers = {} }) {
  const bump = bumpType(recon.current, recon.latest)
  const tier = pickTier(bump, {
    hasPatches: patches?.length > 0,
    patchConflict: false,       // 冲突要到 P2 重放时才知道；这里先按"有补丁"算
    badHistory: (history ?? []).some((h) => h.outcome && h.outcome !== 'ok') || Boolean(errorPrompt),
  })

  const evidence = buildEvidence({ pkg, recon, dive, patches, history, usage, errorPrompt })
  const diffText = renderDiff(dive)

  const user = `${evidence}

## 这次更新改了什么（逐文件 diff）

${diffText}

请按系统提示的格式输出判决 JSON。`

  // 真机上撞到过：maxTokens 给小了，模型把 JSON 写到一半被截断，
  // 于是解析失败 → 静默走默认放行，等于没审。所以这里给足额度，
  // 并且**只要没解析出完整判决就再要一次**（要求它更精简）。
  const useTier = tiers[tier] ? tier : 'cheap'
  const retryNote = '\n\n（上一次输出不完整或不是合法 JSON。这次务必精简：summary ≤ 120 字，'
    + 'features / risks / predictedBugs / patchPlan 各最多 3 项，并且**只输出那段 JSON**。）'

  let res = await ask(REVIEW_SYSTEM, user, { tier: useTier, maxTokens: REVIEW_TOKENS })
  let parsed = res?.ok ? parseVerdict(res.text) : { ok: false }
  let retried = false

  if (res?.ok && (!parsed.ok || res.truncated)) {
    retried = true
    const res2 = await ask(REVIEW_SYSTEM, user + retryNote, { tier: useTier, maxTokens: REVIEW_TOKENS * 2 })
    if (res2?.ok) {
      const p2 = parseVerdict(res2.text)
      // 第二次只要拿到东西就用它（第一次是坏的）
      if (p2.ok || !parsed.ok) { res = res2; parsed = p2 }
    }
  }

  if (!res?.ok) {
    return {
      verdict: 'install',
      confidence: 0,
      summary: '（审查模型不可用，按默认策略放行）',
      features: [], risks: [], predictedBugs: [], patchPlan: [],
      unlock: '',
      warnings: [`审查失败：${res?.error ?? '未知'} → 按主人"不能放弃新功能"的策略，默认 install`],
      tier,
      model: null,
      evidenceChars: evidence.length + diffText.length,
    }
  }

  if (!parsed.ok) {
    return {
      verdict: 'install',
      confidence: 0,
      summary: '（模型输出无法解析，按默认策略放行）',
      features: [], risks: [], predictedBugs: [], patchPlan: [],
      unlock: '',
      warnings: [
        parsed.error,
        `原始输出：${(parsed.raw ?? '').slice(0, 200)}`,
        '⚠️ 这其实等于没审 —— 明细请人工看一眼，或者换更强的模型档位再跑一次',
      ],
      tier,
      model: res.model ?? null,
      evidenceChars: evidence.length + diffText.length,
    }
  }

  const v = normalizeVerdict(parsed.verdict)
  if (parsed.salvaged) v.warnings.push('模型输出被截断，判决是修复残缺 JSON 后得到的（字段可能不全）')
  if (retried) v.warnings.push('第一次输出不完整，已自动重试一次')
  v.tier = tier
  v.model = res.model ?? null
  v.evidenceChars = evidence.length + diffText.length
  return v
}

/** 内部：把 dive 渲染成 diff 文本（复用 recon 的渲染器，避免重复实现） */
function renderDiff(dive) {
  if (!dive || dive.error) return `（拿不到 diff：${dive?.error ?? '未知'}）`
  const s = dive.summary
  const lines = [`改动概览：新增 ${s.added} / 删除 ${s.removed} / 修改 ${s.changed} 个文件，共 +${s.linesAdded} −${s.linesRemoved} 行。`]

  const changed = dive.files.filter((f) => !f.lowSignal)
  if (changed.length > 0) {
    lines.push('\n涉及文件：')
    for (const f of changed.slice(0, 60)) {
      const tag = f.kind === 'added' ? '新增' : f.kind === 'removed' ? '删除' : '修改'
      lines.push(`  - [${tag}] ${f.path}${f.binary ? '（二进制）' : ` (+${f.added} −${f.removed})`}`)
    }
    if (changed.length > 60) lines.push(`  …还有 ${changed.length - 60} 个文件`)
  }

  const withDiff = changed
    .filter((f) => f.diff && !f.binary)
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed))

  let used = lines.join('\n').length
  const budget = 40_000
  for (const f of withDiff) {
    if (used + f.diff.length > budget) {
      lines.push(`\n…（剩余文件的 diff 超出长度预算，已省略）`)
      break
    }
    lines.push(`\n── ${f.path} ──\n${f.diff}`)
    used += f.diff.length
  }
  return lines.join('\n')
}
