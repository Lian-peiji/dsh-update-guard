/**
 * lib/profile.js —— 认清"我们现在在哪儿、装了些什么"
 * ============================================================================
 * 这个文件只做**只读**的事：读 profile 的 package.json、读 node_modules 里各包
 * 的真实版本、判断每个包是"哪个源装来的"。
 *
 * 🔴 为什么"源"必须分清（踩过的坑）：
 *   同样是 `dsh-xxx` 依赖，可能是三种完全不同的东西：
 *     ① registry 版本号    `"dsh-pocket": "2.12.0"`        → 能查更新、能自动装
 *     ② git tarball URL    `"dsh-fish-memory": "https://codeload..."` → **没有版本号可比**，
 *        查 registry 会 404，自动更新会瞎判 → 必须标出来"不参与自动更新"
 *     ③ 本地 file: 依赖     `"dsh-pwa-kit": "file:./local-plugins/..."` → 主人自己在改，**碰不得**
 *   把这三种混在一起判"有没有更新"，就会对着本地包喊"该升级了"，主人一看就是错的。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** DSH 的家目录（跟宿主用同一个环境变量，别自己造） */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 市场源码里的同名校验（`lib/profile.js:isDshProfileName`），保持一致 */
export function isProfileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64
    && /^[a-z0-9][a-z0-9._-]*$/i.test(name)
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

/** profile 名 → 目录。显式目录优先（桌面版宿主自己管 profile 位置） */
export function profileDir(profile, explicitDir) {
  if (explicitDir) return resolve(explicitDir)
  if (!isProfileName(profile)) throw new Error(`dsh-update-guard: 非法 profile 名 ${JSON.stringify(profile)}`)
  return join(dshHome(), 'profiles', profile)
}

/**
 * 判断一个依赖规格是哪一类源。
 * @returns {{kind:'registry'|'git'|'local'|'alias'|'unknown', version?:string, detail?:string}}
 */
export function classifySpec(spec) {
  const s = String(spec ?? '').trim()
  if (!s) return { kind: 'unknown', detail: '空规格' }
  if (s.startsWith('file:') || s.startsWith('link:') || s.startsWith('./') || s.startsWith('../') || s.startsWith('/')) {
    return { kind: 'local', detail: '本地路径依赖，主人可能在改，不参与自动更新' }
  }
  if (/^(https?:|git\+|git:|github:|gitlab:|bitbucket:|ssh:)/i.test(s)) {
    return { kind: 'git', detail: 'git/tarball 源，没有 registry 版本号可比' }
  }
  if (/^(npm|workspace|portal|catalog):/i.test(s)) {
    return { kind: 'alias', detail: `非标准规格 ${s.split(':')[0]}:` }
  }
  // 纯版本 / 范围 / tag / * / latest —— 都算 registry
  return { kind: 'registry', version: s }
}

/** 读某个包的**真实**已装版本（不信 package.json 的声明，信 node_modules 里的实物） */
export function installedVersion(dir, name) {
  try {
    const pkgFile = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(pkgFile)) return null
    return JSON.parse(readFileSync(pkgFile, 'utf8')).version ?? null
  } catch { return null }
}

/** 读某个包自己的 package.json（拿 description / dsh 字段 / 依赖） */
export function installedManifest(dir, name) {
  try {
    const pkgFile = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(pkgFile)) return null
    return JSON.parse(readFileSync(pkgFile, 'utf8'))
  } catch { return null }
}

/** 读某个包的目录（后面要看补丁、看文件） */
export function installedDir(dir, name) {
  const p = join(dir, 'node_modules', ...name.split('/'))
  try { return statSync(p).isDirectory() ? p : null } catch { return null }
}

/** 读 profile 的 package.json（不存在就返回一个空壳，别炸） */
export function readProfileManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return { name: 'dsh-profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } } }
}

/**
 * 读补丁登记表（补丁的「户口本」）。
 *
 * 🔴 两个地方都要读，缺一不可：
 *   1. `package.json` 的 `pnpm.patchedDependencies`
 *   2. `pnpm-workspace.yaml` 顶层的 `patchedDependencies`
 *
 * 为什么：pnpm 11 起，补丁表写进 `pnpm-workspace.yaml` 才生效（实测本机
 * `E:/dsh/profiles/desktop` 就是这种，`package.json` 里一个字都没有）。
 * 只读 package.json 会读出「0 个补丁」—— 然后更新时补丁被静默丢掉，
 * 主人的修复又白打了。这是这套工具最不能犯的错。
 */
export function readPatchedDependencies(dir) {
  const table = {}

  // 1. package.json（老式 / 手写的写法）
  const manifest = readProfileManifest(dir)
  const fromManifest = manifest?.pnpm?.patchedDependencies
  if (fromManifest && typeof fromManifest === 'object') {
    for (const [k, v] of Object.entries(fromManifest)) table[k] = v
  }

  // 2. pnpm-workspace.yaml（pnpm 11+ 的正式写法，优先级更高，覆盖 package.json）
  for (const [k, v] of Object.entries(readWorkspacePatchedDependencies(dir))) {
    table[k] = v
  }

  return table
}

/**
 * 从 `pnpm-workspace.yaml` 里抠出 `patchedDependencies`。
 *
 * 不引 yaml 依赖（插件要保持零依赖）：只认这一段的 `key: value` 两行格式，
 * 遇到顶格的非 patchedDependencies 键就收工。pnpm 写出来的就是这个形状：
 *
 * ```yaml
 * patchedDependencies:
 *   dsh-pocket@2.12.0: patches/dsh-pocket@2.12.0.patch
 *   '@scope/pkg@1.0.0': patches/x.patch
 * minimumReleaseAgeExclude: ...
 * ```
 */
export function readWorkspacePatchedDependencies(dir) {
  let text
  try {
    text = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  } catch { return {} }

  const out = {}
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    // 顶格注释直接跳过，别因为注释里的字把状态带偏
    if (/^\s*#/.test(raw)) continue
    const noIndent = raw.replace(/^\s+/, '')

    if (!inside) {
      if (/^patchedDependencies\s*:\s*$/.test(noIndent)) inside = true
      continue
    }

    // 顶格且不是 patchedDependencies → 这一段结束了
    if (raw.length > 0 && !/^\s/.test(raw)) { inside = false; continue }

    const m = noIndent.match(/^(['"]?)(.+?)\1\s*:\s*(['"]?)(.+?)\3\s*$/)
    if (!m) continue
    out[m[2]] = m[4]
  }
  return out
}

/**
 * 把补丁登记表**写回它原来住的地方**。
 *
 * 🔴 绝对不能一律写 package.json：如果原本登记在 pnpm-workspace.yaml，
 * 再往 package.json 写一份，就出现「两处都有、内容不一致」的鬼状态，
 * pnpm 会挑一个用，另一个变成永远打不上的孤儿补丁。
 *
 * @returns {{where: 'workspace'|'manifest'|'none', written: boolean}}
 */
export function writePatchedDependencies(dir, table) {
  const workspaceTable = readWorkspacePatchedDependencies(dir)
  const manifestTable = readProfileManifest(dir)?.pnpm?.patchedDependencies ?? {}
  const hasWorkspace = Object.keys(workspaceTable).length > 0
  const hasManifest = Object.keys(manifestTable).length > 0

  // 优先写回 yaml（pnpm 11+ 的正式位置）
  if (hasWorkspace) {
    const text = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), renderWorkspaceWithPatches(text, table), 'utf8')
    return { where: 'workspace', written: true }
  }

  if (hasManifest) {
    const manifest = readProfileManifest(dir)
    const next = { ...manifest, pnpm: { ...(manifest.pnpm ?? {}), patchedDependencies: table } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(next, null, 2), 'utf8')
    return { where: 'manifest', written: true }
  }

  // 本来就没有补丁表：不凭空造一个，避免给没有补丁的 profile 塞垃圾配置
  return { where: 'none', written: false }
}

/**
 * 把 yaml 文本里的 `patchedDependencies:` 段落整段替换成新表。
 * 没有这一段就在末尾追加。其余内容（注释、别的键）**一个字都不动**。
 */
export function renderWorkspaceWithPatches(text, table) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  const block = ['patchedDependencies:']
  for (const [k, v] of Object.entries(table)) {
    // 含 @ / : 等特殊字符的 key 用单引号包起来，跟 pnpm 自己的输出风格一致
    const key = /^[A-Za-z0-9._@/-]+$/.test(k) ? k : `'${k.replace(/'/g, "''")}'`
    block.push(`  ${key}: ${v}`)
  }

  // 找现有的段落范围
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^patchedDependencies\s*:\s*$/.test(lines[i])) {
      start = i
      end = i + 1
      while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) {
        // 空行后紧跟顶格键 → 段落结束（别把空行后的下一个段落吃进来）
        if (lines[end] === '') {
          let j = end + 1
          while (j < lines.length && lines[j] === '') j++
          if (j < lines.length && !/^\s/.test(lines[j])) break
        }
        end++
      }
      break
    }
  }

  if (start === -1) {
    const tail = lines.length > 0 && lines[lines.length - 1] === '' ? '' : eol
    return lines.join(eol) + tail + block.join(eol) + eol
  }

  const out = [...lines.slice(0, start), ...block, ...lines.slice(end)]
  return out.join(eol)
}

/**
 * 扫描整个 profile：装了哪些插件、各是什么源、真实版本、有没有补丁。
 * @param {string} dir profile 目录
 * @returns {Array<{name, spec, sourceKind, declaredVersion, actualVersion, patched, bundleEnabled, description}>}
 */
export function scanProfile(dir) {
  const manifest = readProfileManifest(dir)
  const deps = manifest.dependencies ?? {}
  const bundles = new Set(manifest?.dsh?.profile?.bundles ?? [])
  const patches = readPatchedDependencies(dir)

  const patchedNames = new Set()
  for (const key of Object.keys(patches)) {
    // key 形如 `dsh-pocket@2.12.0`
    const at = key.lastIndexOf('@')
    patchedNames.add(at > 0 ? key.slice(0, at) : key)
  }

  return Object.entries(deps).map(([name, spec]) => {
    const src = classifySpec(spec)
    const actual = installedVersion(dir, name)
    const mf = installedManifest(dir, name)
    return {
      name,
      spec: String(spec),
      sourceKind: src.kind,
      sourceDetail: src.detail ?? null,
      declaredVersion: src.version ?? null,
      actualVersion: actual,
      patched: patchedNames.has(name),
      bundleEnabled: bundles.has(name),
      description: mf?.description ?? null,
    }
  })
}

/** 列出 DSH_HOME 下有哪些 profile（给"这台机器上有几个环境"用） */
export function listProfiles() {
  const root = join(dshHome(), 'profiles')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isProfileName(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch { return [] }
}

/**
 * 挑一个"当前活跃"的 profile。
 * 桌面版会通过 Config 把目录传进来；命令行/其它宿主没有的话，
 * 就选**装了最多东西的那个**（空 profile 通常是模板，不是主人在用的）。
 */
export function guessActiveProfile() {
  const names = listProfiles()
  if (names.length === 0) return null
  let best = null
  let bestCount = -1
  for (const name of names) {
    const dir = join(dshHome(), 'profiles', name)
    const count = Object.keys(readProfileManifest(dir).dependencies ?? {}).length
    if (count > bestCount) { bestCount = count; best = name }
  }
  return best
}
