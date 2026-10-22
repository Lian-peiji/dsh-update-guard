/**
 * lib/index.js —— dsh-update-guard 的宿主主入口
 * ============================================================================
 * 主人原话（m00002）：
 *   「设计一个更新管理器，每次更新用一个模型先看看更新了什么东西，然后看看我需不需要
 *     更新？更新会导致什么bug？要更新就更新并修复bug（原本的补丁打回去不要被覆盖）」
 *
 * 主人后来钉死的底线（m00756）：
 *   「插件的底线就是保持 DSH 和插件能正常稳定使用，可以暂时不更新，或者排除风险后、
 *     打补丁后更新。要确保弄完前和后用户能稳定使用。插件功能会不会重复、冗余不是我们
 *     要关心的事。」
 *
 * 🔴 本文件只做**编排**：把 lib/ 下已经写好的模块接起来，注册成工具。
 *    所有判断逻辑都在 recon / review / patchledger / install-guard 里，这里不重复实现。
 *
 * ⚠️ 三条写这个文件时踩过/差点踩的坑：
 *   ① **参数一律写标准 JSON Schema**（带 additionalProperties）。
 *      defineTool 的 spec 形式（`{key:{type,required}}`）在拿不到宿主 dsh-tools、
 *      退到 hostdeps 的 localDefineTool 时**不会被转换**，宿主会收到非法 schema。
 *   ② **插件必须在任何情况下都能加载**。
 *      `@deepseek-ai/*` 在桌面版 profile 里永远不装（autoInstallPeers: false），
 *      所以 defineTool / createUserMessage 都走 hostdeps 的三级兜底，绝不裸 import。
 *   ③ **工具执行里绝不能 throw 出未捕获的东西**。
 *      工具报错会打断整个 turn；这里统一 try/catch 成 `{ok:false, message}`，
 *      让模型自己看到失败原因并决定下一步，而不是让主人的会话崩掉。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

import { loadHostDeps } from './hostdeps.mjs'
import {
  dshHome, isProfileName, profileDir, scanProfile, listProfiles, guessActiveProfile,
  readProfileManifest, readPatchedDependencies, installedVersion,
} from './profile.js'
import { reconPackage, deepDive, fetchTarball, DEFAULT_REGISTRY, parseTargetSpec, resolveTargetVersion } from './recon.js'
import { review, VERDICTS } from './review.js'
import { scanPatches, patchesFor, patchBrief, writeIntentTemplate, patchFiles, readIntent } from './patchledger.js'
import { fixPatch } from './patchfix.js'
import { staticCheck, renderReport, buildReviewMaterial, INSTALL_SYSTEM } from './install-guard.js'
import { compare, bumpType } from './semver.js'
import { findToolchain, homeOf, sandboxTrial, renderTrial } from './sandbox-trial.js'
import { applyUpdate, renderApply, listBackups, rollback, APPLY_RESULT } from './apply.js'
import { createMemory, buildErrorDoc } from './memory.js'
import { ROUTE, createApiHandler, buildSources } from './webapi.js'
import { jsonSafe } from './jsonsafe.js'
import { createIdleTracker, attachIdle, scanBusySessions, DEFAULT_QUIET_MS } from './idle.js'
import { readQueue, addJob, removeJob, clearQueue, pendingJobs, renderQueue, createPump, MAX_TRIES } from './queue.js'
import { createSentinel, attachSentinel, renderDiff, packageFromPatchKey } from './sentinel.js'
import { planRestart, restartSelf, getElectronApp, restartLogPath, restartResultPath, BOOT_SETTLE_MS, RESTART_TRIES } from './restart.js'

// ⚠️ 顶层 await：hostdeps 走动态解析，必须等它回来才能拿 defineTool。
//    拿不到也只是降级，不会让整条插件不激活（这正是 hostdeps 存在的理由）。
const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool
const createUserMessage = hostDeps.createUserMessage
const z = hostDeps.z

export const name = 'update-guard'

// 只有这两个是硬依赖：没有 tools 就没法注册工具，没有 llm 就没法审。
// webServer / timer 走 ctx.get 软取，拿不到就少几个入口，不影响核心功能。
export const inject = ['tools', 'llm']

const PLUGIN_ID = 'dsh-update-guard'

/** 默认 registry：跟 recon 保持一致，主人可以在设置页改成 npmmirror */
const DEFAULT_CONFIG = {
  profile: '',
  profileDir: '',
  registry: DEFAULT_REGISTRY,
  includePrerelease: false,
  scanConcurrency: 6,
  /** 风险分级用哪两个模型（主人在设置页选；留空 = 跟随会话默认模型） */
  cheapProvider: '',
  cheapModel: '',
  strongProvider: '',
  strongModel: '',
  /** 新装插件的硬拦截开关 */
  blockUncheckedInstall: true,
  /** P4：后台队列（只在空闲时动手） */
  queueEnabled: true,
  queueIntervalMs: 60_000,
  /** 安静多久才算空闲 —— running→idle 那一刻主人往往还在打字 */
  idleQuietMs: 120_000,
  /** 装完之后怎么办：notify=只提示；auto=自动重启；never=什么都不做 */
  restartAfterApply: 'notify',
  /** 桌面端可执行文件（留空 = 用 process.execPath） */
  appExe: '',
  /** 补丁打不上时，让模型把它重新对准新版本（过不了机械验收就放弃、照常回滚） */
  patchFix: true,
  /** 重写补丁时给模型的输出额度 */
  patchFixTokens: 8000,
  /** 市场哨兵：主人自己在插件市场点更新时，我们只观察+记录（不干预） */
  sentinel: true,
  /** 市场事件很密（一次安装刷一串），等安静下来再比指纹 */
  sentinelDebounceMs: 2500,
}

export const Config = !z ? undefined : z.object({
  profile: z.string().default('').extra('volatile', true),
  profileDir: z.string().default('').extra('volatile', true),
  registry: z.string().default(DEFAULT_REGISTRY).extra('volatile', true),
  includePrerelease: z.boolean().default(false).extra('volatile', true),
  scanConcurrency: z.natural().default(6).extra('volatile', true),
  cheapProvider: z.string().default('').extra('volatile', true),
  cheapModel: z.string().default('').extra('volatile', true),
  strongProvider: z.string().default('').extra('volatile', true),
  strongModel: z.string().default('').extra('volatile', true),
  blockUncheckedInstall: z.boolean().default(true).extra('volatile', true),
  queueEnabled: z.boolean().default(true).extra('volatile', true),
  queueIntervalMs: z.natural().default(60000).extra('volatile', true),
  idleQuietMs: z.natural().default(120000).extra('volatile', true),
  restartAfterApply: z.string().default('notify').extra('volatile', true),
  appExe: z.string().default('').extra('volatile', true),
  patchFix: z.boolean().default(true).extra('volatile', true),
  patchFixTokens: z.natural().default(8000).extra('volatile', true),
  sentinel: z.boolean().default(true).extra('volatile', true),
  sentinelDebounceMs: z.natural().default(2500).extra('volatile', true),
})

// ─────────────────────────────────────────────────────────────────────────────
//  小工具
// ─────────────────────────────────────────────────────────────────────────────

/** 把任何东西变成一段能看的文字（工具返回值最后都要落到文本上） */
function text(t) {
  return { type: 'text', text: String(t ?? '') }
}

/** 统一的结果包装：永不 throw，永远给模型一个能读懂的结构 */
// 日志出口：apply() 里接上 ctx.logger（模块级 ok()/fail() 拿不到 ctx）
let logSink = null

function ok(value) {
  // 🔴 真机事故（2026-10-22）：`plugin_update_trial` 在宿主里报
  //    "returned invalid output: value is not lossless JSON"，
  //    同一个对象在 node 里单跑却完全正常 —— 返回值里混进了 JSON 表达不了的
  //    东西（undefined / NaN / 孤立代理项 / 类实例…）。所有出口统一过一遍。
  const r = jsonSafe({ ok: true, ...value }, 'result')
  if (r.fixed.length > 0) {
    logSink?.(`[${PLUGIN_ID}] 工具返回值做了 JSON 安全化：${r.fixed.slice(0, 10).join('；')}${r.fixed.length > 10 ? ` …（共 ${r.fixed.length} 处）` : ''}`)
  }
  return r.value
}
function fail(message, extra) {
  const r = jsonSafe({ ok: false, message, ...(extra ?? {}) }, 'result')
  if (r.fixed.length > 0) {
    logSink?.(`[${PLUGIN_ID}] 错误返回值做了 JSON 安全化：${r.fixed.slice(0, 10).join('；')}`)
  }
  return r.value
}

// ─────────────────────────────────────────────────────────────────────────────
//  配置读取：宿主交给 apply() 的 config 值**不一定是裸字符串**
// ─────────────────────────────────────────────────────────────────────────────
//  🔴 真机踩到的坑（20261022，P3 验收时发现）—— 日志里留下的原文：
//     补丁账本打印出 `E:\dsh\profiles\desktop\[object Object]`、还报"没有任何本地补丁"。
//     **实测结论**（用临时诊断打印过真身）：
//       宿主交给 apply() 的 config 里，**每个没设置的字段都是空对象 `{}`**，
//       不是 `''` / `false` / `6`。十个字段无一例外，全都 `typeof === 'object'`。
//     于是老代码 `String(cfg.profileDir || '')` 得到字符串 "[object Object]"，
//     `resolve()` 把它挂到 cwd 上 → 扫了一个根本不存在的目录。
//     更隐蔽的是其余字段：`cfg.registry` 也是 `{}`，
//     拼出来的请求 URL 是 `[object Object]/dsh-pocket` —— 扫描/审查/试跑全都会
//     静默用错值（或干脆 404），而工具本身"没报错"，看起来一切正常。
//
//  对策：所有 cfg 字段一律经下面三个函数取值 —— 只有拆包后是真正的标量才算数，
//        其余（对象、undefined、NaN）一律退回默认值。宿主以后换包装形态也不会炸。
const CFG_SHAPE = {}

/** 拆掉可能的响应式包装（{value} / Ref.get() / {current}），只留下一层裸值 */
function unwrapCfg(v, depth = 0) {
  if (v === null || typeof v !== 'object' || depth > 6) return v
  if ('value' in v) {
    const inner = v.value
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean' || inner === null) {
      return unwrapCfg(inner, depth + 1)
    }
  }
  if (typeof v.get === 'function' && !Array.isArray(v)) {
    try {
      const got = v.get()
      if (typeof got === 'string' || typeof got === 'number' || typeof got === 'boolean') return got
    } catch { /* 拿不到就算了 */ }
  }
  if ('current' in v && typeof v.current !== 'function' && (typeof v.current === 'string' || typeof v.current === 'number' || typeof v.current === 'boolean')) {
    return v.current
  }
  return v
}

/** 取字符串配置：拿不到干净的字符串就用默认值 */
function cfgStr(v, d = '') {
  const u = unwrapCfg(v)
  if (typeof u === 'string') return u
  if (typeof u === 'number' && Number.isFinite(u)) return String(u)
  return d
}

/** 取布尔配置 */
function cfgBool(v, d = false) {
  const u = unwrapCfg(v)
  if (typeof u === 'boolean') return u
  if (u === 'true') return true
  if (u === 'false') return false
  return d
}

/** 取正整数配置 */
function cfgNum(v, d, min = 1) {
  const u = unwrapCfg(v)
  const n = typeof u === 'number' ? u : Number(u)
  return Number.isFinite(n) && n >= min ? Math.floor(n) : d
}

/** 并发限制地跑一批 Promise（registry 打太猛会被限流） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch (e) { out[i] = { error: String(e?.message ?? e) } }
    }
  })
  await Promise.all(workers)
  return out
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────────────
//  插件本体
// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // ok()/fail() 是模块级函数，拿不到 ctx；把日志口接上
  logSink = (m) => { try { ctx.logger?.info?.(m) } catch { /* 记日志失败不能影响工具 */ } }

  //  ⚠️ 一定经 cfgStr/cfgBool/cfgNum 归一化，别直接展开 —— 见上面注释里那个
  //     "[object Object]" 事故：宿主给的值可能是包装对象，直接 String() 会把整个
  //     profile 定位到 cwd 下去，工具于是"看着能用、其实扫的是空气"。
  const rawCfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  for (const [k, v] of Object.entries(config ?? {})) {
    const u = unwrapCfg(v)
    // 空对象是这台宿主的"未设置"表示（见上面注释），属于正常，不当异常记；
    // 只有拆包后仍是个**有内容**的对象才值得留证据（说明宿主又换了包装方式）。
    if (u !== null && typeof u === 'object' && Object.keys(u).length > 0) {
      CFG_SHAPE[k] = { keys: Object.keys(u).slice(0, 10), ctor: u?.constructor?.name ?? 'Object' }
    }
  }
  const cfg = {
    profile: cfgStr(rawCfg.profile),
    profileDir: cfgStr(rawCfg.profileDir),
    registry: cfgStr(rawCfg.registry, DEFAULT_REGISTRY) || DEFAULT_REGISTRY,
    includePrerelease: cfgBool(rawCfg.includePrerelease, false),
    scanConcurrency: cfgNum(rawCfg.scanConcurrency, 6, 1),
    cheapProvider: cfgStr(rawCfg.cheapProvider),
    cheapModel: cfgStr(rawCfg.cheapModel),
    strongProvider: cfgStr(rawCfg.strongProvider),
    strongModel: cfgStr(rawCfg.strongModel),
    blockUncheckedInstall: cfgBool(rawCfg.blockUncheckedInstall, true),
    queueEnabled: cfgBool(rawCfg.queueEnabled, true),
    queueIntervalMs: cfgNum(rawCfg.queueIntervalMs, 60_000, 10),
    idleQuietMs: cfgNum(rawCfg.idleQuietMs, 120_000, 5),
    restartAfterApply: cfgStr(rawCfg.restartAfterApply, 'notify') || 'notify',
    appExe: cfgStr(rawCfg.appExe),
    patchFix: cfgBool(rawCfg.patchFix, true),
    patchFixTokens: cfgNum(rawCfg.patchFixTokens, 8000, 100),
  }

  // ⭐ 记忆落盘位置：跟其它插件一样放 ~/.dsh 下，不塞进包目录
  //    —— 包目录会被 pnpm 重装覆盖，记忆丢了就等于这个插件的存在意义没了。
  //
  //    P3 起换成「记忆双库」（lib/memory.js）：
  //      更新档案 ledger.jsonl  —— 机器读，算事故率
  //      错误知识库 errors/*.md —— 人和模型读，防重复踩坑
  //    旧的 history.json 保留只读兼容（下面 legacyHistoryFor），
  //    老用户的记录不能因为换格式就消失。
  const stateDir = join(dshHome(), 'dsh-update-guard')
  const memory = createMemory(stateDir)

  // 配置形态诊断：只有在真的收到"非标量配置"时才落一份盘，
  // 方便下次宿主换个包装形态时一眼看出它给了什么（平时不会生成这个文件）。
  if (Object.keys(CFG_SHAPE).length > 0) {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'config-shape.json'), JSON.stringify({
        at: new Date().toISOString(),
        shape: CFG_SHAPE,
        effective: { profile: cfg.profile, profileDir: cfg.profileDir, registry: cfg.registry },
      }, null, 2))
    } catch { /* 诊断文件写不进去不影响主流程 */ }
  }
  const legacyHistoryFile = join(stateDir, 'history.json')

  /** 旧格式（history.json）读取，只用于迁移和兼容 —— 不再写入 */
  const legacyHistoryFor = (pkgName) => {
    try {
      const all = JSON.parse(readFileSync(legacyHistoryFile, 'utf8'))
      return Array.isArray(all[pkgName]) ? all[pkgName] : []
    } catch { return [] }
  }

  /**
   * 给审查模型看的历史：新档案 + 旧病历合并，新的在前。
   *
   * 为什么要合并而不是只用新的：主人这套 profile 已经跑过很多次更新，
   * 那些历史躺在 history.json 里。换成新库就看不见它们，等于让模型失忆。
   */
  const historyFor = (pkgName) => {
    const fromLedger = memory.read({ name: pkgName, limit: 40 }).map((r) => ({
      at: r.at,
      from: r.from,
      to: r.to,
      outcome: r.result,
      note: r.reason,
    }))
    const legacy = legacyHistoryFor(pkgName)
    const merged = [...fromLedger, ...legacy]
    merged.sort((a, b) => (String(a.at ?? '') < String(b.at ?? '') ? 1 : -1))
    return merged.slice(0, 40)
  }

  /**
   * 记一条更新档案。
   *
   * 统一入口的意义：原来散在 5 个地方的 appendHistory 各写各的字段，
   * 迟早出现「这边记了 result 那边记了 outcome」的脏数据。
   *
   * ⚠️ 老调用点写的是 `outcome`，新档案的字段叫 `result`。这里做一次映射，
   *    而不是回头改 5 个调用点 —— 少一次改动就少一次改错的机会。
   */
  const appendHistory = (pkgName, entry) => {
    const e = { ...entry }
    if (e.result == null && e.outcome != null) e.result = e.outcome
    delete e.outcome
    return memory.append({ name: pkgName, ...e })
  }

  // ── 体检放行表：体检过的 spec 才允许被 plugin_manager 装 ──────────────
  //    ⚠️ 必须声明在工具之前：工具的 execute 闭包会引用它（TDZ 会炸）。
  const vetted = new Map()   // `${dir}::${spec}` → { at, ok, caution }
  const VET_TTL_MS = 30 * 60 * 1000

  function vetKey(dir, spec) { return `${dir}::${spec}` }
  function isVetted(dir, spec) {
    const hit = vetted.get(vetKey(dir, spec))
    if (!hit) return null
    if (Date.now() - hit.at > VET_TTL_MS) { vetted.delete(vetKey(dir, spec)); return null }
    return hit
  }

  /** 定位当前要操作的 profile 目录 */
  function resolveProfileDir(args) {
    // 只用干净字符串；显式目录还必须是绝对路径 —— 否则 resolve() 会挂到 cwd 上，
    // 那就是 "[object Object]" 那次事故的现场（见文件上方 cfgStr 的注释）。
    const explicit = (cfgStr(args?.profileDir) || cfg.profileDir).trim()
    if (explicit) {
      if (!isAbsolute(explicit)) {
        throw new Error(`profileDir 必须是绝对路径：${JSON.stringify(explicit)}`)
      }
      return { dir: profileDir('', explicit), from: 'explicit' }
    }
    const named = (cfgStr(args?.profile) || cfg.profile).trim()
    if (named) {
      if (!isProfileName(named)) throw new Error(`非法 profile 名：${JSON.stringify(named)}`)
      return { dir: profileDir(named), from: 'named', name: named }
    }
    const guessed = guessActiveProfile()
    if (!guessed) throw new Error('这台机器上找不到任何 DSH profile —— 请先在设置里填 profile 名或目录')
    return { dir: profileDir(guessed), from: 'guessed', name: guessed }
  }

  // ── 模型调用（review / install-guard 都要用）──────────────────────────
  //    签名跟 lib/review.js 约定的一致：ask(system, user, {tier, maxTokens}) →
  //    {ok, text, error, provider, model}
  const llm = ctx.get('llm')

  function pickModel(tier) {
    const t = tier === 'strong' ? 'strong' : 'cheap'
    const p = String(t === 'strong' ? cfg.strongProvider : cfg.cheapProvider || '').trim()
    const m = String(t === 'strong' ? cfg.strongModel : cfg.cheapModel || '').trim()
    if (p && m) return { provider: p, model: m, from: `设置页的 ${t}` }
    // 没配就跟随当前默认模型（主人在界面上选的那个）
    try {
      const svc = ctx.get('agentDefaultModel')
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model, from: '默认模型' }
    } catch { /* 服务不在就算了 */ }
    return null
  }

  async function ask(system, user, { tier = 'cheap', maxTokens = 2000, signal } = {}) {
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: '宿主没有提供 llm 服务' }
    const target = pickModel(tier)
    if (!target) {
      return {
        ok: false,
        error: '拿不到模型：设置页的模型没填，宿主也没给默认模型。请在 dsh-update-guard 的设置里填 cheapProvider/cheapModel。',
      }
    }
    let messages
    try {
      messages = [createUserMessage({
        content: [text(user)],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      })]
    } catch (e) {
      return { ok: false, error: `构造消息失败：${e?.message ?? e}` }
    }

    let out = ''
    let truncated = false
    try {
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system,
        messages,
        maxTokens,
        temperature: 0.1,
        ...(signal ? { signal } : {}),
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish') {
          const kind = String(chunk.reason?.kind ?? '')
          // 撞到 maxTokens 就叫它一声：上层可以据此重试（见 lib/review.js 的 retryNote）
          if (kind === 'length' || kind === 'max-tokens' || kind === 'max_tokens' || kind === 'maxTokens') truncated = true
          if (chunk.reason && kind === 'error') {
            const f = chunk.reason.failure || {}
            return { ok: false, error: `模型报错：${f.message || f.code || '未知'}`, provider: target.provider, model: target.model }
          }
        }
      }
    } catch (e) {
      return { ok: false, error: `调用失败：${e?.message ?? e}`, provider: target.provider, model: target.model }
    }
    return { ok: true, text: String(out || '').trim(), truncated, provider: target.provider, model: target.model }
  }

  const tiers = () => ({
    cheap: { provider: cfg.cheapProvider, model: cfg.cheapModel },
    strong: { provider: cfg.strongProvider, model: cfg.strongModel },
  })

  // ═══════════════════════════════════════════════════════════════════════
  //  更新一个包的完整流程 —— 工具和后台队列共用同一份
  // ═══════════════════════════════════════════════════════════════════════
  //  为什么抽出来：P4 的后台队列要在「空闲时」自己跑这件事。
  //  如果队列另写一份，两份逻辑迟早跑偏（试跑漏了、回滚少一步…），
  //  而这类偏差的代价就是主人说的「天天都上当」。
/**
   * 补丁打不上时，让模型把补丁「重新对准」新版本。
   *
   * 🔴 定位：**只做对齐，不做重新发明**。三道闸门任何一道不过就当没发生过：
   *   ① 新补丁必须能干净地打在新版原文件上（applyHunksToText 机械验）；
   *   ② 原补丁新增的函数/常量名，新补丁里必须都还在（防它悄悄删功能）；
   *   ③ 只允许改一个文件（多文件补丁留给人）。
   *   闸门全过才写盘，并且**先备份旧补丁**（.bak-时间戳）—— 主人的原话是
   *   「补丁修不好 → 放弃更新保留旧版」，所以这里绝不允许"猜一个上去试试"。
   */
  async function repairPatches({ dir, pkgName, toVersion, failureNote = '' }) {
    if (!cfg.patchFix) return { tried: false, fixed: 0, results: [] }
    const table = readPatchedDependencies(dir)
    const mine = Object.entries(table).filter(([k]) => {
      const at = k.lastIndexOf('@')
      return at > 0 && k.slice(0, at) === pkgName
    })
    if (mine.length === 0) return { tried: false, fixed: 0, results: [] }

    // 新版原始文件从 tarball 拿，不信任 node_modules（失败后那里可能是半新半旧）
    let tarball = null
    try {
      tarball = await fetchTarball(cfg.registry, pkgName, toVersion)
    } catch (e) {
      const reason = '拿不到 ' + pkgName + '@' + toVersion + ' 的原始文件：' + (e?.message ?? e)
      return { tried: true, fixed: 0, results: mine.map(([key]) => ({ key, ok: false, reason })) }
    }

    const results = []
    for (const [key, rel] of mine) {
      const patchPath = join(dir, String(rel))
      if (!existsSync(patchPath)) { results.push({ key, ok: false, reason: '补丁文件不在磁盘上' }); continue }
      const patchText = readFileSync(patchPath, 'utf8')
      const targets = patchFiles(patchText)
      if (targets.length !== 1) {
        results.push({ key, ok: false, reason: '这个补丁改了 ' + targets.length + ' 个文件，自动重写只支持单文件（留给人工）' })
        continue
      }
      const tp = targets[0]
      const buf = tarball.get(tp)
      if (!buf) {
        results.push({ key, ok: false, reason: '新版里没有 ' + tp + '（上游换文件/换目录了，这是"重写"不是"对齐"，留给人）' })
        continue
      }
      const intentText = readIntent(dir, key)?.body ?? ''
      const r = await fixPatch({
        ask, tier: 'strong', maxTokens: cfg.patchFixTokens,
        targetPath: tp, patchText, newFileText: buf.toString('utf8'), intentText, failureNote,
      })
      if (!r.ok) { results.push({ key, ok: false, reason: r.reason, skipped: !!r.skipped }); continue }
      try {
        const backup = patchPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
        writeFileSync(backup, patchText, 'utf8')
        writeFileSync(patchPath, r.patchText.endsWith('\n') ? r.patchText : r.patchText + '\n', 'utf8')
        results.push({ key, ok: true, why: r.why, backup })
        plog('补丁重写成功：' + key + '（备份 ' + backup + '）')
      } catch (e) {
        results.push({ key, ok: false, reason: '写回补丁失败：' + (e?.message ?? e) })
      }
    }
    return { tried: true, fixed: results.filter((x) => x.ok).length, results }
  }

  /** 补丁重写这件事怎么跟主人说清楚（成了、没成、为什么） */
  function renderPatchFix(rep) {
    if (!rep?.tried || rep.results.length === 0) return ''
    const out = ['', '### 补丁重写（打不上时让模型重新对准）']
    for (const r of rep.results) {
      if (r.ok) out.push('- ✅ ' + r.key + '：' + (r.why || '已重新对准新版'))
      else out.push('- ' + (r.skipped ? '⏭️' : '❌') + ' ' + r.key + '：' + r.reason)
    }
    if (rep.fixed === 0) out.push('', '没重写成功 —— 按主人的规矩：**这次更新放弃，保留旧版**。')
    return out.join('\n')
  }

  async function runUpdate({
    dir, pkgName, toVersion = '',
    skipTrial = false, skipVerify = false,
    installTimeoutSec = 600, shouldAbort = null,
  } = {}) {
    const current = installedVersion(dir, pkgName)
    if (!current) return { ok: false, fatal: true, report: `目录 ${dir} 里没装 ${pkgName} —— 新装请用 plugin_install_check` }

    let to = String(toVersion || '').trim()
    if (!to) {
      const r = await reconPackage(cfg.registry, { name: pkgName, sourceKind: 'registry', actualVersion: current, declaredVersion: current })
      if (!r.latest) return { ok: false, fatal: true, report: `查不到 ${pkgName} 的版本：${r.reason}` }
      to = r.latest
    }

    // 🔴 非 registry 目标（github:owner/repo#sha、tarball 地址）不能直接当版本号用：
    //    补丁 key 必须是真版本（`包名@1.2.2`），否则 pnpm 报 ERR_PNPM_UNUSED_PATCH，
    //    整个 profile 都装不动。这里先把真版本扒出来，spec 单独留给 manifest。
    let targetSpec = null
    let targetNote = ''
    const specInfo = parseTargetSpec(to)
    if (specInfo.kind !== 'version') {
      try {
        const resolved = await resolveTargetVersion({ name: pkgName, to, registry: cfg.registry })
        // 🔴 换 spec 要用 **codeload tarball 地址**，不能用 `github:owner/repo#sha` 简写：
        //    机器上到 github.com:443 是连不通的（pnpm 会去 git clone，ETIMEDOUT →
        //    ERR_PNPM_GIT_FETCH_FAILED）；而 codeload 是通的（主人现有的 spec 就是这个形状）。
        targetSpec = specInfo.kind === 'github'
          ? (resolved.tarballUrl ?? specInfo.tarballUrl ?? specInfo.spec)
          : specInfo.kind === 'tarball' ? specInfo.spec : null
        targetNote = `目标源：${String(targetSpec ?? specInfo.spec).slice(0, 100)}（里面写的版本是 ${resolved.version}）`
        to = resolved.version
      } catch (e) {
        return { ok: false, fatal: true, report: `认不出目标「${to}」是什么：${e?.message ?? e}` }
      }
    }
    if (compare(to, current) === 0) {
      return { ok: true, report: `${pkgName} 已经是 ${to}，不用动。`, result: APPLY_RESULT.NOOP, fromVersion: current, toVersion: to }
    }
    if (compare(to, current) < 0) {
      return { ok: false, fatal: true, report: `目标版本 ${to} 比现在的 ${current} 还旧 —— 降级请明确说明，这个工具不做降级` }
    }

    const toolchain = findToolchain({ home: homeOf(dir) })
    const lines = [`## 更新：${pkgName} ${current} → ${to}`]
    if (targetNote) lines.push(`（${targetNote}）`)

    // ① 沙箱试跑（默认开）
    let trial = null
    if (!skipTrial) {
      if (shouldAbort?.()) return { aborted: true, reason: '主人在用，让位' }
      trial = await sandboxTrial({
        profileDir: dir, name: pkgName, fromVersion: current, toVersion: to, targetSpec,
        toolchain, installTimeoutMs: Math.max(30, Number(installTimeoutSec) || 600) * 1000,
      })
      lines.push('\n' + renderTrial(trial))
      if (!trial.ok && trial.verdict !== 'skip') {
        lines.push('\n🔴 **试跑没过，这次更新取消**，主人的 profile 一个字都没动。')
        appendHistory(pkgName, {
          kind: 'apply-refused', from: current, to,
          outcome: 'trial-failed', note: String(trial.reason ?? '').slice(0, 200),
        })
        return { ok: false, report: lines.join('\n'), result: 'refused', reason: trial.reason, trial, fromVersion: current, toVersion: to }
      }
    } else {
      lines.push('\n（跳过了沙箱试跑）')
    }

    // ② 真装（内部含快照 / 补丁重定位 / 验证 / 自动回滚）
    if (shouldAbort?.()) return { aborted: true, reason: '主人在用，让位（试跑之后、真装之前）' }
    const applyArgs = {
      profileDir: dir, name: pkgName, toVersion: to, targetSpec,
      toolchain,
      verify: !skipVerify,
      installTimeoutMs: Math.max(30, Number(installTimeoutSec) || 600) * 1000,
    }
    let report = await applyUpdate(applyArgs)
    lines.push('\n' + renderApply(report))

    // ②-b 补丁打不上 → 试一次「重新对准」，过了机械验收再装一遍
    let patchFix = null
    if (report.result === APPLY_RESULT.ROLLED_BACK && report.patchProblem && cfg.patchFix) {
      if (shouldAbort?.()) return { aborted: true, reason: '主人在用，让位（补丁重写之前）' }
      patchFix = await repairPatches({ dir, pkgName, toVersion: to, failureNote: String(report.reason ?? '') })
      lines.push(renderPatchFix(patchFix))
      if (patchFix.fixed > 0) {
        lines.push('', '（补丁重写通过了机械验收，再装一次）')
        report = await applyUpdate(applyArgs)
        lines.push('\n' + renderApply(report))
      }
    }

    // ③ 落病历 —— 主人下次能看见「这包上次更新就翻过车」
    appendHistory(pkgName, {
      kind: 'apply', from: current, to,
      outcome: report.result,
      note: String(report.reason ?? '').slice(0, 300),
      snapshot: report.snapshot ?? null,
    })

    if (report.result === APPLY_RESULT.APPLIED) {
      lines.push('\n✅ 更新完成。要让新版本真正生效，需要重启 DSH。')
      if (cfg.restartAfterApply === 'auto') lines.push('（设置里开了「装完自动重启」，马上会重启）')
      else lines.push('（设置里是「只提示」：想让我帮你安全重启，调 `plugin_restart`）')
    } else if (report.result === APPLY_RESULT.ROLLED_BACK) {
      lines.push('\n↩️ **已经自动退回原样了**，主人的 DSH 还是好的。')
      lines.push('退回去的原因就是上面那条 —— 这个版本暂时不能上。')
    }

    return {
      ok: report.ok,
      report: lines.join('\n'),
      result: report.result,
      reason: report.reason,
      fromVersion: current,
      toVersion: to,
      snapshot: report.snapshot ?? null,
      trial,
      patchFix,
      steps: report.steps,
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 1：plugin_update_scan —— 只读扫描，谁有新版本
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_update_scan',
    description:
      '扫描当前 DSH profile 里装的所有插件，查 npm registry 看哪些有新版本。' +
      '**只读**：不下载、不安装、不改任何东西。' +
      '想进一步知道"某个更新值不值得装"，再对具体包调 plugin_update_review。',
    parameters: {
      profile: { type: 'string', description: 'profile 名（不填就用设置页的，再不然自动挑装得最多的那个）' },
      profileDir: { type: 'string', description: 'profile 目录的绝对路径（桌面版用这个更准，优先级高于 profile）' },
      includePrerelease: { type: 'boolean', description: '要不要把 next/beta 标签也算进目标版本（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '扫描失败'}`)]
        return [text(value.report ?? '扫描完成')]
      },
    },
    async execute(args) {
      try {
        const { dir, from, name: pname } = resolveProfileDir(args)
        const pkgs = scanProfile(dir)
        if (pkgs.length === 0) return ok({ report: `${dir} 里一个依赖都没有。` })

        const includePrerelease = args?.includePrerelease ?? cfg.includePrerelease
        const results = await mapLimit(pkgs, Math.max(1, Number(cfg.scanConcurrency) || 6), (p) =>
          reconPackage(cfg.registry, p, { includePrerelease }))

        const updates = []
        const skipped = []
        const errored = []
        for (let i = 0; i < pkgs.length; i++) {
          const p = pkgs[i]
          const r = results[i]
          if (!r || r.error) { errored.push({ name: p.name, error: r?.error ?? '未知' }); continue }
          if (r.hasUpdate) updates.push({ ...r, patched: p.patched, description: p.description })
          else if (r.reason) skipped.push({ name: p.name, current: r.current, reason: r.reason })
        }

        updates.sort((a, b) => compare(b.latest, a.latest))

        const lines = [`## 插件更新扫描（${dir}）`]
        lines.push(`来源：${from === 'guessed' ? `自动选中 profile「${pname}」` : from === 'named' ? `profile「${pname}」` : '设置里指定的目录'}`)
        lines.push(`共 ${pkgs.length} 个依赖，**${updates.length} 个有更新**。`)

        if (updates.length > 0) {
          lines.push('\n### 有更新')
          for (const u of updates) {
            lines.push(`- **${u.name}** ${u.current} → ${u.latest}（${u.bump}）${u.patched ? ' 🔧有我们的补丁' : ''}`)
            if (u.deprecated) lines.push(`  - ⚠️ 新版已被上游弃用：${u.deprecated}`)
          }
          lines.push('\n想审某个包：调 `plugin_update_review`，name 填包名。')
        } else {
          lines.push('\n全部是最新的。')
        }

        if (skipped.length > 0) {
          lines.push(`\n### 不参与判断的（${skipped.length} 个）`)
          for (const s of skipped.slice(0, 20)) lines.push(`- ${s.name}：${s.reason}`)
          if (skipped.length > 20) lines.push(`  …还有 ${skipped.length - 20} 个`)
        }
        if (errored.length > 0) {
          lines.push(`\n### 查失败的（${errored.length} 个）`)
          for (const e of errored.slice(0, 10)) lines.push(`- ${e.name}：${e.error}`)
        }

        return ok({
          report: lines.join('\n'),
          profile: pname ?? null,
          dir,
          updates: updates.map((u) => ({ name: u.name, current: u.current, latest: u.latest, bump: u.bump, patched: !!u.patched })),
          skippedCount: skipped.length,
        })
      } catch (e) {
        return fail(`扫描失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 2：plugin_update_review —— 深挖 + 模型审查，出判决（仍然不装）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_update_review',
    description:
      '对某个插件的新版本做**完整审查**：下载新旧 tarball 逐文件 diff、捞 changelog、' +
      '带上我们打过的补丁和这个包的历史病历，让模型给出「装 / 先等等 / 跳过」的判决，' +
      '并预测会踩什么坑、我们的补丁该怎么处理（重放 / 重写 / 退役）。' +
      '**只读**：不安装任何东西。',
    parameters: {
      name: { type: 'string', required: true, description: '包名，例如 dsh-pocket' },
      to: { type: 'string', description: '目标版本；不填就用 registry 上的 latest' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
      usage: { type: 'string', description: '可选：我们怎么用这个包（喂给模型，判得更准）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '审查失败'}`)]
        return [text(value.report ?? '审查完成')]
      },
    },
    async execute(args) {
      try {
        const pkgName = String(args?.name || '').trim()
        if (!pkgName) return fail('必须给 name（包名）')

        const { dir, name: pname } = resolveProfileDir(args)
        const pkgs = scanProfile(dir)
        const pkg = pkgs.find((p) => p.name === pkgName)
        if (!pkg) return fail(`profile「${pname ?? dir}」里没有装 ${pkgName}（看看 plugin_update_scan 的清单）`)

        // ① 侦察：有没有新版本
        const recon = await reconPackage(cfg.registry, pkg, { includePrerelease: cfg.includePrerelease })
        if (!recon.current) return fail(`${pkgName} 判断不了：${recon.reason}`)
        if (!recon.latest) return fail(`${pkgName} 查不到目标版本：${recon.reason}`)

        const toVersion = String(args?.to || recon.latest).trim()
        if (compare(toVersion, recon.current) <= 0) {
          return ok({ report: `${pkgName} 已经是最新（${recon.current}），不用审。`, verdict: 'skip' })
        }
        const effective = { ...recon, latest: toVersion, bump: bumpType(recon.current, toVersion) }

        // ② 深挖：真的把两个 tarball 下来比
        const dive = await deepDive(cfg.registry, pkgName, recon.current, toVersion, {})

        // ③ 我们的补丁（这是判"会不会把 bug 带回来"的核心）
        const patchedDeps = readPatchedDependencies(dir)
        const patches = patchesFor(dir, patchedDeps, pkgName).map((p) => patchBrief(p)).filter(Boolean)

        // ④ 病历
        const history = historyFor(pkgName)
        // ④b 错误知识库：以前在这个包上踩过什么坑、怎么爬出来的。
        //     跟 history 的区别：history 是流水账（什么时候更新过、成没成），
        //     这里是「出过什么故障、根因是什么、补丁怎么修的」——防重复踩坑靠这段。
        const memCtx = memory.contextFor(pkgName)

        // ⑤ 模型判决
        const verdict = await review({
          pkg, recon: effective, dive, patches, history,
          errorPrompt: memCtx.prompt,
          usage: args?.usage ?? null,
          ask,
          tiers: tiers(),
        })

        // ⑥ 落病历（审查这一步本身也算一条：主人后来知道"审过了但没装"）
        appendHistory(pkgName, {
          kind: 'review',
          from: recon.current,
          to: toVersion,
          outcome: verdict.verdict,
          note: String(verdict.summary ?? '').slice(0, 200),
        })

        const lines = [`## 审查：${pkgName} ${recon.current} → ${toVersion}（${effective.bump}）`]
        const tag = verdict.verdict === 'install' ? '🟢 可以装' : verdict.verdict === 'hold' ? '🟠 先等等' : '⚪ 跳过'
        lines.push(`### 判决：${tag}（置信度 ${verdict.confidence ?? '?'}，用 ${verdict.tier ?? '?'} 档模型 ${verdict.model ?? '?'}）`)
        if (verdict.summary) lines.push(`\n${verdict.summary}`)

        if (verdict.features?.length) {
          lines.push('\n### 这次带来的')
          for (const f of verdict.features) lines.push(`- ${f}`)
        }
        if (verdict.risks?.length) {
          lines.push('\n### 风险')
          for (const r of verdict.risks) lines.push(`- ${r}`)
        }
        if (verdict.predictedBugs?.length) {
          lines.push('\n### 可能踩的坑')
          for (const b of verdict.predictedBugs) {
            lines.push(`- **${b.symptom ?? '?'}**`)
            if (b.why) lines.push(`  - 原因：${b.why}`)
            if (b.mitigation) lines.push(`  - 对策：${b.mitigation}`)
          }
        }
        if (patches.length > 0) {
          lines.push(`\n### 我们的补丁（${patches.length} 个）`)
          for (const p of verdict.patchPlan ?? []) {
            const act = p.action === 'replay' ? '重放' : p.action === 'rewrite' ? '重写' : p.action === 'retire' ? '退役' : p.action
            lines.push(`- ${p.patchId}：**${act}** —— ${p.reason ?? ''}`)
            if (p.rewriteHint) lines.push(`  - 怎么改：${p.rewriteHint}`)
          }
          const planned = new Set((verdict.patchPlan ?? []).map((p) => p.patchId))
          for (const p of patches) if (!planned.has(p.id)) lines.push(`- ${p.id}：模型没提（要人工看）`)
        }
        if (verdict.unlock) lines.push(`\n### 放弃的是什么\n${verdict.unlock}`)
        if (verdict.warnings?.length) {
          lines.push('\n### ⚠️ 审查过程的问题')
          for (const w of verdict.warnings) lines.push(`- ${w}`)
        }
        lines.push(`\n（证据 ${verdict.evidenceChars ?? 0} 字符；diff 概览：新增 ${dive.summary?.added ?? 0} / 删除 ${dive.summary?.removed ?? 0} / 修改 ${dive.summary?.changed ?? 0} 个文件）`)
        if (dive.error) lines.push(`⚠️ diff 没拿到：${dive.error}`)

        return ok({ report: lines.join('\n'), verdict: verdict.verdict, patchPlan: verdict.patchPlan ?? [] })
      } catch (e) {
        return fail(`审查失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 3：plugin_install_check —— 新装插件体检（主人 m00756 的硬要求）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_install_check',
    description:
      '在**装一个新插件之前**给它做体检：下 tarball、静态检查（能不能被 DSH 加载、' +
      '裸 import 是否缺失、会不会跟已装插件抢 id、有没有删文件/发凭证的危险写法），' +
      '再让模型判断"装了之后 DSH 还能不能正常用"。' +
      '**只读**：只出报告，不安装。装之前必须先跑这个（开了硬拦截的话不跑会被拦下）。',
    parameters: {
      spec: { type: 'string', required: true, description: '要装的包，例如 dsh-foo 或 dsh-foo@1.2.3' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
      askModel: { type: 'boolean', description: '要不要再让模型看一遍（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '体检失败'}`)]
        return [text(value.report ?? '体检完成')]
      },
    },
    async execute(args) {
      try {
        const spec = String(args?.spec || '').trim()
        if (!spec) return fail('必须给 spec')
        const m = /^(@?[^@]+)(?:@(.+))?$/.exec(spec)
        const pkgName = m?.[1] ?? spec
        let wantVersion = m?.[2] ?? ''

        const { dir, name: pname } = resolveProfileDir(args)

        // 没写版本 → 去 registry 查 latest
        if (!wantVersion) {
          const r = await reconPackage(cfg.registry, { name: pkgName, sourceKind: 'registry', actualVersion: null, declaredVersion: null })
          if (r.notFound) return fail(`${pkgName} 在 registry 上不存在`)
          if (!r.latest) return fail(`查不到 ${pkgName} 的版本：${r.reason}`)
          wantVersion = r.latest
        }

        const files = await fetchTarball(cfg.registry, pkgName, wantVersion, {})
        const nodeVersion = process.versions.node
        const report = staticCheck({ files, name: pkgName, version: wantVersion, profileDir: dir, nodeVersion })

        let modelVerdict = null
        if (args?.askModel !== false && report.ok) {
          const material = buildReviewMaterial({ files, report, name: pkgName, version: wantVersion })
          const res = await ask(INSTALL_SYSTEM, material, { tier: 'strong', maxTokens: 4000 })
          if (res?.ok) {
            try {
              const s = res.text
              const json = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)
              modelVerdict = JSON.parse(json)
            } catch { modelVerdict = { verdict: 'unknown', notes: `模型输出无法解析：${String(res.text).slice(0, 200)}` } }
          } else {
            modelVerdict = { verdict: 'unknown', notes: `模型不可用：${res?.error ?? '未知'}` }
          }
        }

        const lines = [`## 新装体检：${pkgName}@${wantVersion}`, renderReport(report, { name: pkgName, version: wantVersion })]
        if (modelVerdict) {
          const tag = modelVerdict.verdict === 'safe' ? '🟢 安全'
            : modelVerdict.verdict === 'caution' ? '🟡 要留神' : modelVerdict.verdict === 'dangerous' ? '🔴 会搞坏' : '❔ 判不了'
          lines.push(`\n## 模型判断：${tag}`)
          if (modelVerdict.whatItIs) lines.push(`这是什么：${modelVerdict.whatItIs}`)
          for (const r of modelVerdict.crashRisks ?? []) {
            lines.push(`- **${r.mechanism ?? '?'}**（${r.likelihood ?? '?'}）${r.evidence ? `\n  \`${r.evidence}\`` : ''}`)
          }
          if (modelVerdict.notes) lines.push(`\n备注：${modelVerdict.notes}`)
        }

        const blocked = !report.ok || modelVerdict?.verdict === 'dangerous'
        const caution = modelVerdict?.verdict === 'caution'
        lines.push(`\n## 结论\n${blocked ? '🔴 **别装**（装了会让 DSH 出问题）' : caution ? '🟡 可以装，但主人要知道上面那几条' : '🟢 可以装'}`)

        // 记下"这个 spec 体检过了"，给 tools.guard 放行用
        vetted.set(vetKey(dir, `${pkgName}@${wantVersion}`), { at: Date.now(), ok: !blocked, caution })
        vetted.set(vetKey(dir, pkgName), { at: Date.now(), ok: !blocked, caution })

        return ok({
          report: lines.join('\n'),
          ok: !blocked,
          caution,
          blockers: report.blockers,
          modelVerdict,
        })
      } catch (e) {
        return fail(`体检失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 4：plugin_patches —— 补丁账本
  // ═══════════════════════════════════════════════════════════════════════
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_patches',
    description:
      '盘点当前 profile 的**所有本地补丁**（pnpm patchedDependencies + patches/*.patch），' +
      '双向核对"登记的有没有文件""有文件有没有登记"，并显示每个补丁修的是什么问题、' +
      '什么时候可以退役。' +
      '不填 name 就是全量盘点。',
    parameters: {
      name: { type: 'string', description: '只看某个包的补丁（可选）' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
      createIntent: { type: 'boolean', description: '给缺 intent.md 的补丁建模板（默认 false，只读）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '盘点失败'}`)]
        return [text(value.report ?? '盘点完成')]
      },
    },
    async execute(args) {
      try {
        const { dir, name: pname } = resolveProfileDir(args)
        const patchedDeps = readPatchedDependencies(dir)
        let list = scanPatches(dir, patchedDeps)
        const only = String(args?.name || '').trim()
        if (only) list = list.filter((p) => p.name === only)

        const created = []
        if (args?.createIntent) {
          for (const p of list) {
            if (!p.intentPath) {
              const r = writeIntentTemplate(dir, p.key, { summary: `（${p.name} 的本地修复，待补写）` })
              if (r.created) created.push(p.key)
            }
          }
          list = scanPatches(dir, patchedDeps)
          if (only) list = list.filter((p) => p.name === only)
        }

        const lines = [`## 补丁账本（${dir}）`]
        if (list.length === 0) {
          lines.push(only ? `${only} 上没有补丁。` : '这个 profile 上没有任何本地补丁。')
        } else {
          lines.push(`共 ${list.length} 个补丁：\n`)
          for (const p of list) {
            lines.push(`### ${p.key}${p.registered ? '' : ' ⚠️ 未登记'}`)
            if (p.issue) lines.push(`修的问题：${p.issue}`)
            else if (p.intent) lines.push(`修的问题：${String(p.intent).slice(0, 160)}`)
            if (p.retireWhen) lines.push(`退役条件：${p.retireWhen}`)
            if (p.files?.length) lines.push(`改的文件：${p.files.join(', ')}`)
            if (p.stats) lines.push(`规模：+${p.stats.added} −${p.stats.removed} 行`)
            for (const i of p.issues ?? []) lines.push(`- ⚠️ ${i}`)
            for (const n of p.notes ?? []) lines.push(`- 💡 ${n}`)
            lines.push('')
          }
        }
        if (created.length > 0) lines.push(`\n已建 intent.md 模板：${created.join(', ')}（去填"修的是什么问题"）`)

        return ok({ report: lines.join('\n'), patches: list.map((p) => ({ key: p.key, registered: p.registered, issues: p.issues, notes: p.notes })) })
      } catch (e) {
        return fail(`盘点失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 5：plugin_update_trial —— 沙箱试跑（装之前先在隔离目录跑一遍）
  // ═══════════════════════════════════════════════════════════════════════
  //  🔴 主人 m01471 拍板：「要试跑，安全」。
  //     静态体检只能看出「少了个包」，看不出「apply() 里 throw」。
  //     试跑在临时目录里真装一次、真加载一次，跑完就删，不碰主人的 profile。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_update_trial',
    description:
      '在**临时目录**里试装某个插件的新版本并真的加载一次：' +
      '复制当前 profile 的依赖清单 → 换成新版本 → pnpm install → import 一遍插件入口 → 删掉临时目录。' +
      '能抓出「装不上」「装上了但加载就崩」「顶层 await 卡死」「补丁打不上」这些静态检查看不出的问题。' +
      '**不改动主人的 profile**（试跑全程在系统临时目录里）。',
    parameters: {
      name: { type: 'string', required: true, description: '包名，例如 dsh-pocket' },
      to: { type: 'string', description: '目标版本；不填就用 registry 上的 latest' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
      installTimeoutSec: { type: 'number', description: 'pnpm install 超时秒数（默认 300）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        // 失败也要把 report 给出来 —— 不然只剩一句"试跑失败"，
        // 主人看不见是哪个步骤炸的（真机上就撞到过这个哑巴输出）
        if (value?.report) return [text(value.report)]
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '试跑失败'}`)]
        return [text('试跑完成')]
      },
    },
    async execute(args) {
      try {
        const pkgName = String(args?.name || '').trim()
        if (!pkgName) return fail('必须给 name（包名）')

        const { dir, name: pname } = resolveProfileDir(args)
        const current = installedVersion(dir, pkgName)
        if (!current) return fail(`profile「${pname ?? dir}」里没装 ${pkgName}`)

        // 目标版本：没指定就去 registry 查
        let toVersion = String(args?.to || '').trim()
        if (!toVersion) {
          const r = await reconPackage(cfg.registry, { name: pkgName, sourceKind: 'registry', actualVersion: current, declaredVersion: current })
          if (!r.latest) return fail(`查不到 ${pkgName} 的版本：${r.reason}`)
          toVersion = r.latest
        }
        // 目标写成 git 引用 / tarball 地址时，试跑也得先扒出真版本，
        // 否则补丁 key 会被拼成 pnpm 认不出的 `包名@github:...`
        let targetSpec = null
        const specInfo = parseTargetSpec(toVersion)
        if (specInfo.kind !== 'version') {
          const resolved = await resolveTargetVersion({ name: pkgName, to: toVersion, registry: cfg.registry })
          // 同 runUpdate：github 简写会走 git clone（本机连不上），换成 codeload tarball 地址
          targetSpec = specInfo.kind === 'github'
            ? (resolved.tarballUrl ?? specInfo.tarballUrl ?? specInfo.spec)
            : specInfo.kind === 'tarball' ? specInfo.spec : null
          toVersion = resolved.version
        }
        if (compare(toVersion, current) === 0) {
          return ok({ report: `${pkgName} 已经是 ${current}，不用试跑。`, verdict: 'pass' })
        }

        const toolchain = findToolchain({ home: homeOf(dir) })
        const trial = await sandboxTrial({
          profileDir: dir,
          name: pkgName,
          fromVersion: current,
          toVersion,
          targetSpec,
          toolchain,
          installTimeoutMs: Math.max(30, Number(args?.installTimeoutSec) || 300) * 1000,
        })

        appendHistory(pkgName, {
          kind: 'trial', from: current, to: toVersion,
          outcome: trial.ok ? 'pass' : trial.verdict,
          note: String(trial.reason ?? '').slice(0, 200),
        })

        const lines = [`## 沙箱试跑：${pkgName} ${current} → ${toVersion}`, renderTrial(trial)]
        if (trial.verdict === 'skip') {
          lines.push('\n⚪ 试跑被跳过（找不到 node/pnpm）。这不代表有问题，只是这台机器现在没法试。静态体检的结论仍然有效。')
        } else if (!trial.ok) {
          lines.push('\n🔴 **别装** —— 这个版本在干净环境里就已经不行了，装进 profile 只会更糟。')
        } else {
          lines.push('\n🟢 试跑通过，可以进下一步（plugin_update_apply）。')
        }

        return ok({
          report: lines.join('\n'),
          verdict: trial.verdict,
          ok: trial.ok,
          steps: trial.steps,
          retargeted: trial.retargeted,
        })
      } catch (e) {
        return fail(`试跑失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 6：plugin_update_apply —— 真装 + 补丁重定位 + 失败自动回滚
  // ═══════════════════════════════════════════════════════════════════════
  //  🔴 主人 m01471 拍板：「回滚要先斩后奏 C，不能让桌面端崩了，稳定，稳定，还是tm的稳定！」
  //     所以这个工具的执行顺序是：快照 → 重定位补丁 → 装 → 验 → 坏了当场退回去。
  //     退回去不等主人确认 —— 等确认的这几分钟里 DSH 就是坏的。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_update_apply',
    description:
      '**真的**更新一个插件到新版本。流程：先备份当前状态 → 把我们的补丁从旧版本迁到新版本 → ' +
      'pnpm install → 装完立刻加载验证 → 任何一步失败就**自动回滚**到原样（先斩后奏，不等确认）。' +
      '默认会先跑一次沙箱试跑；试跑不过直接拒绝，不动主人的 profile。' +
      '⚠️ 这是会改磁盘的操作。没把握时先调 plugin_update_review 和 plugin_update_trial。',
    parameters: {
      name: { type: 'string', required: true, description: '包名' },
      to: { type: 'string', description: '目标版本；不填就用 registry 上的 latest' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
      skipTrial: { type: 'boolean', description: '跳过沙箱试跑直接装（不推荐，除非已经单独试跑过）' },
      skipVerify: { type: 'boolean', description: '装完不做加载验证（**强烈不推荐**，这是最后一道闸）' },
      installTimeoutSec: { type: 'number', description: 'pnpm install 超时秒数（默认 600）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value) return [text('✗ 没有结果')]
        return [text(value.report ?? (value.ok ? '完成' : value.message ?? '失败'))]
      },
    },
    async execute(args) {
      try {
        const pkgName = String(args?.name || '').trim()
        if (!pkgName) return fail('必须给 name（包名）')

        const { dir } = resolveProfileDir(args)
        const r = await runUpdate({
          dir,
          pkgName,
          toVersion: args?.to,
          skipTrial: args?.skipTrial === true,
          skipVerify: args?.skipVerify === true,
          installTimeoutSec: args?.installTimeoutSec,
        })
        if (r.fatal) return fail(r.report)
        if (r.aborted) return fail(`让位了：${r.reason}`)
        return ok({
          report: r.report,
          ok: r.ok,
          result: r.result,
          reason: r.reason,
          fromVersion: r.fromVersion,
          toVersion: r.toVersion,
          snapshot: r.snapshot ?? null,
          trial: r.trial ?? null,
          steps: r.steps,
        })
      } catch (e) {
        return fail(`更新失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  工具 7：plugin_update_rollback —— 事后后悔药（手动退回某个备份）
  // ═══════════════════════════════════════════════════════════════════════
  //  ⚠️ 自动回滚只在「装的时候当场发现坏了」有用。
  //     更多时候是**用了两天才发现**某功能不对 —— 那时候需要手动退。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_update_rollback',
    description:
      '把某个包退回之前的版本。不填 backup 就用最近一次成功更新前的备份（也就是撤销上一次更新）。' +
      '整个过程同样有验证：退完会再加载一次，退不回去就告诉你，不会把 profile 留在半坏状态。',
    parameters: {
      name: { type: 'string', required: true, description: '包名' },
      backup: { type: 'string', description: '指定备份目录（不填 = 最近一次）' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '回滚失败'}`)]
        return [text(value.report ?? '回滚完成')]
      },
    },
    async execute(args) {
      try {
        const pkgName = String(args?.name || '').trim()
        if (!pkgName) return fail('必须给 name（包名）')
        const { dir } = resolveProfileDir(args)

        const backups = listBackups(dir, pkgName)
        if (backups.length === 0) {
          return fail(`${pkgName} 没有任何备份可退。`)
        }
        const target = String(args?.backup || '').trim() || backups[0].root
        const snap = backups.find((b) => b.root === target)
        if (!snap) return fail(`找不到备份：${target}（现有 ${backups.length} 个）`)

        const rb = await rollback(dir, snap, { name: pkgName, toolchain: findToolchain() })
        const now = installedVersion(dir, pkgName)

        const lines = [`## 回滚：${pkgName}`]
        lines.push(`用的备份：${snap.root}（${snap.stamp}）`)
        for (const s of rb.steps ?? []) lines.push(`  ${s.ok ? '✓' : '✗'} ${s.step}${s.detail ? `：${s.detail}` : ''}`)
        lines.push(rb.ok ? `\n↩️ 已退回，现在版本是 **${now ?? '未知'}**。重启 DSH 后生效。` : `\n🔴 回滚没走完：${rb.reason}`)

        appendHistory(pkgName, {
          kind: 'rollback', to: now ?? null,
          outcome: rb.ok ? 'rolled-back' : 'rollback-failed',
          note: String(rb.reason ?? '').slice(0, 200),
          snapshot: snap.root,
        })

        return ok({ report: lines.join('\n'), ok: rb.ok, version: now, backup: snap.root })
      } catch (e) {
        return fail(`回滚失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  P4：空闲编排 + 后台队列 + 带兜底的重启
  // ═══════════════════════════════════════════════════════════════════════
  //  主人 m02199：「留到P4吧」（后台队列）
  //  主人 m01949：「可以后台跑完再通知，不能因为浪费时间就不跑」
  //  主人 m01471：「稳定，稳定，还是tm的稳定！」
  //
  //  三件事的关系：
  //    ① 空闲判定（lib/idle.js）—— 主人在用就一个字都不许动；
  //    ② 后台队列（lib/queue.js）—— 排着，等安静了自己跑，失败最多重试 3 次；
  //    ③ 重启（lib/restart.js）—— 装完要让新版本生效，但绝不能「只杀不拉」。
  const plog = (m) => { try { logSink?.(typeof m === 'string' ? m : JSON.stringify(m)) } catch { /* ignore */ } }

  // 🔴 probeBusy 是必须的兜底：agent/status 只在状态变化时发声，
  //    插件重载那一刻正在跑的会话不会补发 running（实测出现过「0 个已知会话」，
  //    而主人其实正在干活）。会话最后一条事件是宿主自己写的事实，不会骗人。
  const idleTracker = createIdleTracker({
    quietMs: Math.max(5_000, Number(cfg.idleQuietMs) || DEFAULT_QUIET_MS),
    probeBusy: () => {
      try {
        return scanBusySessions(ctx.get('sessions')).map((s) => s.id)
      } catch { return [] }
    },
  })
  // 🔴 接事件这件事必须**失败也活着**：宿主没有 on / 事件名不在目录里，
  //    都不能让整个插件装不上（装了之后工具全没有，比没有这个功能糟得多）。
  try {
    ctx.effect(() => attachIdle(idleTracker, (ev, fn) => {
      if (typeof ctx.on !== 'function') return () => {}
      return ctx.on(ev, fn)
    }))
  } catch (e) {
    plog(`[idle] 接不上宿主事件（空闲判定会退化成「永远不敢动」）：${e?.message ?? e}`)
  }

  // 队列落在「当前 profile 目录」下，跟补丁账本同一个地方
  let pumpDir = ''
  try { pumpDir = resolveProfileDir({}).dir } catch { pumpDir = cfg.profileDir || '' }

  // ───────────────────────────────────────────────────────────────────────
  //  队列里也必须先审查再装
  // ───────────────────────────────────────────────────────────────────────
  //  🔴 为什么（2026-10-23，主人说「让他自己触发」）：
  //    后台队列原来只跑「试跑 → 真装 → 验证」，**跳过了模型审查那一步**。
  //    可主人要的核心从来不是「无脑装最新」，而是「模型先替她判：这次更新要不要、
  //    会踩什么坑、我们的补丁怎么打」。排队等于把把关权交回去，那这条队列就退化成
  //    了普通的「一键更新」——正是这个插件存在的理由的反面。
  //    ⚠️ 审查失败（模型超时 / 判不出来）一律按「先等等」处理，绝不静默放行
  //       —— 静默放行是 2026-10-22 修过的 bug（m00756）。
  async function reviewFor({ dir, pkgName, toVersion }) {
    try {
      const pkgs = scanProfile(dir)
      const pkg = pkgs.find((p) => p.name === pkgName)
      if (!pkg) return { verdict: 'skip', summary: `profile 里没装 ${pkgName}` }
      const recon = await reconPackage(cfg.registry, pkg, { includePrerelease: cfg.includePrerelease })
      if (!recon.current || !recon.latest) return { verdict: 'hold', summary: `侦察不完整：${recon.reason ?? ''}` }
      const to = String(toVersion || recon.latest).trim()
      if (compare(to, recon.current) <= 0) return { verdict: 'skip', summary: `已经是最新（${recon.current}）` }
      const effective = { ...recon, latest: to, bump: bumpType(recon.current, to) }
      const dive = await deepDive(cfg.registry, pkgName, recon.current, to, {})
      const patchedDeps = readPatchedDependencies(dir)
      const patches = patchesFor(dir, patchedDeps, pkgName).map((p) => patchBrief(p)).filter(Boolean)
      const history = historyFor(pkgName)
      const memCtx = memory.contextFor(pkgName)
      const v = await review({
        pkg, recon: effective, dive, patches, history,
        errorPrompt: memCtx.prompt,
        usage: null,
        ask,
        tiers: tiers(),
      })
      appendHistory(pkgName, {
        kind: 'review',
        from: recon.current,
        to,
        outcome: v.verdict,
        note: String(v.summary ?? '').slice(0, 200),
      })
      return v
    } catch (e) {
      return { verdict: 'hold', summary: `审查过程出错：${e?.message ?? e}` }
    }
  }

  const pump = createPump({
    dir: pumpDir || process.cwd(),
    idle: idleTracker,
    enabled: () => cfg.queueEnabled !== false,
    log: (e) => plog(`[queue] ${JSON.stringify(e).slice(0, 300)}`),
    runJob: async (job, { shouldAbort }) => {
      const dir = String(job?.dir || pumpDir || '').trim()
      if (!dir) throw new Error('队列任务没记 profile 目录')

      // ① 先审查：模型判决「装 / 先等等 / 跳过」。排队 ≠ 放弃把关。
      const v = await reviewFor({ dir, pkgName: String(job.name || ''), toVersion: job.to || '' })
      if (v && v.verdict !== 'install') {
        const tag = v.verdict === 'skip' ? '⚪ 跳过' : '🟠 先等等'
        return {
          ok: false,
          result: 'refused',
          report: `## 审查判决：${tag}（${job.name} ${job.to || ''}）\n\n${v.summary ?? ''}\n\n（**没有装**。要强装就手动调 \`plugin_update_apply\`。）`,
        }
      }

      const r = await runUpdate({
        dir,
        pkgName: String(job.name || ''),
        toVersion: job.to || '',
        skipTrial: false, // 🔴 队列里跑的也必须试跑：这正是「浪费时间也要跑」的那件事
        skipVerify: false,
        shouldAbort,
      })
      if (r.aborted) return { aborted: true, reason: r.reason }
      if (r.fatal) throw new Error(r.report)

      // 装成功了、设置又允许，就顺手把它重启掉（重启本身有重试兜底）
      if (r.ok && r.result === APPLY_RESULT.APPLIED && cfg.restartAfterApply === 'auto') {
        try {
          const tc = findToolchain({ home: homeOf(dir) })
          const rr = restartSelf({ dir, node: tc.node, appExe: cfg.appExe || undefined, env: tc.env })
          plog(`[queue] 装完自动重启：${rr.ok ? '已交给帮手' : `没成（${rr.reason}）`}`)
        } catch (e) { plog(`[queue] 自动重启异常：${e?.message ?? e}`) }
      }
      return { ok: r.ok, result: r.result, report: r.report }
    },
  })

  ctx.effect(() => {
    pump.start({ intervalMs: cfg.queueIntervalMs })
    return () => pump.stop()
  })

  // ───────────────────────────────────────────────────────────────────────
  //  市场哨兵：主人自己点「插件市场 → 全部更新」时，把命保住
  // ───────────────────────────────────────────────────────────────────────
  //  🔴 由来（2026-10-22 晚上，主人真机上踩到）：
  //     她在插件市场点了「全部更新」，dsh-fish-memory 装失败，横幅写着
  //     「更新前的构建未能验证恢复（{"code":"ambiguous-install"}）」。
  //     —— 那条路是 `点按钮 → dshmarket 自己跑 pnpm → 宿主包操作`，
  //     **一次工具调用都没有**，所以我们的硬拦截（挂在 ctx.tools.guard 上）压根没份。
  //     市场是我们管不到的路，唯一能做的是「事后第一时间发现 + 当场说清楚 + 记进病历」。
  //     注意分寸：只观察 + 记录 + 提示，**绝不主动改任何东西**（那条路已经够危险了）。
  let sentinel = null
  try {
    if (cfgBool(cfg.sentinel, true) && pumpDir) {
      sentinel = createSentinel({
        dir: pumpDir,
        debounceMs: Math.max(500, Number(cfg.sentinelDebounceMs) || 2500),
        log: (m) => plog(`[sentinel] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
      })
      // 基线不只在内存里：市场更新常把 DSH 一起重启，进程一换内存就空了。
      // resume() 会接上「上次运行留下的基线」，所以「装完就崩 / 装完就重启」那种
      // 最要命的变动也跑不掉。

      const noteIssue = (issue) => {
        // 病历：同一个标题已经记过就不再记（避免一次失败刷出十条一样的病历）
        try {
          const title = `市场更新踩坑：${issue.title}`
          const known = (memory.listErrors?.() ?? []).some((d) => String(d?.title ?? '').includes(issue.title))
          if (!known) {
            memory.saveError(buildErrorDoc({
              title,
              severity: issue.severity === 'high' ? 'high' : 'medium',
              symptoms: [`插件市场里更新时出现：${issue.title}`],
              packages: issue.packages?.length ? issue.packages : ['（市场整批更新，未定位到具体包）'],
              body: [
                '## 出处',
                '这条是「市场哨兵」自动记的：主人在插件市场点了更新，pnpm 输出里出现了这个坑。',
                '',
                '## 当时的输出',
                '```',
                String(issue.sample ?? '').slice(0, 1200),
                '```',
                '',
                '## 怎么处理',
                '1. 先看这句提示里的包名，跑 `plugin_update_review` 搞清楚这个版本改了什么；',
                '2. 如果是补丁 key 没跟上新版本：补丁不会自动重放，得先 retarget 再装（`plugin_update_apply` 会自己带 `--config.patchedDependencies`）；',
                '3. 如果是 `ambiguous-install`：说明装没装成没法确认，**先别动它**，用 `plugin_drift` 看 profile 实际变成了什么样。',
              ].join('\n'),
            }))
            plog(`[sentinel] 记了一条病历：${title}`)
          }
        } catch (e) { plog(`[sentinel] 写病历失败：${e?.message ?? e}`) }
      }

      const noteDiff = ({ diff, trigger }) => {
        try {
          plog(`[sentinel] 市场那边动了 profile（${trigger}）：${renderDiff(diff).slice(0, 400)}`)
          // 补丁登记/文件消失是最高优先级 —— 这正是「天天上当」的那种事故
          const lost = [...(diff?.patches?.registeredRemoved ?? []), ...(diff?.patches?.filesRemoved ?? [])]
          if (lost.length > 0) {
            noteIssue({
              id: 'patch-lost',
              title: '打完补丁后补丁登记/文件消失了',
              severity: 'high',
              packages: lost.map((k) => packageFromPatchKey(k)).filter(Boolean),
              sample: `消失的补丁：${lost.join('、')}；变化摘要：${renderDiff(diff)}`,
            })
          }
          for (const v of diff?.versionChanged ?? []) {
            // 市场装的版本，记进更新档案但标明来路：主人自己点的，不是管家装的
            appendHistory(v.name, {
              kind: 'market',
              from: v.from ?? '',
              to: v.to ?? '',
              outcome: 'market-installed',
              note: v.specOnly ? '只有声明的源变了，版本号没动' : '主人自己在插件市场点的更新',
            })
          }
        } catch (e) { plog(`[sentinel] 处理 diff 失败：${e?.message ?? e}`) }
      }

      // 接上「上次运行留下的基线」：装完就崩 / 装完就重启那种变动也跑不掉
      try {
        const boot = sentinel.resume()
        if (boot?.diff?.changed) {
          plog(`[sentinel] 上次运行期间市场动过 profile（基线 ${boot.sinceWhen ?? '未知'}）`)
          noteDiff({ diff: boot.diff, trigger: `上次运行（基线 ${boot.sinceWhen ?? '未知'}）` })
        }
      } catch (e) {
        plog(`[sentinel] 续基线失败（当第一次跑）：${e?.message ?? e}`)
        try { sentinel.snapshot() } catch { /* ignore */ }
      }

      ctx.effect(() => attachSentinel(sentinel, {
        on: (ev, fn) => {
          if (typeof ctx.on !== 'function') return () => {}
          return ctx.on(ev, fn)
        },
        onDiff: noteDiff,
        onLogIssue: noteIssue,
        log: plog,
      }))
    }
  } catch (e) {
    // 哨兵坏了不许影响插件本身：它只是个「看见了就说」的观察者
    plog(`[sentinel] 启动失败（不影响其它功能）：${e?.message ?? e}`)
    sentinel = null
  }

  // ───────────────────────────────────────────────────────────────────────
  //  工具 8：plugin_queue —— 排着，等空闲了自己跑
  // ───────────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_queue',
    description:
      '后台更新队列：把「要更新哪个包」排进去，等**没有任何会话在跑、且安静够久**时自己执行' +
      '（试跑 → 真装 → 加载验证 → 失败自动回滚）。' +
      'action=list 看队列；add 排一个；remove 撤销一个；clear 清空；tick 立刻试着跑一次（仍要先满足空闲）。' +
      '⚠️ 排进队列不等于立刻动手 —— 主人在用时它会一直等。',
    parameters: {
      action: { type: 'string', description: 'list / add / remove / clear / tick（默认 list）' },
      name: { type: 'string', description: 'add 时要更新的包名' },
      to: { type: 'string', description: 'add 时的目标版本（不填用 latest）' },
      note: { type: 'string', description: 'add 时的备注' },
      id: { type: 'string', description: 'remove 时的任务 id' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        return [text(value?.report ?? (value?.ok === false ? `✗ ${value?.message ?? '失败'}` : '完成'))]
      },
    },
    async execute(args) {
      try {
        const action = String(args?.action || 'list').toLowerCase()
        const { dir } = resolveProfileDir(args)

        if (action === 'add') {
          const name = String(args?.name || '').trim()
          if (!name) return fail('add 必须给 name（包名）')
          const { job, duplicated } = addJob(dir, { name, to: String(args?.to || '').trim() || null, note: String(args?.note || '') })
          const snap = idleTracker.snapshot()
          return ok({
            report: [
              duplicated ? `⚠️ 已经在队列里了（${job.id}），没重复排。` : `✅ 已排队：${name}${job.to ? ` → ${job.to}` : ''}（${job.id}）`,
              `　排在 ${dir}`,
              `　当前${snap.idle ? '空闲，下一轮就会动手' : `还不能动手：${snap.reason}`}`,
              '',
              renderQueue(readQueue(dir)),
            ].join('\n'),
            job,
          })
        }

        if (action === 'remove') {
          const id = String(args?.id || '').trim()
          if (!id) return fail('remove 必须给 id')
          const r = removeJob(dir, id)
          return ok({ report: `删掉 ${r.removed} 个任务。\n\n${renderQueue(r.queue)}`, removed: r.removed })
        }

        if (action === 'clear') {
          const r = clearQueue(dir)
          return ok({ report: `清空队列，删掉 ${r.removed} 个任务（正在跑的不动）。` })
        }

        if (action === 'tick') {
          const r = await pump.tick()
          const snap = idleTracker.snapshot()
          const tail2 = r.skipped ? `没动手：${r.skipped}` : r.aborted ? `让位了：${r.reason}` : r.ok ? '跑完了一个' : `失败了：${r.error}`
          return ok({ report: `本轮：${tail2}\n\n${renderQueue(readQueue(dir))}`, result: r, idle: snap })
        }

        const q = readQueue(dir)
        const snap = idleTracker.snapshot()
        return ok({
          report: [
            renderQueue(q),
            '',
            `空闲判定：${snap.idle ? '✅ 现在可以动手' : `⏸ ${snap.reason}`}`,
            `已知状态会话 ${snap.known} 个；安静了 ${Math.round(snap.quietMs / 1000)}s / 需要 ${Math.round(snap.needQuietMs / 1000)}s`,
            `后台泵：${cfg.queueEnabled === false ? '关着' : `开着，每 ${Math.round((cfg.queueIntervalMs || 60000) / 1000)}s 看一次`}`,
          ].join('\n'),
          queue: q,
          idle: snap,
        })
      } catch (e) {
        return fail(`队列操作失败：${e?.message ?? e}`)
      }
    },
  })))

  // ───────────────────────────────────────────────────────────────────────
  //  工具 9：plugin_drift —— 市场哨兵（主人自己点市场更新时，事后第一时间说清楚）
  // ───────────────────────────────────────────────────────────────────────
  //  这不是「又一个扫描」：扫的是**我们没碰过的那条路**造成的实际后果。
  //  主人原话：「那些插件更新还在自己更新，刚刚又弹出来 dsh-fish-memory 更新失败」
  //  —— 市场是它自己的更新流程，我们拦不住；能保证的是「它出事之后，这里马上给出
  //  『谁动了、动了什么、补丁还在不在、该不该慌』」，而不是等人自己发现 DSH 坏了。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_drift',
    description:
      '市场哨兵：看看**插件市场自己那个更新流程**把 profile 改成了什么样。' +
      '它会对比「上次记下的样子」和「现在磁盘上的样子」，报出：哪些包被换了版本、' +
      '哪些补丁的登记/文件消失了、以及最近市场安装时 pnpm 报过的坑（补丁没用上、' +
      'ambiguous-install、lockfile 冲突…）。' +
      'action=status 看现状；check 立刻对比一次并刷新基线；history 看最近的变动流水。' +
      '⚠️ 它只观察、只记录，**不会主动改任何东西**——市场那条路已经够危险，别再加上我们。',
    parameters: {
      action: { type: 'string', description: 'status / check / history（默认 status）' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '哨兵没看成'}`)]
        return [text(value.report ?? '')]
      },
    },
    async execute(args) {
      try {
        const action = String(args?.action || 'status').toLowerCase()
        let dir = pumpDir
        try { dir = resolveProfileDir(args).dir } catch { /* 用启动时那个 */ }
        if (!dir) return fail('不知道该看哪个 profile 目录（没传 profileDir，也没能自动推断）')

        if (!sentinel) {
          return ok({
            report: [
              '## 市场哨兵',
              '哨兵没开（配置 `sentinel` 关着，或者启动时接不上宿主事件）。',
              '开了之后它会自己盯着；也可以直接看 `plugin_patches` 和更新档案。',
            ].join('\n'),
            enabled: false,
          })
        }

        if (action === 'check') {
          const { sentinel: fresh, diff } = (() => {
            try { sentinel.check({ reason: 'manual' }) } catch { /* ignore */ }
            return { sentinel, diff: sentinel.state().lastDiff }
          })()
          void fresh
          return ok({
            report: ['## 立刻对比了一次', renderDiff(diff ?? { changed: false })].join('\n'),
            diff: diff ?? null,
          })
        }

        if (action === 'history') {
          const st = sentinel.state()
          const lines = ['## 哨兵看到的变动流水', `看守目录：\`${st.dir}\``, '']
          const evs = (st.events ?? []).slice().reverse()
          if (evs.length === 0) lines.push('还没有记录任何变动 —— 说明市场那边一直没动过（或者哨兵是刚开的）。')
          else for (const e of evs) {
            const at = String(e.at ?? '').replace('T', ' ').slice(0, 19)
            if (e.kind === 'log-issue') lines.push(`- ${at} 🧯 ${e.title}${e.detail ? `（${e.detail}）` : ''}`)
            else if (e.kind === 'profile-change') lines.push(`- ${at} 🔄 profile 变了（${e.reason}）`)
            else lines.push(`- ${at} ${e.kind}`)
          }
          return ok({ report: lines.join('\n'), events: st.events ?? [] })
        }

        // status：现状 + 最近一次对比 + 最近拦到的问题
        const lines = [sentinel.summary()]
        const snap = sentinel.state()
        if (snap.lastDiff && snap.lastDiff.changed) {
          lines.push('', '### 要不要慌？')
          const lost = [...(snap.lastDiff?.patches?.registeredRemoved ?? []), ...(snap.lastDiff?.patches?.filesRemoved ?? [])]
          if (lost.length > 0) {
            lines.push(`⚠️ 有补丁没了（${lost.join('、')}）—— 这是最要紧的一种：要么补丁没重放上，要么登记被抹了。`)
            lines.push('下一步：`plugin_patches` 看账本，`plugin_update_review` 看那个包这版改了什么，别自己手改 node_modules。')
          } else if ((snap.lastDiff?.versionChanged ?? []).length > 0) {
            lines.push('版本确实被市场换掉了，但补丁都还在。想确认「装得对不对」就跑 `plugin_update_trial` 再试装一次。')
          } else {
            lines.push('没有威胁到补丁的变化。')
          }
        } else if (snap.lastDiff) {
          lines.push('', '上次对比：没有任何变化。')
        }
        return ok({ report: lines.join('\n'), state: snap })
      } catch (e) {
        return fail(`哨兵出错：${e?.message ?? e}`)
      }
    },
  })))

  // ───────────────────────────────────────────────────────────────────────
  //  工具 10：plugin_restart —— 安全重启（带拉起失败兜底）
  // ───────────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_restart',
    description:
      '安全重启 DSH：先起一个**独立帮手**，再让当前进程退出；帮手会盯着新进程起来、探活、' +
      `连续稳定 ${Math.round(BOOT_SETTLE_MS / 1000)} 秒才算成功，起不来会再拉（最多 ${RESTART_TRIES} 次），` +
      '全失败就写日志并明确告诉你手动开。' +
      '⚠️ 会中断当前对话（结果会先返回，约 1 秒后才真的退）。必须 confirm: true。',
    parameters: {
      confirm: { type: 'boolean', description: '必须显式传 true —— 这是会中断对话的操作' },
      reason: { type: 'string', description: '为什么要重启（会写进日志）' },
      profile: { type: 'string', description: 'profile 名' },
      profileDir: { type: 'string', description: 'profile 目录绝对路径（优先）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        return [text(value?.report ?? (value?.ok === false ? `✗ ${value?.message ?? '失败'}` : '完成'))]
      },
    },
    async execute(args) {
      try {
        if (args?.confirm !== true) {
          // 只看不干：把真要执行时的计划摊开，主人（和模型）先判断靠不靠谱
          let plan
          try { plan = planRestart({ appExe: cfg.appExe || undefined }) } catch (e) { plan = { strategy: 'unknown', error: String(e?.message ?? e) } }
          let electronOk = false
          try { electronOk = !!getElectronApp() } catch { electronOk = false }
          const lines = [
            '## 重启计划（什么都还没做）',
            '- 策略：' + (plan.strategy === 'electron-relaunch' ? 'Electron 自带的 relaunch（最稳）' : '帮手杀旧进程再拉起'),
            '- Electron relaunch 可用：' + (electronOk ? '是' : '否（会走帮手杀+拉）'),
            '- 目标：' + (plan.appExe ?? '（没认出来，需要配 appExe）'),
            '- 成功判据：新进程起来 + HTTP 能响应 + 连续稳定 ' + Math.round(BOOT_SETTLE_MS / 1000) + ' 秒',
            '- 起不来自动重拉，最多 ' + RESTART_TRIES + ' 次；全失败会写日志并提示手动开',
            '',
            '⚠️ 真做的话会中断当前对话（约 1 秒后进程退出）。确认要重启就带 `confirm: true` 再调一次。',
          ]
          return fail('需要 confirm: true', { report: lines.join('\n'), plan, electronOk })
        }
        const { dir } = resolveProfileDir(args)
        const tc = findToolchain({ home: homeOf(dir) })

        // 拿不到 Electron 的 app 对象就退回「杀+拉」，两条路都有重试。
        // ⚠️ 必须走 CJS 的 require('electron')：ESM import 会去 node_modules 找真包而失败。
        const electronApp = getElectronApp()
        const hasElectron = !!electronApp

        const r = restartSelf({
          dir,
          node: tc.node,
          appExe: cfg.appExe || undefined,
          hasElectron,
          electronApp,
          env: tc.env,
          log: (m) => plog(`[restart] ${m}`),
        })
        if (!r.ok) return fail(r.reason ?? '重启没安排上', { plan: r.plan })

        return ok({
          report: [
            `## 准备重启${args?.reason ? `（${args.reason}）` : ''}`,
            `- 策略：${r.plan.strategy === 'electron-relaunch' ? 'Electron 自带的 relaunch（最稳）' : '帮手杀旧进程再拉起'}`,
            `- 目标：${r.plan.appExe}`,
            `- 帮手 PID：${r.helperPid}`,
            `- 成功判据：新进程起来 + HTTP 能响应 + 连续稳定 ${Math.round(r.settleMs / 1000)} 秒`,
            `- 起不来自动重拉，最多 ${RESTART_TRIES} 次；全失败会写日志`,
            `- 日志：${r.logFile}`,
            `- 结果：${r.resultFile}`,
            '',
            '约 1 秒后退出。回来后看一眼设置页的「更新记录」就能知道这次成没成。',
          ].join('\n'),
          ...r,
        })
      } catch (e) {
        return fail(`重启失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  记忆双库：更新档案 + 错误知识库
  // ═══════════════════════════════════════════════════════════════════════
  //  主人原话（m00002）：「需要记忆功能，我更新了什么？我修复了什么？」
  //  主人原话（m00144）：错误日志也要入库 —— 出过什么事、怎么修的，下次别再来一遍。
  //
  //  为什么要暴露成工具而不是偷偷读写：
  //    模型在审查时只能看到「系统自动记下的东西」。但很多坑是主人当时口述的、
  //    或者是我在会话里诊断出来的 —— 那些结论只有模型自己知道。给它一个写入口，
  //    它才能把「这次踩的坑」变成「下次的免疫力」。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_memory',
    description:
      '读写 dsh-update-guard 的记忆双库：\n' +
      '  · **更新档案**（ledger）：谁在什么时候从什么版本更新到什么版本、判了什么、成没成、回滚了没有。\n' +
      '  · **错误知识库**（errors）：出过什么故障、症状是什么、根因是什么、怎么修的、涉及哪些版本。\n\n' +
      'action=stats 看全局统计；action=history 查某个包的更新流水；\n' +
      'action=errors 查错误知识库（可按包名/关键词）；action=record_error 记一条新病历。\n' +
      '审查模型会自动读到这些记忆 —— 记进去的东西，下次更新时它就知道要防什么。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['stats', 'history', 'errors', 'record_error'],
        description: 'stats=统计；history=更新流水；errors=查病历；record_error=写病历',
      },
      name: { type: 'string', description: '包名（history / errors / record_error 用）' },
      keywords: {
        type: 'array', items: { type: 'string' },
        description: '检索关键词（errors 用，可选）',
      },
      limit: { type: 'number', description: '最多返回几条（默认 20）' },
      // record_error 专用
      title: { type: 'string', description: 'record_error：一句话标题，比如「pocket 反代 401 永久掉线」' },
      symptoms: {
        type: 'array', items: { type: 'string' },
        description: 'record_error：症状（看到什么现象）',
      },
      packages: {
        type: 'array', items: { type: 'string' },
        description: 'record_error：涉及哪些包（不填就用 name）',
      },
      severity: {
        type: 'string', enum: ['low', 'medium', 'high', 'critical'],
        description: 'record_error：严重程度（默认 medium）',
      },
      body: { type: 'string', description: 'record_error：根因 + 怎么修的（Markdown）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [text(`✗ ${value?.message ?? '记忆操作失败'}`)]
        return [text(value.report ?? '完成')]
      },
    },
    async execute(args) {
      try {
        const action = String(args?.action || 'stats')
        const limit = Number(args?.limit) > 0 ? Math.min(Number(args.limit), 200) : 20

        if (action === 'stats') {
          const st = memory.stats()
          const docs = memory.listErrors()
          const lines = ['## 记忆双库']
          lines.push(`记忆位置：\`${stateDir}\``)
          lines.push(`\n### 更新档案（${st.total} 条）`)
          if (st.total === 0) {
            lines.push('还是空的 —— 第一次更新成功后就会有记录。')
          } else {
            const by = st.byResult ?? {}
            // 🔴 三分类，别把「过程记录」当失败：
            //    审查判决（install）、试跑通过（pass）、环境不满足（skip/noop）
            //    都只是流水账的中间态，统计成「出问题」会让主人误以为满盘皆输。
            const GOOD = ['applied', 'ok']
            const BAD = ['rolled-back', 'rollback-failed', 'refused', 'blocked', 'trial-failed', 'failed']
            const sum = (keys) => Object.entries(by).filter(([k]) => keys.includes(k)).reduce((n, [, v]) => n + v, 0)
            const bad = sum(BAD)
            lines.push(`涉及 ${st.packages} 个包；成功 ${sum(GOOD)} 次，`
              + `出问题 ${bad} 次，回滚 ${(by['rolled-back'] ?? 0) + (by['rollback-failed'] ?? 0)} 次。`)
            if (st.firstAt) lines.push(`最早：${String(st.firstAt).slice(0, 10)}　最近：${String(st.lastAt).slice(0, 10)}`)

            // 最容易出事的包 —— 这是主人最想一眼看到的
            const rows = memory.read({ limit: 500 })
            const tally = new Map()
            for (const r of rows) {
              if (!r.name) continue
              if (!BAD.includes(String(r.result ?? ''))) continue
              tally.set(r.name, (tally.get(r.name) ?? 0) + 1)
            }
            const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
            if (top.length) {
              lines.push('\n最容易出事的包：')
              for (const [n, c] of top) lines.push(`- ${n}：${c} 次`)
            }
          }
          lines.push(`\n### 错误知识库（${docs.length} 份病历）`)
          if (docs.length === 0) {
            lines.push('还没有病历。踩了坑之后用 `action=record_error` 记下来，下次审查会自动带上。')
          } else {
            for (const d of docs.slice(0, 10)) {
              const meta = d.meta ?? {}
              const n = Number(meta.occurrences ?? 1)
              lines.push(`- **${meta.title ?? d.filename}**（${meta.severity ?? '?'}，`
                + `${String(meta.createdAt ?? '').slice(0, 10)}${n > 1 ? `，踩过 ${n} 次` : ''}）`
                + (meta.packages?.length ? `　涉及：${meta.packages.join(', ')}` : ''))
            }
            if (docs.length > 10) lines.push(`…还有 ${docs.length - 10} 份`)
          }
          return ok({ report: lines.join('\n'), total: st.total, errors: docs.length })
        }

        if (action === 'history') {
          const name = String(args?.name || '').trim()
          const rows = name
            ? historyFor(name).slice(0, limit)
            : memory.read({ limit })
          const lines = [`## 更新档案${name ? `：${name}` : ''}（最近 ${rows.length} 条）`]
          if (rows.length === 0) {
            lines.push('没有记录。')
          } else {
            for (const r of rows) {
              const when = r.at ? String(r.at).replace('T', ' ').slice(0, 16) : '未知时间'
              const who = r.name ?? name
              const ver = r.from || r.to ? `${r.from ?? '?'} → ${r.to ?? '?'}` : ''
              const res = r.result ?? r.outcome ?? '?'
              // 🔴 别把所有「没装上」都画成 ✗：
              //    「审查说该装」「试跑通过」「环境不满足跳过」都不是失败，
              //    画成红叉会让主人以为整天在翻车（真机上第一次看就误会了）。
              const MARK = {
                applied: '✓', ok: '✓',
                'rolled-back': '↩',
                refused: '🛑', blocked: '🛑',
                pass: '🟢', install: '🟢',
                skip: '⚪', noop: '·',
                'trial-failed': '⚠️',
              }
              const mark = MARK[res] ?? '·'
              lines.push(`- ${mark} ${when}　**${who}**　${ver}　${res}`
                + (r.reason ? `　（${String(r.reason).slice(0, 120)}）` : ''))
            }
          }
          return ok({ report: lines.join('\n'), count: rows.length })
        }

        if (action === 'errors') {
          const name = String(args?.name || '').trim()
          const kws = Array.isArray(args?.keywords) ? args.keywords.map(String) : []
          const docs = (name || kws.length)
            ? memory.searchErrors({ name, keywords: kws, limit })
            : memory.listErrors().slice(0, limit)
          const lines = ['## 错误知识库']
          if (docs.length === 0) {
            lines.push('没查到相关病历。')
          } else {
            for (const d of docs) {
              const meta = d.meta ?? {}
              lines.push(`\n### ${meta.title ?? d.filename}（${meta.severity ?? '?'}）`)
              if (meta.createdAt) lines.push(`记录于 ${String(meta.createdAt).slice(0, 10)}`)
              if (meta.packages?.length) lines.push(`涉及：${meta.packages.join(', ')}`)
              if (meta.symptoms?.length) {
                lines.push('症状：')
                for (const s of meta.symptoms) lines.push(`- ${s}`)
              }
              if (d.body) lines.push(`\n${d.body}`)
            }
          }
          return ok({ report: lines.join('\n'), count: docs.length })
        }

        if (action === 'record_error') {
          const title = String(args?.title || '').trim()
          if (!title) return fail('record_error 需要 title（一句话说清这个坑是什么）')
          const pkgs = Array.isArray(args?.packages) && args.packages.length
            ? args.packages.map(String)
            : (args?.name ? [String(args.name)] : [])
          const doc = buildErrorDoc({
            title,
            packages: pkgs,
            symptoms: Array.isArray(args?.symptoms) ? args.symptoms.map(String) : [],
            severity: String(args?.severity || 'medium'),
            body: String(args?.body || ''),
          })
          const r = memory.saveError(doc)
          if (!r.ok) return fail(`病历没写进去：${r.error}`)
          return ok({
            report: `## 已记入错误知识库\n\n**${title}**（${doc.severity}）\n文件：\`${r.file}\`\n\n`
              + '下次审查这个包时，模型会自动看到这条病历。',
            path: r.file,
          })
        }

        return fail(`不认识的 action：${action}`)
      } catch (e) {
        return fail(`记忆操作失败：${e?.message ?? e}`)
      }
    },
  })))

  // ═══════════════════════════════════════════════════════════════════════
  //  管理台的只读数据接口（给 lib/client.js 的设置页用）
  // ═══════════════════════════════════════════════════════════════════════
  //  ⚠️ 三条硬约束：
  //    ① 只读。这里一个写操作都没有 —— 写一律走工具（有审查/沙箱/回滚），
  //       一条能直接改 profile 的 HTTP 接口等于绕过整套安全网。
  //    ② 必须走 ctx.effect 注册，否则热重载撞 duplicate route。
  //    ③ webServer 拿不到（无 Web 宿主）就静默跳过，不能让插件起不来。
  //
  //  ⚠️ 必须走 ctx.inject(['webServer'], …)。apply 跑到这里时 webServer 常常还没挂载，
  //    早先写成 ctx.get('webServer') 直接静默跳过 → 路由根本没注册 → 设置页所有接口 404
  //    （2026-10-23 真机事故：插件 active、工具全好，只有管理台 404）。
  //    dsh-meme / billion-context / skin-maid-atelier 都是 ctx.inject 写法。
  const mountApi = (webCtx) => {
    const webServer = webCtx?.webServer ?? webCtx?.get?.('webServer') ?? null
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] 拿到 webServer 但没有 register，管理台接口不挂`)
      return
    }
    try {
      const sources = buildSources({
        memory,
        profile: () => {
          const { dir } = resolveProfileDir({})
          return { dir, patchedDeps: readPatchedDependencies(dir) }
        },
        scanPatches,
        listBackups,
        // 队列这块给的是**插件自己的状态**，不是 profile 的配置。
        // 删待办 / 清空待办属于「管自己的记事本」，跟「改 profile」不是一回事；
        // 真正的安装永远走工具（带试跑 / 验证 / 回滚），这里不开那个口子。
        queue: {
          state: () => {
            const { dir } = resolveProfileDir({})
            const q = readQueue(dir)
            return {
              enabled: !!cfg.queueEnabled,
              intervalMs: cfg.queueIntervalMs,
              quietMs: cfg.idleQuietMs,
              restartAfterApply: cfg.restartAfterApply,
              patchFix: !!cfg.patchFix,
              dir,
              items: (q?.jobs ?? []).map((j) => ({
                id: j.id, name: j.name, to: j.to ?? null, status: j.status,
                tries: j.tries ?? 0, note: j.note ?? null,
                addedAt: j.addedAt ?? null, lastAt: j.lastAt ?? null,
                lastError: j.lastError ?? null,
              })),
              idle: idleTracker.snapshot(),
            }
          },
          remove: (id) => {
            const { dir } = resolveProfileDir({})
            const r = removeJob(dir, id)
            return { ok: r.removed > 0, removed: r.removed, error: r.removed > 0 ? undefined : "没有这条待办" }
          },
          clear: () => {
            const { dir } = resolveProfileDir({})
            const r = clearQueue(dir)
            return { ok: true, removed: r.removed }
          },
        },
      })
      const handler = createApiHandler(sources)
      const mountCtx = webCtx ?? ctx
      const effect = typeof mountCtx.effect === 'function'
        ? mountCtx.effect.bind(mountCtx)
        : ctx.effect.bind(ctx)
      effect(() => webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler,
      }), 'dsh-update-guard: api')
      ctx.logger?.info?.(`[${PLUGIN_ID}] 管理台接口已挂载：${ROUTE}`)
    } catch (e) {
      // 接口挂不上不影响工具，只记一条日志
      ctx.logger?.warn?.(`[${PLUGIN_ID}] 管理台接口挂载失败：${e?.message ?? e}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], mountApi)
    } catch (e) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] ctx.inject 不可用，退回立即挂载：${e?.message ?? e}`)
      mountApi(ctx)
    }
  } else {
    mountApi(ctx)
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  硬拦截：没体检过的 install_bundle 不许装
  // ═══════════════════════════════════════════════════════════════════════
  //  ⚠️ 用 tools.guard 而不是 tools/pre-execute：
  //     guard 是**单调守卫**，返回字符串即拒绝，任何插件都没法把它改回允许。
  //     这正好是主人要的"底线"——不能被别的插件或模型绕过。
  if (cfg.blockUncheckedInstall && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => {
      try {
        if (exec?.name !== 'plugin_manager') return undefined
        const a = exec.arguments ?? {}
        if (a.action !== 'install_bundle') return undefined
        const spec = String(a.target ?? a.spec ?? '').trim()
        if (!spec) return undefined
        let dir
        try { dir = resolveProfileDir({}) } catch { return undefined }
        const bare = spec.replace(/^(@?[^@]+)@.*$/, '$1')
        const hit = isVetted(dir, spec) || isVetted(dir, bare)
        if (hit && hit.ok) return undefined
        if (hit && !hit.ok) {
          return `dsh-update-guard：${spec} 的体检结论是「别装」（会让 DSH 出问题）。`
            + '如果主人坚持要装，请先明确告诉他体检拦了什么，再关掉 dsh-update-guard 的 blockUncheckedInstall。'
        }
        return `dsh-update-guard：${spec} 还没体检过。`
          + `装新插件前先调 plugin_install_check（spec="${spec}"）——`
          + '它会看这个包能不能被 DSH 正常加载、会不会跟已装插件抢 id、有没有危险写法。'
          + '（这条拦截是为了保证装完 DSH 还能正常用；主人可以在设置里关掉 blockUncheckedInstall）'
      } catch {
        return undefined   // guard 自己出错绝不能拦住正常操作
      }
    }))
  }

  // ── 启动自检日志（不弹窗，只写日志，方便排查"为什么没生效"）──
  try {
    const notes = []
    if (!z) notes.push('schemastery 没拿到 → 没有 Config，设置页降级')
    for (const n of hostDeps.notes ?? []) notes.push(n)
    if (notes.length > 0) ctx.logger?.info?.(`[${PLUGIN_ID}] 降级提示：${notes.join('；')}`)
    ctx.logger?.info?.(`[${PLUGIN_ID}] 就绪：registry=${cfg.registry}，硬拦截=${cfg.blockUncheckedInstall ? '开' : '关'}`)
  } catch { /* 日志失败无所谓 */ }
}

// 给测试/外部用的极小工具集
export const __internals = { today }
