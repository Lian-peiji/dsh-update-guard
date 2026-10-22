// 市场哨兵（sentinel）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// 主人的插件更新**大多数不是走我们的工具**，而是在「插件市场」里点「全部更新」。
// 那条路上一次工具调用都没有：
//
//     点按钮 → dshmarket 服务端自己跑 pnpm → 宿主的包操作
//
// 我们的 tools.guard 只看得见工具调用，所以**拦不住市场**。宿主倒是会广播三条事件
// （plugin-manager/changed、install-state、install-log），但它们都是 emit（只能听，
// 不能否决）。于是这里做成「事后哨兵」：
//
//   ① install-log 里出现 ERR_PNPM_UNUSED_PATCH / ambiguous-install 之类 →
//      当场知道他踩了哪个坑，把包名和原因记进账本 + 病害库；
//   ② plugin-manager/changed →
//      对比 profile 指纹（谁的版本变了、补丁表变了没、patch 文件没了没），
//      把「市场偷偷改了什么」变成一条有据可查的记录。
//
// ── 刻意不做的事 ────────────────────────────────────────────────────────────
// · 不自动重装、不自动重打补丁 —— 那是 apply 流程的事，有试跑和回滚兜着。
//   哨兵只负责「看见 + 记下来 + 告警」，动磁盘的事一概不碰。
// · 不猜包名。宿主事件里没有包名（PluginChange 只有 reason，PluginInstallProgress
//   只有 requestId/phase/attempt），所以包名只能从 pnpm 输出里抠，抠不到就记「未知」。
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
//  一、pnpm 输出里值得拦的话
// ─────────────────────────────────────────────────────────────────────────────
//  🔴 这些不是「可能有问题」，是「已经出问题了」。每一条都来自真机踩过的坑：
//     - unused-patch：本地补丁没被用上，pnpm 直接中止（2026-10-22 那次市场更新
//       dsh-fish-memory 就是栽在这 —— 补丁 key 还钉在 1.2.1，包已经换成别的 commit）
//     - ambiguous-install：装完了宿主认不出装的是哪个包，回滚也验证不了
export const INSTALL_LOG_PATTERNS = [
  {
    id: 'unused-patch',
    re: /The following patches were not used:\s*([^\n"]+)/i,
    severity: 'high',
    title: '补丁没被用上（pnpm 因此中止安装）',
    grab: (m) => m[1].trim().replace(/["'`]/g, ''),
    hint: '补丁 key 的版本跟要装的版本对不上。用 plugin_patches 看账本，确认是重新对准还是退役补丁。',
  },
  {
    id: 'unused-patch-code',
    re: /ERR_PNPM_UNUSED_PATCH/,
    severity: 'high',
    title: 'ERR_PNPM_UNUSED_PATCH：有补丁没被用上',
    hint: '同上 —— 补丁对不上新版本，pnpm 拒绝继续。',
  },
  {
    id: 'retarget-hint',
    re: /retarget the patch to the new version/i,
    severity: 'high',
    title: 'pnpm 提示补丁要重新对准新版本',
    hint: '这正是 patchfix 存在的理由：让模型按 intent.md 把补丁重新对准，过不了机械验收就放弃更新。',
  },
  {
    id: 'ambiguous-install',
    re: /ambiguous-install/i,
    severity: 'high',
    title: '装完认不出装了哪个包（ambiguous-install）',
    hint: 'dshmarket 靠「装前装后清单 diff」认包名；源写成浮动 URL 时 diff 为空就认不出来。装完要人工确认。',
  },
  {
    id: 'frozen-lockfile',
    re: /ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with "frozen-lockfile"/i,
    severity: 'medium',
    title: '锁文件跟依赖清单不一致',
    hint: '装的时候被 frozen-lockfile 拦下了。我们自己装的时候用 --no-frozen-lockfile，市场那边不一定。',
  },
  {
    id: 'peer-dep',
    re: /ERR_PNPM_PEER_DEP_ISSUES|unmet peer dependency/i,
    severity: 'low',
    title: 'peer 依赖冲突',
    hint: '多半不致命，但可能让某个插件加载时缺东西。',
  },
  {
    id: 'generic-pnpm-error',
    re: /(ERR_PNPM_[A-Z_]+)/,
    severity: 'medium',
    title: 'pnpm 报错',
    grab: (m) => m[1],
  },
]

/**
 * 扫一段 pnpm 输出，返回命中的问题（同一段里同一种只报一次）。
 * @param {string} text
 * @returns {{hits: Array<{id:string,severity:string,title:string,evidence:string,hint?:string,detail?:string}>, patches: string[]}}
 */
export function scanInstallLog(text) {
  const s = String(text ?? '')
  const hits = []
  const seen = new Set()
  const patches = new Set()
  for (const p of INSTALL_LOG_PATTERNS) {
    const m = p.re.exec(s)
    if (!m) continue
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const detail = p.grab ? p.grab(m) : null
    if (p.id === 'unused-patch' && detail) {
      for (const one of detail.split(/[,\s]+/).filter(Boolean)) patches.add(one)
    }
    hits.push({
      id: p.id,
      severity: p.severity,
      title: p.title,
      evidence: m[0].slice(0, 300),
      hint: p.hint,
      detail,
    })
  }
  return { hits, patches: [...patches] }
}

// ─────────────────────────────────────────────────────────────────────────────
//  二、profile 指纹 —— 「市场偷偷改了什么」
// ─────────────────────────────────────────────────────────────────────────────
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function statOf(p) {
  try { const st = statSync(p); return { size: st.size, mtimeMs: Math.round(st.mtimeMs) } } catch { return null }
}

/**
 * 给 profile 拍一张指纹。只读，不碰任何文件。
 * 记的是「装了什么版本、补丁表长什么样、patch 文件多大」，不读源码内容（省 IO）。
 */
export function fingerprintProfile(dir) {
  const pkg = readJson(join(dir, 'package.json')) ?? {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }

  const installed = {}
  for (const name of Object.keys(deps).sort()) {
    const pj = join(dir, 'node_modules', name, 'package.json')
    const version = readJson(pj)?.version ?? null
    const st = statOf(pj)
    installed[name] = { declared: String(deps[name]), version, mtimeMs: st?.mtimeMs ?? 0 }
  }

  // 补丁：登记表（pnpm-workspace.yaml 的 patchedDependencies）+ patches/ 里的文件
  const ws = join(dir, 'pnpm-workspace.yaml')
  const wsText = existsSync(ws) ? readFileSync(ws, 'utf8') : ''
  const registered = {}
  // 只抠 `key: path` 这种扁平结构，够用且不依赖 yaml 解析器
  // 注意结尾那个 `\n?`：手写的 yaml 最后一行常常没有换行符，
  // 少写这个可选换行就会把「只有一个补丁」的 profile 读成「没有补丁」（测试里抓到过）。
  const block = /patchedDependencies:[ \t]*\n((?:[ \t]+[^\n]*\n?)*)/.exec(wsText)
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = /^\s+['"]?([^'":]+)['"]?\s*:\s*(.+?)\s*$/.exec(line)
      if (m) registered[m[1].trim()] = m[2].trim()
    }
  }

  const patchFiles = {}
  const pdir = join(dir, 'patches')
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir).sort()) {
      if (!f.endsWith('.patch')) continue
      const st = statOf(join(pdir, f))
      patchFiles[f] = st ? { size: st.size, mtimeMs: st.mtimeMs } : { size: 0, mtimeMs: 0 }
    }
  }

  // 补丁的「意图文件」也算指纹的一部分 —— 有人补了 intent.md 也算一次变化
  const intents = {}
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir).sort()) {
      if (!f.endsWith('.intent.md')) continue
      const st = statOf(join(pdir, f))
      intents[f] = st ? st.mtimeMs : 0
    }
  }

  return {
    at: new Date().toISOString(),
    workspace: statOf(ws),
    deps: installed,
    registered,
    patchFiles,
    intents,
  }
}

const keys = (o) => Object.keys(o ?? {})

/**
 * 两张指纹之间差了什么。返回结构化 diff，空对象字段表示没变化。
 */
export function diffFingerprint(prev, next) {
  const out = {
    added: [],
    removed: [],
    versionChanged: [],
    patches: { registeredAdded: [], registeredRemoved: [], filesAdded: [], filesRemoved: [], filesChanged: [], intentsAdded: [], intentsRemoved: [] },
    changed: false,
  }
  if (!prev || !next) {
    out.changed = true
    return out
  }

  const pd = prev.deps ?? {}
  const nd = next.deps ?? {}
  for (const k of keys(nd)) if (!(k in pd)) out.added.push(k)
  for (const k of keys(pd)) if (!(k in nd)) out.removed.push(k)
  for (const k of keys(nd)) {
    const a = pd[k]
    const b = nd[k]
    if (!a || !b) continue
    if (String(a.version) !== String(b.version)) {
      out.versionChanged.push({ name: k, from: a.version, to: b.version, declaredFrom: a.declared, declaredTo: b.declared })
    } else if (String(a.declared) !== String(b.declared)) {
      out.versionChanged.push({ name: k, from: a.version, to: b.version, declaredFrom: a.declared, declaredTo: b.declared, specOnly: true })
    }
  }

  const pr = prev.registered ?? {}
  const nr = next.registered ?? {}
  for (const k of keys(nr)) if (!(k in pr)) out.patches.registeredAdded.push(k)
  for (const k of keys(pr)) if (!(k in nr)) out.patches.registeredRemoved.push(k)

  const pf = prev.patchFiles ?? {}
  const nf = next.patchFiles ?? {}
  for (const k of keys(nf)) if (!(k in pf)) out.patches.filesAdded.push(k)
  for (const k of keys(pf)) if (!(k in nf)) out.patches.filesRemoved.push(k)
  for (const k of keys(nf)) if (k in pf && (pf[k].size !== nf[k].size || pf[k].mtimeMs !== nf[k].mtimeMs)) out.patches.filesChanged.push(k)

  const pi = prev.intents ?? {}
  const ni = next.intents ?? {}
  for (const k of keys(ni)) if (!(k in pi)) out.patches.intentsAdded.push(k)
  for (const k of keys(pi)) if (!(k in ni)) out.patches.intentsRemoved.push(k)

  out.changed = out.added.length > 0 || out.removed.length > 0 || out.versionChanged.length > 0
    || out.patches.registeredAdded.length > 0 || out.patches.registeredRemoved.length > 0
    || out.patches.filesAdded.length > 0 || out.patches.filesRemoved.length > 0
    || out.patches.filesChanged.length > 0
    || out.patches.intentsAdded.length > 0 || out.patches.intentsRemoved.length > 0
  return out
}

/**
 * 把 diff 画成人话（给工具输出/日志用）。没变化就返回一句「没变」。
 */
export function renderDiff(diff) {
  if (!diff) return '（没有可比较的指纹）'
  if (!diff.changed) return 'profile 没有任何变化。'
  const lines = []
  for (const a of diff.added) lines.push(`- 新增依赖：${a}`)
  for (const r of diff.removed) lines.push(`- 移除了：${r}`)
  for (const v of diff.versionChanged) {
    if (v.specOnly) lines.push(`- **${v.name}** 版本没变（${v.from}），但声明的源改了：\`${v.declaredFrom}\` → \`${v.declaredTo}\``)
    else lines.push(`- **${v.name}** ${v.from ?? '?'} → ${v.to ?? '?'}`)
  }
  const p = diff.patches
  for (const k of p.registeredAdded) lines.push(`- 补丁新登记：${k}`)
  for (const k of p.registeredRemoved) lines.push(`- ⚠️ 补丁登记没了：${k}（下次 install 会报 UNUSED_PATCH 或根本没打上）`)
  for (const k of p.filesAdded) lines.push(`- 新增 patch 文件：${k}`)
  for (const k of p.filesRemoved) lines.push(`- ⚠️ patch 文件不见了：${k}`)
  for (const k of p.filesChanged) lines.push(`- patch 文件被改过：${k}`)
  for (const k of p.intentsAdded) lines.push(`- 新增 intent.md：${k}`)
  for (const k of p.intentsRemoved) lines.push(`- intent.md 被删了：${k}`)
  return lines.join('\n')
}

/**
 * 从「补丁没被用上」的名字里，推出可能受影响的包名。
 * 补丁 key 长这样：`dsh-pocket@2.12.0` / `dsh-fish-memory@github:...#ref`。
 */
export function packageFromPatchKey(key) {
  const s = String(key ?? '').trim()
  if (!s) return null
  const at = s.lastIndexOf('@')
  if (at <= 0) return s
  return s.slice(0, at)
}

// ─────────────────────────────────────────────────────────────────────────────
//  三、哨兵本体
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_DEBOUNCE_MS = 2_500

/**
 * 建一个哨兵。它只做三件事：记 pnpm 输出、拍指纹、比指纹。
 * 真正落账（写 ledger / 写病历）由调用方在 onEvent 里做 —— 这样模块本身可测。
 */
export function createSentinel({ dir, log = () => {}, debounceMs = DEFAULT_DEBOUNCE_MS, now = Date.now } = {}) {
  let baseline = null
  let lastDiff = null
  let lastAt = null
  const logHits = []       // 最近的 pnpm 输出命中
  const events = []        // 最近的事件流水
  let timer = null
  let pendingReason = null
  const seenInRun = new Set()   // 同一次安装里同一种问题只报一次

  const push = (ev) => {
    events.push({ ...ev, at: new Date().toISOString() })
    while (events.length > 100) events.shift()
  }

  // 基线落盘：市场更新经常连带重启 DSH，进程一换内存基线就没了。
  // 存的是「指纹 + 拍的时刻」，读的时候只认结构，版本不对就当没有。
  const baselineFile = () => join(dir, '.update-guard', 'sentinel-baseline.json')

  const persistBaseline = () => {
    try {
      const f = baselineFile()
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify({ v: 1, at: lastAt, baseline }, null, 0), 'utf8')
    } catch (e) {
      log(`[sentinel] 基线存不下来（不影响本次看守）：${e?.message ?? e}`)
    }
  }

  const loadBaseline = () => {
    try {
      const f = baselineFile()
      if (!existsSync(f)) return null
      const obj = JSON.parse(readFileSync(f, 'utf8'))
      if (!obj || obj.v !== 1 || typeof obj.baseline !== 'object') return null
      return obj
    } catch (e) {
      log(`[sentinel] 上次的基线读不出来（当第一次跑）：${e?.message ?? e}`)
      return null
    }
  }

  return {
    /** 拍一张基线指纹（插件启动时调一次） */
    snapshot() {
      try {
        baseline = fingerprintProfile(dir)
        lastAt = new Date().toISOString()
        persistBaseline()
        return baseline
      } catch (e) {
        log(`[sentinel] 拍指纹失败：${e?.message ?? e}`)
        return null
      }
    },

    /**
     * 启动时接上「上一次运行留下的基线」。
     * 为什么需要：市场更新常常连带把 DSH 重启掉 —— 进程一换，内存里的基线就没了，
     * 那次变动从此永远查不出来（正是主人踩到的情形）。所以基线得落盘。
     */
    resume() {
      const prev = loadBaseline()
      if (!prev) { this.snapshot(); return { diff: null, firstRun: true } }
      let next = null
      try { next = fingerprintProfile(dir) } catch (e) { log(`[sentinel] 续基线失败：${e?.message ?? e}`); this.snapshot(); return { diff: null } }
      const diff = diffFingerprint(prev.baseline ?? null, next)
      baseline = next
      lastDiff = diff
      lastAt = new Date().toISOString()
      persistBaseline()
      if (diff.changed) {
        diff.sinceWhen = prev.at ?? null
        push({ kind: 'profile-change', reason: 'resume', diff })
      }
      return { diff, sinceWhen: prev.at ?? null, firstRun: false }
    },

    /** 一次 pnpm 输出片。命中问题就回调 onLogIssue */
    noteChunk(chunk, { onLogIssue } = {}) {
      const text = String(chunk ?? '')
      if (!text) return { hits: [] }
      const { hits, patches } = scanInstallLog(text)
      if (hits.length === 0) return { hits: [] }

      const fresh = []
      for (const h of hits) {
        if (seenInRun.has(h.id)) continue
        seenInRun.add(h.id)
        fresh.push(h)
        logHits.push({ ...h, at: new Date().toISOString(), patches })
        while (logHits.length > 50) logHits.shift()
        push({ kind: 'log-issue', id: h.id, severity: h.severity, title: h.title, detail: h.detail })
      }
      if (fresh.length > 0) {
        const pkgs = [...new Set(patches.map(packageFromPatchKey).filter(Boolean))]
        try { onLogIssue?.({ hits: fresh, patches, packages: pkgs }) } catch (e) { log(`[sentinel] 回调炸了：${e?.message ?? e}`) }
      }
      return { hits: fresh, patches }
    },

    /** 一次安装结束了（cancelling/applying 之后）—— 清掉「同一次安装只报一次」的记性 */
    resetRun() { seenInRun.clear() },

    /** 立刻比一次指纹。返回 {diff, versions} */
    check({ reason = 'manual' } = {}) {
      const next = fingerprintProfile(dir)
      const diff = diffFingerprint(baseline, next)
      baseline = next
      lastDiff = diff
      lastAt = new Date().toISOString()
      persistBaseline()
      if (diff.changed) push({ kind: 'profile-change', reason, diff })
      return { diff, reason }
    },

    /**
     * 宿主说 profile 变了 —— 但别立刻比。
     * 装动作是一串密集事件，等到安静下来再拍，免得比到「装了一半」的中间态。
     */
    onHostChange(reason, { onDiff } = {}) {
      pendingReason = reason ?? pendingReason ?? 'host'
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const r = pendingReason
        pendingReason = null
        try {
          const { diff } = this.check({ reason: r ?? 'host' })
          if (diff.changed) onDiff?.({ diff, reason: r ?? 'host' })
        } catch (e) {
          log(`[sentinel] 比指纹失败：${e?.message ?? e}`)
        }
      }, Math.max(200, Number(debounceMs) || DEFAULT_DEBOUNCE_MS))
      timer.unref?.()
      return true
    },

    /** 停掉定时器（插件卸载时） */
    dispose() {
      if (timer) { clearTimeout(timer); timer = null }
    },

    state() {
      return {
        dir,
        lastAt,
        deps: baseline ? Object.keys(baseline.deps ?? {}).length : 0,
        patches: baseline ? Object.keys(baseline.registered ?? {}).length : 0,
        patchFiles: baseline ? Object.keys(baseline.patchFiles ?? {}).length : 0,
        lastDiff,
        logHits: logHits.slice(-10),
        events: events.slice(-20),
      }
    },

    summary() {
      const st = this.state()
      const lines = ['## 市场哨兵', `看守目录：\`${dir}\``]
      lines.push(`基线：${st.lastAt ? `拍于 ${String(st.lastAt).replace('T', ' ').slice(0, 19)}` : '还没拍'}`)
      lines.push(`盯住 ${st.deps} 个依赖、${st.patches} 个已登记补丁、${st.patchFiles} 个 patch 文件。`)
      if (st.lastDiff) lines.push(`\n最近一次对比：\n${renderDiff(st.lastDiff)}`)
      else lines.push('\n还没对比过 —— 等市场那边动一次就知道了。')
      if (st.logHits.length) {
        lines.push('\n最近拦到的安装问题：')
        for (const h of st.logHits.slice().reverse()) {
          lines.push(`- [${h.severity}] ${h.title}（${String(h.at).slice(11, 19)}）`)
          if (h.detail) lines.push(`  - 涉及：${h.detail}`)
        }
      }
      return lines.join('\n')
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  接到宿主事件上
// ─────────────────────────────────────────────────────────────────────────────
//  宿主的三个事件（`cordis_inspect_query` provider=Event 查到的）：
//    · plugin-manager/changed        —— profile 的插件/bundle/composition 变了
//    · plugin-manager/install-state  —— 值有 cancelling / applying / doneFailed …
//    · plugin-manager/install-log    —— 安装过程中的输出行
//  ⚠️ 这三个事件的**载荷形态没有强类型可查**，所以下面每个取值都做兼容：
//     可能是裸字符串，也可能是 {text}/{chunk}/{line} 或 {state}/{phase}/{status}。
//     取不到就当没这事 —— 观察者少看一眼，总比把插件带塌好。
export function attachSentinel(sentinel, { on, onDiff, onLogIssue, log = () => {} } = {}) {
  const offs = []
  const wire = (ev, handler) => {
    try {
      const off = on(ev, handler)
      if (typeof off === 'function') offs.push(off)
      else if (off && typeof off.off === 'function') offs.push(() => off.off())
    } catch (e) {
      log(`[sentinel] 订阅 ${ev} 失败：${e?.message ?? e}`)
    }
  }
  const str = (payload, keys) => {
    if (typeof payload === 'string') return payload
    if (!payload || typeof payload !== 'object') return ''
    for (const k of keys) {
      const v = payload[k]
      if (typeof v === 'string' && v) return v
    }
    return ''
  }

  wire('plugin-manager/install-log', (payload) => {
    const chunk = str(payload, ['text', 'chunk', 'line', 'message', 'log'])
    if (!chunk) return
    try { sentinel.noteChunk(chunk, { onLogIssue }) } catch (e) { log(`[sentinel] 读安装日志失败：${e?.message ?? e}`) }
  })

  wire('plugin-manager/install-state', (payload) => {
    const state = str(payload, ['state', 'phase', 'status', 'value'])
    // 一次安装结束（成或败）就清一次「同一种问题只报一次」的记性，
    // 否则同一天里第二次踩同一个坑会被吞掉。
    if (!state) return
    if (/done|fail|finish|complete|cancel|error/i.test(state)) {
      try { sentinel.resetRun() } catch { /* ignore */ }
      try { sentinel.onHostChange(`market ${state}`, { onDiff }) } catch (e) { log(`[sentinel] ${e?.message ?? e}`) }
    }
  })

  wire('plugin-manager/changed', (payload) => {
    // 参数是 PluginChange，内容用不上 —— 有变化这件事本身就够了
    void payload
    try { sentinel.onHostChange('market changed', { onDiff }) } catch (e) { log(`[sentinel] ${e?.message ?? e}`) }
  })

  return () => {
    for (const off of offs) { try { off() } catch { /* ignore */ } }
    try { sentinel.dispose?.() } catch { /* ignore */ }
  }
}