/**
 * lib/recon.js —— 侦察：这个包到底有没有新版本？新版本改了什么？
 * ============================================================================
 * 只做**只读**的事：查 registry、下 tarball、算逐文件 diff、捞 changelog。
 * 一个字节都不写进 node_modules。
 *
 * 🔴 三个必须踩对的点（都是真实坑）：
 *
 *   ① **tarball 必须自己解，不能信 registry 的 readme**
 *      模型的判断质量 100% 取决于"看到真实 diff"。只喂一段 changelog，它就会瞎编
 *      "可能导致 bug"。所以这里真的把新旧两个 tarball 下来、解压、逐文件比对。
 *
 *   ② **只看源码，跳过噪音**
 *      一个插件 tarball 里 80% 的字节是 README 徽章、sourcemap、.d.ts、测试快照。
 *      把它们喂给模型既费钱又干扰判断 → 白名单式挑文件（.js/.mjs/.cjs/.json/.yml/.css…），
 *      再跳过 `*.map`、`*.d.ts`、`node_modules/`、`test/`、`*.snap`。
 *
 *   ③ **diff 要限长**
 *      真实情况：dshmarket 一个 minor 版本能改 3000 行。整包喂进去会爆上下文，
 *      而且模型看到第 2000 行就忘了第 1 行。→ 每个文件截断 + 全局预算 + **摘要优先**。
 *      摘要（改了几个文件、各改多少行）比逐行 diff 更能让模型判断"这次更新大不大"。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, sep, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { compare, bumpType, maxVersion, parse } from './semver.js'

/** 默认 registry（主人的 profile 用的是官方源；可被 Config 覆盖） */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** 算 diff 时要看的源码扩展名 —— 其余一律当噪音 */
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.yml', '.yaml',
  '.css', '.scss', '.less', '.html', '.svg', '.md', '.patch',
])

/** 一律跳过的路径片段 */
const NOISE = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /\.map$/i,
  /\.d\.ts$/i,
  /\.snap$/i,
  /(^|\/)(test|tests|__tests__|spec|fixtures?)\//i,
  /(^|\/)\.(github|vscode|idea)\//,
  /(^|\/)(CHANGELOG|CHANGES|HISTORY)\.md$/i,   // changelog 单独处理，不混进 diff
  /(^|\/)package-lock\.json$/i,
]

/** 这些文件就算变了也不影响判断（模型版本号、构建产物时间戳） */
const LOW_SIGNAL = [
  /(^|\/)LICENSE/i,
  /(^|\/)\.npmignore$/,
  /(^|\/)\.gitignore$/,
]

function isNoise(rel) {
  const p = rel.split(sep).join('/')
  return NOISE.some((re) => re.test(p))
}

function isSource(rel) {
  const ext = extname(rel).toLowerCase()
  return SOURCE_EXT.has(ext) || ext === ''
}

/**
 * 从 npm registry 查一个包的元数据。
 * 走 `Accept: application/vnd.npm.install-v1+json`（缩写版，快 10 倍，字段够用）。
 */
export async function fetchPackument(registry, name, { signal } = {}) {
  const base = (registry || DEFAULT_REGISTRY).replace(/\/?$/, '/')
  const url = base + name.replace('/', '%2F')
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal,
  })
  if (res.status === 404) return { notFound: true, name }
  if (!res.ok) throw new Error(`registry 返回 ${res.status} ${res.statusText}（${name}）`)
  const body = await res.json()
  return {
    name: body.name ?? name,
    versions: body.versions ?? {},
    distTags: body['dist-tags'] ?? {},
    modified: body.modified ?? null,
  }
}

/**
 * 侦察一个包：有没有更新、新版本是什么、改动大不大。
 * **只读**，不下载 tarball（下载留给 deepDive）。
 *
 * @returns {{
 *   name, sourceKind, current, latest, bump, hasUpdate, reason,
 *   distTag, deprecated, otherVersions
 * }}
 */
export async function reconPackage(registry, pkg, { signal, includePrerelease = false } = {}) {
  const out = {
    name: pkg.name,
    sourceKind: pkg.sourceKind,
    current: pkg.actualVersion ?? pkg.declaredVersion ?? null,
    latest: null,
    bump: 'unknown',
    hasUpdate: false,
    reason: '',
    distTag: null,
    deprecated: null,
    otherVersions: [],
    patched: !!pkg.patched,
  }

  // ① 非 registry 源：明确说不参与，别假装能判
  if (pkg.sourceKind !== 'registry') {
    out.reason = pkg.sourceKind === 'local'
      ? '本地路径依赖（file:/link:），内容由主人自己维护，不参与自动更新'
      : pkg.sourceKind === 'git'
        ? 'git/tarball 源，没有 registry 版本号可比；要更新得手动换 commit'
        : `源类型 ${pkg.sourceKind} 不支持自动判断`
    return out
  }

  // ② 连"现在装的是哪版"都不知道 → 判不了
  if (!out.current) {
    out.reason = 'node_modules 里找不到这个包（可能没装成功，或只是个声明）'
    return out
  }

  let pack
  try {
    pack = await fetchPackument(registry, pkg.name, { signal })
  } catch (e) {
    out.reason = `查 registry 失败：${e?.message ?? e}`
    return out
  }
  if (pack.notFound) {
    out.reason = '这个包不在 registry 上（可能是私有包 / 已下架 / 换了名字）'
    return out
  }

  const all = Object.keys(pack.versions)
  out.otherVersions = all

  // ③ 挑目标版本
  const tagged = pack.distTags?.latest ?? null
  let target = tagged
  if (includePrerelease) {
    const nextTag = pack.distTags?.next ?? pack.distTags?.beta ?? null
    if (nextTag && (!target || compare(nextTag, target) > 0)) target = nextTag
  }
  if (!target) target = maxVersion(all)
  out.distTag = tagged
  out.latest = target

  if (!target) { out.reason = 'registry 上一个版本都没有（异常）'; return out }

  // ④ 比大小
  const cmp = compare(target, out.current)
  out.bump = bumpType(out.current, target)
  out.hasUpdate = cmp > 0

  if (cmp < 0) {
    out.reason = `已装的 ${out.current} **比 registry 上的 ${target} 还新**（本地是预发布版或上游回退过）`
  } else if (cmp === 0) {
    out.reason = '已是最新'
  } else {
    out.reason = `有新版本 ${target}（当前 ${out.current}，${out.bump} 级变动）`
  }

  // ⑤ 弃用标记（比"有没有新版本"更重要 —— 被弃用的包升上去可能更糟）
  const targetMeta = pack.versions?.[target]
  if (targetMeta?.deprecated) out.deprecated = String(targetMeta.deprecated)

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
//  tarball 下载 + 解压
// ─────────────────────────────────────────────────────────────────────────────

/** 极简 tar 解包器（只支持 ustar/pax + gzip；npm tarball 就这两种） */
function untarGz(buf) {
  const files = new Map()
  let off = 0
  let longName = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    // 全 0 块 = 结束
    if (header.every((b) => b === 0)) break

    const str = (from, len) => {
      const s = header.subarray(from, from + len)
      const z = s.indexOf(0)
      return s.subarray(0, z === -1 ? len : z).toString('utf8')
    }
    const name = str(0, 100)
    const sizeOctal = str(124, 12).trim()
    const size = parseInt(sizeOctal, 8) || 0
    const typeflag = String.fromCharCode(header[156] || 48)
    const prefix = str(345, 155)
    let full = prefix ? `${prefix}/${name}` : name

    off += 512
    const data = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512

    if (typeflag === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue }
    if (typeflag === 'x' || typeflag === 'g') continue          // pax 扩展头，忽略
    if (longName) { full = longName; longName = null }
    if (typeflag === '5') continue                              // 目录
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') continue

    // npm 的 tarball 统一带一层 `package/` 前缀，剥掉
    const rel = full.replace(/^package\//, '').split('\\').join('/')
    if (!rel || rel.endsWith('/')) continue
    files.set(rel, data)
  }
  return files
}

/** 下载并解开一个包的某个版本 → Map<相对路径, Buffer> */
export async function fetchTarball(registry, name, version, { signal, tarballUrl } = {}) {
  let url = tarballUrl
  if (!url) {
    const pack = await fetchPackument(registry, name, { signal })
    if (pack.notFound) throw new Error(`${name} 不在 registry 上`)
    url = pack.versions?.[version]?.dist?.tarball
    if (!url) throw new Error(`${name}@${version} 没有 tarball 地址（版本不存在？）`)
  }
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`下载 tarball 失败 ${res.status}（${name}@${version}）`)
  const gz = Buffer.from(await res.arrayBuffer())
  const { gunzipSync } = await import('node:zlib')
  return untarGz(gunzipSync(gz))
}

// ─────────────────────────────────────────────────────────────────────────────
//  逐文件 diff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 极简行级 diff（LCS）。
 * 为什么不用现成的 diff 库：发布出去别人机器上不一定有；而这里只需要
 * "哪几行变了"，不需要最优编辑距离。
 */
function lineDiff(oldText, newText, { maxLines = 400 } = {}) {
  const a = oldText.split(/\r?\n/)
  const b = newText.split(/\r?\n/)

  // 前缀 / 后缀相同部分直接跳过（真实文件 99% 的改动都在中间一小段）
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }

  const aMid = a.slice(start, endA + 1)
  const bMid = b.slice(start, endB + 1)

  // 改动太大就别做 LCS 了（O(n*m) 会卡住），直接标记"整段替换"
  const out = []
  if (aMid.length * bMid.length > 4_000_000) {
    out.push(`@@ 第 ${start + 1} 行起，整段替换（旧 ${aMid.length} 行 → 新 ${bMid.length} 行）@@`)
    for (const l of aMid.slice(0, maxLines)) out.push('-' + l)
    for (const l of bMid.slice(0, maxLines)) out.push('+' + l)
    return { text: out.join('\n'), added: bMid.length, removed: aMid.length, truncated: true }
  }

  // 标准 LCS 表
  const n = aMid.length; const m = bMid.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aMid[i] === bMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  let added = 0; let removed = 0; let truncated = false
  const emit = (line) => {
    if (out.length < maxLines) out.push(line)
    else truncated = true
  }

  if (start > 0) out.push(`@@ 前面 ${start} 行没变 @@`)
  let i = 0; let j = 0
  let ctx = 0
  while (i < n || j < m) {
    if (i < n && j < m && aMid[i] === bMid[j]) {
      if (ctx < 3) emit(' ' + aMid[i])
      ctx++
      i++; j++
      continue
    }
    ctx = 0
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { emit('+' + bMid[j]); added++; j++ }
    else if (i < n) { emit('-' + aMid[i]); removed++; i++ }
  }
  if (endA + 1 < a.length) out.push(`@@ 后面 ${a.length - 1 - endA} 行没变 @@`)

  return { text: out.join('\n'), added, removed, truncated }
}

/**
 * 两个版本的 tarball 内容做逐文件比对。
 * @returns {{files:Array, summary:{added,removed,changed,unchanged}, truncated:boolean}}
 */
export function diffFileMaps(oldMap, newMap, { budgetChars = 60_000 } = {}) {
  const allPaths = new Set([...oldMap.keys(), ...newMap.keys()])
  const files = []
  let used = 0
  let truncated = false

  for (const path of [...allPaths].sort()) {
    if (isNoise(path)) continue

    const o = oldMap.get(path)
    const n = newMap.get(path)

    if (o && n && Buffer.compare(o, n) === 0) continue          // 没变，不占预算

    const oText = o ? o.toString('utf8') : null
    const nText = n ? n.toString('utf8') : null

    if (!isSource(path) && !LOW_SIGNAL.some((re) => re.test(path))) {
      // 二进制或不在白名单 → 只记一笔
      files.push({
        path,
        kind: !o ? 'added' : !n ? 'removed' : 'changed',
        binary: true,
        added: 0, removed: 0,
        diff: '',
      })
      continue
    }

    const lowSignal = LOW_SIGNAL.some((re) => re.test(path))
    let entry

    if (!o) {
      const lines = (nText ?? '').split(/\r?\n/)
      const head = lines.slice(0, 120).map((l) => '+' + l).join('\n')
      entry = {
        path, kind: 'added', lowSignal,
        added: lines.length, removed: 0,
        diff: head + (lines.length > 120 ? `\n…（新增文件共 ${lines.length} 行，只显示前 120 行）` : ''),
      }
    } else if (!n) {
      const lines = (oText ?? '').split(/\r?\n/)
      const head = lines.slice(0, 80).map((l) => '-' + l).join('\n')
      entry = {
        path, kind: 'removed', lowSignal,
        added: 0, removed: lines.length,
        diff: head + (lines.length > 80 ? `\n…（删除文件共 ${lines.length} 行，只显示前 80 行）` : ''),
      }
    } else {
      const d = lineDiff(oText ?? '', nText ?? '', { maxLines: 200 })
      entry = {
        path, kind: 'changed', lowSignal,
        added: d.added, removed: d.removed,
        diff: d.text, diffTruncated: d.truncated,
      }
    }

    // 预算控制：低信号文件（LICENSE 之类）只记名字，不给内容
    if (entry.lowSignal) entry.diff = ''
    else {
      const cost = entry.diff.length
      if (used + cost > budgetChars) {
        entry.diff = `…（超出 diff 预算，省略；这个文件改了 ${entry.added} 增 / ${entry.removed} 删 行）`
        truncated = true
      } else used += cost
    }

    files.push(entry)
  }

  const summary = {
    added: files.filter((f) => f.kind === 'added').length,
    removed: files.filter((f) => f.kind === 'removed').length,
    changed: files.filter((f) => f.kind === 'changed').length,
    linesAdded: files.reduce((s, f) => s + (f.added ?? 0), 0),
    linesRemoved: files.reduce((s, f) => s + (f.removed ?? 0), 0),
  }
  return { files, summary, truncated }
}

// ─────────────────────────────────────────────────────────────────────────────
//  changelog
// ─────────────────────────────────────────────────────────────────────────────

const CHANGELOG_NAMES = [
  'CHANGELOG.md', 'CHANGELOG.MD', 'CHANGELOG', 'CHANGES.md', 'HISTORY.md',
  'CHANGELOG.markdown', 'RELEASES.md', 'NEWS.md',
]

/** 从文件表里捞 changelog（顶层优先，其次任意层级） */
export function findChangelog(files) {
  for (const name of CHANGELOG_NAMES) {
    if (files.has(name)) return { path: name, text: files.get(name).toString('utf8') }
  }
  for (const [path, buf] of files) {
    const base = path.split('/').pop() ?? ''
    if (CHANGELOG_NAMES.includes(base.toUpperCase())) {
      return { path, text: buf.toString('utf8') }
    }
  }
  return null
}

/**
 * 从 changelog 里截出"这次更新涉及的那几段"。
 * 真实 changelog 动辄几千行，全喂进去既费钱又淹没有效信息。
 */
export function sliceChangelog(text, fromVersion, toVersion, { maxChars = 12_000 } = {}) {
  if (!text) return { text: '', sections: [] }
  const lines = text.split(/\r?\n/)

  // 找出所有版本标题行（## 1.2.3 / # [1.2.3] - 2024-01-01 / ## v1.2.3）
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,4}\s*(?:\[|v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\]|\s|-|$)/.exec(lines[i])
    if (m) heads.push({ line: i, version: m[1] })
  }
  if (heads.length === 0) {
    return { text: text.slice(0, maxChars), sections: [], note: 'changelog 里没找到版本标题，给了开头一段' }
  }

  // 取 [fromVersion, toVersion] 之间的段（from 是当前版本，本身不含）
  const picked = []
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k]
    const newer = compare(h.version, fromVersion) > 0
    const notTooNew = compare(h.version, toVersion) <= 0
    if (newer && notTooNew) {
      const start = h.line
      const end = k + 1 < heads.length ? heads[k + 1].line : lines.length
      picked.push({ version: h.version, text: lines.slice(start, end).join('\n') })
    }
  }

  if (picked.length === 0) {
    // 没匹配到（版本号对不上 / changelog 落后）→ 给最上面两段兜底
    const start = heads[0].line
    const end = heads.length > 2 ? heads[2].line : lines.length
    return {
      text: lines.slice(start, end).join('\n').slice(0, maxChars),
      sections: heads.slice(0, 2).map((h) => h.version),
      note: `没找到 ${fromVersion} → ${toVersion} 之间的段落，给了最新的两段兜底`,
    }
  }

  let out = picked.map((p) => p.text).join('\n\n')
  let truncated = false
  if (out.length > maxChars) { out = out.slice(0, maxChars); truncated = true }
  return { text: out, sections: picked.map((p) => p.version), truncated }
}

// ─────────────────────────────────────────────────────────────────────────────
//  深挖（recon 的重活）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 深挖一个包：下新旧 tarball、逐文件 diff、捞 changelog。
 * 这是"模型审查"的证据来源，也是本插件唯一会花时间和流量的地方。
 *
 * @returns {{
 *   name, from, to, bump, files, summary, changelog, truncated, error?
 * }}
 */
export async function deepDive(registry, name, fromVersion, toVersion, { signal, budgetChars } = {}) {
  const result = {
    name, from: fromVersion, to: toVersion, bump: bumpType(fromVersion, toVersion),
    files: [], summary: null, changelog: null, truncated: false, error: null,
  }
  let oldMap
  let newMap
  try {
    ;[oldMap, newMap] = await Promise.all([
      fetchTarball(registry, name, fromVersion, { signal }),
      fetchTarball(registry, name, toVersion, { signal }),
    ])
  } catch (e) {
    result.error = `下载 tarball 失败：${e?.message ?? e}`
    return result
  }

  const d = diffFileMaps(oldMap, newMap, budgetChars ? { budgetChars } : {})
  result.files = d.files
  result.summary = d.summary
  result.truncated = d.truncated

  const cl = findChangelog(newMap) ?? findChangelog(oldMap)
  if (cl) {
    const sliced = sliceChangelog(cl.text, fromVersion, toVersion)
    result.changelog = { path: cl.path, ...sliced }
  }
  return result
}

/** 给模型看的 diff 文本（已经限长，直接拼进 prompt） */
export function renderDiffForPrompt(dive, { maxChars = 40_000 } = {}) {
  if (!dive || dive.error) return `（拿不到 diff：${dive?.error ?? '未知原因'}）`
  const parts = []
  const s = dive.summary
  parts.push(`改动概览：新增 ${s.added} 个文件 / 删除 ${s.removed} 个 / 修改 ${s.changed} 个，共 +${s.linesAdded} −${s.linesRemoved} 行。`)

  // 先给"改了哪些文件"的清单 —— 这比 diff 内容更能让模型判断"动到哪儿了"
  const changed = dive.files.filter((f) => !f.lowSignal)
  if (changed.length > 0) {
    parts.push('\n涉及文件：')
    for (const f of changed.slice(0, 60)) {
      const tag = f.kind === 'added' ? '新增' : f.kind === 'removed' ? '删除' : '修改'
      parts.push(`  - [${tag}] ${f.path}${f.binary ? '（二进制）' : ` (+${f.added} −${f.removed})`}`)
    }
    if (changed.length > 60) parts.push(`  …还有 ${changed.length - 60} 个文件`)
  }

  // 再给关键文件的 diff（按改动量排序，改动大的优先 —— 那才是风险所在）
  const withDiff = changed
    .filter((f) => f.diff && !f.binary)
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed))

  let used = parts.join('\n').length
  for (const f of withDiff) {
    if (used + f.diff.length > maxChars) {
      parts.push(`\n…（剩余 ${withDiff.length - withDiff.indexOf(f)} 个文件的 diff 超出长度预算，已省略）`)
      break
    }
    parts.push(`\n── ${f.path} ──\n${f.diff}`)
    used += f.diff.length
  }
  return parts.join('\n')
}

/** 临时目录工具：跑完就删，别在主人硬盘上留垃圾 */
export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ug-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

/** 把一个文件表落到磁盘（后面 git apply 补丁要用） */
export async function materialize(files, dir) {
  for (const [rel, buf] of files) {
    const target = join(dir, ...rel.split('/'))
    await mkdir(join(target, '..'), { recursive: true }).catch(() => {})
    await writeFile(target, buf)
  }
  return dir
}

/** 给 tarball 内容算个指纹（判断"同版本内容是否被重发过"） */
export function fingerprint(files) {
  const h = createHash('sha256')
  for (const path of [...files.keys()].sort()) {
    h.update(path)
    h.update(files.get(path))
  }
  return h.digest('hex').slice(0, 16)
}
