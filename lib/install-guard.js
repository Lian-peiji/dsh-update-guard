/**
 * lib/install-guard.js —— 装新插件之前的体检（**不是建议，是拦截**）
 * ============================================================================
 * 🔴 这个文件存在的唯一原因，是一次真实事故：
 *   2026-10-21 夜，主人说"装个插件"，我**没看那是什么东西就装了**，DSH 整个崩掉。
 *   主人原话（m00756）：
 *     「用户主动安装新插件时也要审视一遍会不会有什么问题，别忘了昨晚我叫你装一个插件，
 *       你也不看是什么东西就装，导致 DSH 整个崩掉。」
 *
 * ⭐ 所以这里的定位跟"更新审查"不一样：
 *   - 更新审查 → **默认放行**（要新功能）
 *   - 新装体检 → **默认拦截**（装错了 DSH 直接崩，代价是"不能用"）
 *
 * 🔴 一个插件能让整个 DSH 崩掉，实测/已知的路径有四条，这里逐条堵：
 *
 *   ① **裸 import 一个没声明的包** → 插件模块加载失败 → DSH 把 bundle 条目摘掉 → 页面 404
 *      （dsh-fish-memory 的 hostdeps.mjs 就是为这个写的，注释里写着"在没装它的机器上会让整条插件不激活"）
 *   ② **顶层抛异常 / process.exit()** → 进程直接没了
 *   ③ **cordis.patch.yml 里 insert 的 id 撞车** → 宿主装配冲突，起不来
 *   ④ **engines / peerDeps 不满足** → 装上了但激活不了，表现就是"装了个寂寞 + 页面白屏"
 *
 * ⭐ 体检分两层：
 *   **静态**（几秒，纯读，零执行）：上面四条 + 危险模式扫描 + 冲突检测
 *   **模型**（几十秒）：读 README + 源码摘要，判断"这东西到底干什么、跟现有插件打架吗"
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname, basename } from 'node:path'
import { compare, satisfies, parse as parseVer } from './semver.js'

/** 危险模式 —— 命中不代表一定有问题，但**必须让主人看见** */
const RISK_PATTERNS = [
  { re: /\beval\s*\(/, why: 'eval 执行字符串代码', level: 'high' },
  { re: /new\s+Function\s*\(/, why: '动态构造函数', level: 'high' },
  { re: /\bprocess\s*\.\s*exit\s*\(/, why: '会直接杀进程（DSH 会当场没）', level: 'high' },
  { re: /\bprocess\s*\.\s*kill\s*\(/, why: '会杀别的进程', level: 'high' },
  { re: /rm\s*\(\s*[^)]*recursive\s*:\s*true/, why: '递归删目录', level: 'high' },
  { re: /\bchild_process\b|execSync\s*\(|spawnSync\s*\(/, why: '起子进程执行命令', level: 'medium' },
  { re: /\.ssh[\\/]|id_rsa|\.aws[\\/]credentials|\.npmrc/i, why: '碰凭证文件', level: 'high' },
  { re: /localStorage\s*\.\s*getItem\s*\(\s*['"][^'"]*(token|key|secret)/i, why: '读浏览器里的 token', level: 'high' },
  { re: /document\s*\.\s*cookie/, why: '读 cookie', level: 'medium' },
  { re: /fetch\s*\(\s*['"]https?:\/\/(?!registry\.npmjs\.org|localhost|127\.0\.0\.1)/, why: '向外发请求', level: 'low' },
  { re: /\batob\s*\(|Buffer\s*\.\s*from\s*\([^)]*base64/, why: '解码 base64（可能藏代码）', level: 'medium' },
  { re: /\bwhile\s*\(\s*true\s*\)/, why: '死循环（会卡死 UI）', level: 'medium' },
]

/**
 * 客户端半边（exports["./client"]）由**宿主 Web 运行时注入**的模块。
 *
 * 证据：宿主自己的 `chat.client.js:8-12` 就写 `require("react")` /
 * `require("react-dom")` / `require("react/jsx-runtime")` /
 * `require("@tanstack/react-virtual")`，而 profile 的 node_modules 里根本没有
 * react。已装的 dsh-meme@0.1.55 同样在 client.js:17 写 `require('react')` 却能正常
 * 工作。所以：**client 侧文件里的这些裸 import 不是缺失依赖**，不能当 blocker。
 */
const CLIENT_INJECTED = new Set([
  'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  '@tanstack/react-virtual', '@tanstack/react-query', '@tanstack/react-table',
])

/** Node 内置模块（裸 import 这些永远安全） */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'])

function isNoisePath(rel) {
  const p = rel.split('\\').join('/')
  return /(^|\/)node_modules\//.test(p)
    || /\.map$/i.test(p)
    || /(^|\/)(test|tests|__tests__|spec|fixtures?)\//i.test(p)
    || /(^|\/)\.(github|vscode)\//.test(p)
}

/** 从一段 JS 里抠出所有**裸模块名**（跳过相对路径、绝对路径、node: 前缀） */
export function extractBareImports(code) {
  const out = new Set()
  // import ... from 'x'  /  import 'x'  /  export ... from 'x'
  const importRe = /(?:^|[\s;])(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g
  // 动态 import('x')
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  // require('x')
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  for (const re of [importRe, dynRe, reqRe]) {
    let m
    while ((m = re.exec(code)) !== null) {
      const spec = m[1]
      if (!spec) continue
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) continue
      if (spec.startsWith('node:')) continue
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (NODE_BUILTINS.has(root)) continue
      out.add(root)
    }
  }
  return [...out]
}

/** 一个裸模块名在某个 node_modules 树里解析得到吗 */
function resolvableIn(nodeModulesDir, spec) {
  const parts = spec.split('/')
  const pkgDir = join(nodeModulesDir, ...(spec.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)))
  return existsSync(pkgDir)
}

/** 解析 cordis.patch.yml 里 insert 的 id（只看 id/name，不跑 YAML 解析器） */
export function parsePatchIds(yamlText) {
  const ids = new Set()
  for (const line of String(yamlText ?? '').split(/\r?\n/)) {
    const m = /^\s*-?\s*(?:id|name)\s*:\s*([\w@./-]+)\s*$/.exec(line)
    if (m) ids.add(m[1])
  }
  return [...ids]
}

/**
 * 静态体检 —— 完全不执行候选插件的任何代码，只读。
 *
 * @param {object} args
 * @param {Map<string,Buffer>} args.files  候选插件的 tarball 内容
 * @param {string} args.name
 * @param {string} args.version
 * @param {string} args.profileDir        要装进哪个 profile
 * @param {string} args.nodeVersion       宿主 node 版本（v24.21.0 这种）
 * @returns 体检报告
 */
export function staticCheck({ files, name, version, profileDir, nodeVersion }) {
  const findings = []
  const blockers = []
  const add = (level, code, message, evidence) => findings.push({ level, code, message, evidence: evidence ?? null })

  // ── 1. 读 manifest ──────────────────────────────────────────────
  const mfBuf = files.get('package.json')
  if (!mfBuf) {
    blockers.push({ code: 'NO_MANIFEST', message: 'tarball 里没有 package.json —— 这不是一个合法的 npm 包' })
    return { ok: false, findings, blockers, manifest: null, imports: [], risks: [], conflicts: [] }
  }
  let manifest
  try { manifest = JSON.parse(mfBuf.toString('utf8')) } catch (e) {
    blockers.push({ code: 'BAD_MANIFEST', message: `package.json 不是合法 JSON：${e.message}` })
    return { ok: false, findings, blockers, manifest: null, imports: [], risks: [], conflicts: [] }
  }

  const deps = { ...(manifest.dependencies ?? {}) }
  const peerDeps = { ...(manifest.peerDependencies ?? {}) }
  const peerMeta = { ...(manifest.peerDependenciesMeta ?? {}) }
  const optionalDeps = { ...(manifest.optionalDependencies ?? {}) }
  const declared = new Set([...Object.keys(deps), ...Object.keys(peerDeps), ...Object.keys(optionalDeps)])

  // ── 2. engines 检查（不满足 → 装了也起不来）───────────────────
  if (manifest.engines?.node) {
    const ok = satisfies(manifest.engines.node, nodeVersion)
    if (ok === false) {
      blockers.push({
        code: 'ENGINES_MISMATCH',
        message: `要求 node ${manifest.engines.node}，本机是 ${nodeVersion} —— 装上也跑不起来`,
      })
    }
  }

  // ── 3. 是不是 DSH 插件（不是的话，装进来没意义还占地方）───────
  const isDshPlugin = !!(manifest.dsh || manifest.peerDependencies?.['@deepseek-ai/cordis'])
  if (!isDshPlugin) {
    add('low', 'NOT_DSH_PLUGIN', '这个包没有声明 dsh 字段，也不依赖 cordis —— 可能根本不是 DSH 插件')
  }

  // ── 4. dsh.bundle.patch 指向的文件存在吗 ──────────────────────
  const patchRel = manifest.dsh?.bundle?.patch
  if (patchRel) {
    const rel = String(patchRel).replace(/^\.\//, '')
    if (!files.has(rel)) {
      blockers.push({
        code: 'MISSING_BUNDLE_PATCH',
        message: `dsh.bundle.patch 指向 ${rel}，但包里没有这个文件 —— 宿主装配会失败`,
      })
    }
  }

  // ── 5. 裸 import 完整性（★ 这是最容易让整条插件不激活的一条）──
  // 关键区分：宿主侧入口（exports["."]，跑在 node 里）缺包 = 插件加载必失败；
  // 客户端入口（exports["./client"]，跑在宿主 Web 运行时里）缺包要看是不是宿主注入的。
  const imports = []
  const missing = []
  const nodeModulesDir = join(profileDir, 'node_modules')
  const clientEntry = String(manifest.exports?.['./client'] ?? '').replace(/^\.\//, '')
  for (const [rel, buf] of files) {
    if (isNoisePath(rel)) continue
    if (!SOURCE_EXT.has(extname(rel).toLowerCase())) continue
    const isClientSide = clientEntry ? rel === clientEntry : /(^|\/)client\.(m?js|cjs|jsx|ts|tsx)$/.test(rel)
    const code = buf.toString('utf8')
    for (const spec of extractBareImports(code)) {
      imports.push({ spec, file: rel, side: isClientSide ? 'client' : 'host' })
      if (declared.has(spec)) continue                    // 自己声明了，pnpm 会装
      if (isClientSide && (CLIENT_INJECTED.has(spec) || CLIENT_INJECTED.has(spec.split('/')[0]))) {
        // 宿主 Web 运行时注入，不装也不会缺
        continue
      }
      if (spec.startsWith('@deepseek-ai/')) {
        // 宿主提供的包：运行时可能从宿主树解析到，但**也可能解析不到**
        if (!resolvableIn(nodeModulesDir, spec)) {
          add('medium', 'HOST_PKG_IMPORT',
            `import 了宿主的 ${spec}，但 profile 里没有它 —— 桌面版不会自动装 peerDeps，` +
            `插件加载时可能整条失败（dsh-fish-memory 就是为这个写了 hostdeps 兜底）`,
            `${rel}: import '${spec}'`)
        }
        continue
      }
      if (!resolvableIn(nodeModulesDir, spec)) {
        missing.push({ spec, file: rel, side: isClientSide ? 'client' : 'host' })
      }
    }
  }
  if (missing.length > 0) {
    const uniq = [...new Map(missing.map((m) => [m.spec, m])).values()]
    const hostSide = uniq.filter((u) => u.side === 'host')
    const clientSide = uniq.filter((u) => u.side === 'client')
    if (hostSide.length > 0) {
      blockers.push({
        code: 'UNDECLARED_IMPORT',
        message: `宿主侧代码 import 了 ${hostSide.length} 个包，但**既没写进依赖、profile 里也没有** → ` +
          `插件加载必失败，DSH 会把这个插件整条摘掉（页面 404）。缺的是：${hostSide.map((u) => u.spec).join(', ')}`,
        evidence: hostSide.slice(0, 8).map((u) => `${u.file}: import '${u.spec}'`),
      })
    }
    if (clientSide.length > 0) {
      add('medium', 'UNDECLARED_CLIENT_IMPORT',
        `客户端代码 import 了 ${clientSide.length} 个包，没声明也没装。**宿主不一定注入它们**，` +
        `轻则这个插件的前端页面白屏，重则整个 Web UI 加载失败。缺的是：${clientSide.map((u) => u.spec).join(', ')}`,
        clientSide.slice(0, 8).map((u) => `${u.file}: import '${u.spec}'`))
    }
  }

  // ── 6. 危险模式扫描 ───────────────────────────────────────────
  const risks = []
  for (const [rel, buf] of files) {
    if (isNoisePath(rel)) continue
    if (!SOURCE_EXT.has(extname(rel).toLowerCase())) continue
    const code = buf.toString('utf8')
    const lines = code.split(/\r?\n/)
    for (const { re, why, level } of RISK_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          risks.push({ level, why, file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 160) })
          break                                     // 同一模式同一文件只记一次
        }
      }
    }
  }
  if (risks.some((r) => r.level === 'high')) {
    add('high', 'HIGH_RISK_PATTERN',
      `命中 ${risks.filter((r) => r.level === 'high').length} 处高风险写法（详见 risks）`)
  }

  // ── 7. 跟已装插件冲突 ─────────────────────────────────────────
  const conflicts = []

  // ① 同名包已装（版本冲突 / 降级）
  try {
    const installedPkg = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(installedPkg)) {
      const cur = JSON.parse(readFileSync(installedPkg, 'utf8')).version
      if (cur && version) {
        const cmp = compare(version, cur)
        if (cmp === 0) {
          add('low', 'ALREADY_INSTALLED', `已经装了同版本 ${cur}，这次装等于重装`)
        } else if (cmp < 0) {
          add('medium', 'DOWNGRADE', `要装的是 ${version}，比现在装的 ${cur} **更旧** —— 可能是降级`)
        } else {
          add('low', 'UPGRADE', `已装 ${cur}，这次会升到 ${version}`)
        }
      }
    }
  } catch { /* 没装过 */ }

  // ② bundle patch 里的 id 撞车（宿主装配冲突）
  if (patchRel && files.has(String(patchRel).replace(/^\.\//, ''))) {
    const candIds = parsePatchIds(files.get(String(patchRel).replace(/^\.\//, '')).toString('utf8'))
    const taken = new Set()
    try {
      const profileMf = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      for (const dep of Object.keys(profileMf.dependencies ?? {})) {
        const p = join(profileDir, 'node_modules', ...dep.split('/'), 'package.json')
        if (!existsSync(p)) continue
        try {
          const m = JSON.parse(readFileSync(p, 'utf8'))
          const rel = m.dsh?.bundle?.patch
          if (!rel) continue
          const f = join(profileDir, 'node_modules', ...dep.split('/'), String(rel).replace(/^\.\//, ''))
          if (existsSync(f)) for (const id of parsePatchIds(readFileSync(f, 'utf8'))) taken.add(`${id} ← ${dep}`)
        } catch { /* 单个包坏了不影响大局 */ }
      }
    } catch { /* profile 读不到就算了 */ }

    for (const id of candIds) {
      const hit = [...taken].find((t) => t.startsWith(`${id} ← `))
      if (hit) {
        conflicts.push({
          code: 'BUNDLE_ID_COLLISION',
          message: `要插入的插件 id「${id}」已经被 ${hit.split('←')[1].trim()} 占用 —— 宿主装配会冲突`,
        })
      }
    }
  }

  // ── 8. 体积 / 文件数 sanity（几十 MB 的"插件"要警惕）──────────
  let totalBytes = 0
  for (const buf of files.values()) totalBytes += buf.length
  if (totalBytes > 20 * 1024 * 1024) {
    add('medium', 'HUGE_PACKAGE', `这个包 ${(totalBytes / 1048576).toFixed(1)}MB，比一般插件大得多（可能塞了别的东西）`)
  }
  if (files.size > 3000) {
    add('medium', 'MANY_FILES', `包里有 ${files.size} 个文件，异常多`)
  }

  // ── 9. 有没有 README（没有的话模型也没法判断它是干什么的）────
  const hasReadme = [...files.keys()].some((f) => /^readme(\.md|\.markdown)?$/i.test(f))
  if (!hasReadme) add('medium', 'NO_README', '包里没有 README —— 没人说得清这是干什么的')

  const ok = blockers.length === 0
  return { ok, findings, blockers, manifest, imports, risks, conflicts, totalBytes, hasReadme }
}

/**
 * 汇总体检报告 → 人类可读的一段话（给主人看，也给模型看）
 */
export function renderReport(report, { name, version }) {
  const lines = []
  const verdictTag = report.blockers.length > 0 ? '🔴 不能装'
    : report.findings.some((f) => f.level === 'high') ? '🟠 有高风险，要主人拍板'
      : report.findings.some((f) => f.level === 'medium') ? '🟡 可以装，但有几处要看一眼'
        : '🟢 静态检查没发现问题'

  lines.push(`## 体检结论：${verdictTag}`)
  lines.push(`${name}@${version}`)

  if (report.blockers.length > 0) {
    lines.push('\n### 拦截项（装上会出事）')
    for (const b of report.blockers) {
      lines.push(`- **${b.code}**：${b.message}`)
      for (const e of b.evidence ?? []) lines.push(`  - \`${e}\``)
    }
  }

  if (report.conflicts?.length > 0) {
    lines.push('\n### 跟现有插件冲突')
    for (const c of report.conflicts) lines.push(`- **${c.code}**：${c.message}`)
  }

  const risks = report.risks ?? []
  if (risks.length > 0) {
    lines.push('\n### 扫描到的写法')
    const byLevel = { high: [], medium: [], low: [] }
    for (const r of risks) (byLevel[r.level] ?? byLevel.low).push(r)
    for (const level of ['high', 'medium', 'low']) {
      if (byLevel[level].length === 0) continue
      const tag = level === 'high' ? '🔴 高' : level === 'medium' ? '🟠 中' : '⚪ 低'
      lines.push(`\n**${tag}**`)
      for (const r of byLevel[level].slice(0, 10)) {
        lines.push(`- ${r.why} —— \`${r.file}:${r.line}\`  ${r.snippet ? `\n  \`${r.snippet}\`` : ''}`)
      }
    }
  }

  const others = (report.findings ?? []).filter((f) => !['HIGH_RISK_PATTERN'].includes(f.code))
  if (others.length > 0) {
    lines.push('\n### 其它')
    for (const f of others) lines.push(`- [${f.level}] ${f.message}`)
  }

  return lines.join('\n')
}

/**
 * 给模型的审查材料（README + 入口源码摘要 + 体检结果）
 */
export function buildReviewMaterial({ files, report, name, version, maxSourceChars = 20_000 }) {
  const parts = []
  parts.push(`# 待装插件：${name}@${version}`)
  const mf = report.manifest ?? {}
  if (mf.description) parts.push(`\n包说明（作者自述）：${mf.description}`)
  if (mf.keywords?.length) parts.push(`关键词：${mf.keywords.join(', ')}`)
  if (mf.author) parts.push(`作者：${typeof mf.author === 'string' ? mf.author : mf.author?.name ?? '?'}`)
  if (mf.repository) parts.push(`仓库：${typeof mf.repository === 'string' ? mf.repository : mf.repository?.url ?? '?'}`)
  if (mf.license) parts.push(`许可：${mf.license}`)

  const deps = Object.entries(mf.dependencies ?? {})
  if (deps.length > 0) parts.push(`\n依赖 ${deps.length} 个：${deps.map(([k, v]) => `${k}@${v}`).join(', ')}`)
  const peers = Object.entries(mf.peerDependencies ?? {})
  if (peers.length > 0) parts.push(`peer 依赖：${peers.map(([k, v]) => `${k}@${v}`).join(', ')}`)

  if (mf.dsh) parts.push(`\nDSH 声明：${JSON.stringify(mf.dsh)}`)

  // README（作者自己说它是干什么的）
  const readmeKey = [...files.keys()].find((f) => /^readme(\.md|\.markdown)?$/i.test(f))
  if (readmeKey) {
    const text = files.get(readmeKey).toString('utf8')
    parts.push(`\n## README\n${text.length > 8000 ? text.slice(0, 8000) + '\n…（截断）' : text}`)
  }

  // 入口源码（真正在跑的那部分）
  const entries = []
  const main = mf.main ? String(mf.main).replace(/^\.\//, '') : null
  const exportsDot = typeof mf.exports?.['.'] === 'string' ? mf.exports['.'].replace(/^\.\//, '')
    : mf.exports?.['.']?.default?.replace?.(/^\.\//, '') ?? null
  for (const cand of [main, exportsDot]) {
    if (cand && files.has(cand) && !entries.includes(cand)) entries.push(cand)
  }
  if (entries.length === 0) {
    const guess = [...files.keys()].filter((f) => /^(lib\/)?index\.(js|mjs|cjs)$/.test(f))
    if (guess.length > 0) entries.push(guess[0])
  }

  let used = 0
  for (const e of entries) {
    const code = files.get(e).toString('utf8')
    if (used >= maxSourceChars) break
    const slice = code.slice(0, Math.min(code.length, maxSourceChars - used))
    parts.push(`\n## 入口源码：${e}（${code.split(/\r?\n/).length} 行）\n\`\`\`javascript\n${slice}${slice.length < code.length ? '\n…（截断）' : ''}\n\`\`\``)
    used += slice.length
  }

  parts.push(`\n## 静态体检结果\n${renderReport(report, { name, version })}`)
  return parts.join('\n')
}

/** 体检模型的系统提示词 */
export const INSTALL_SYSTEM = `你是 DSH（DeepSeek Harness）的「插件管家」，现在负责新装插件的安全体检。主人要装一个新插件，你要判断**装完之后 DSH 还能不能正常用**。

## 你的唯一标准
**不是"这插件好不好用"，是"装了之后 DSH 会不会坏"。**
功能重复、冗余、不如现有的 —— **不关你的事**，不要因此否决。主人要的是这套 DSH + 插件能稳定跑起来。

## 你必须回答的三件事
1. **这东西到底是什么**（一句话，从 README 和源码看，不要复述作者的自夸）
2. **装了会不会把 DSH 搞坏** —— 只认这几种具体机制：
   - 加载期就失败（裸 import 找不到包 / 顶层抛异常 / process.exit）
   - 装配冲突（bundle id 撞车 / 同名工具 / 抢同一个 slot）
   - 运行期把主线程卡死（死循环 / 同步大计算）
   - 删/改主人自己的文件
   - 把凭证发到外面
3. **如果会坏，有没有办法规避**（不装 / 先改一行 / 等作者修）

## 输出格式
**只输出一个 JSON 对象**，不要 markdown 围栏、不要解释：
{
  "verdict": "safe|caution|dangerous",
  "confidence": 0.0~1.0,
  "whatItIs": "一句话说清这是什么",
  "crashRisks": [{"mechanism":"具体怎么让 DSH 坏","evidence":"指到文件:行","likelihood":"high|medium|low"}],
  "notes": "主人该知道的一件事（没有就空字符串）"
}

## 铁律
- **dangerous 必须有具体机制和证据**。写不出"怎么坏的"，就不许判 dangerous。
- 静态体检已经拦下的（UNDECLARED_IMPORT / ENGINES_MISMATCH / BUNDLE_ID_COLLISION）**不用你重复**，直接判 dangerous 即可。
- 你判 safe 的代价很小（大不了不好用删掉）；判 dangerous 的代价是主人错过一个好东西 —— 但**装坏了代价最大**。所以：**有明确的"会坏"机制才拦，没有就放行**。`
