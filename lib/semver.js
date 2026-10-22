/**
 * lib/semver.js —— 极简版本比较（**故意不依赖 semver 包**）
 * ============================================================================
 * 🔴 为什么自己写：
 *   `semver` 在主人的 profile 里碰巧有（别的包带上来的），但**发布出去别人不一定有**。
 *   为了一次版本比较去装一个 60KB 的依赖，还会在别人机器上引入"装不上就整条插件不激活"的风险。
 *   我们真正需要的只有三件事：
 *     ① 比大小（决定"有没有更新"）
 *     ② 判升降（patch / minor / major，决定审查用哪个档的模型）
 *     ③ 判范围（`^1.2.3` 这种 spec 到底覆盖不覆盖新版本）
 *   这三件事加起来不到 100 行，自己写，零依赖。
 * ============================================================================
 */

/** 解析版本串 → {major, minor, patch, pre: string[], build} ；解析不了返回 null */
export function parse(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/^[v=]+/, '')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(s)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] ?? null,
  }
}

export function isValid(v) {
  return parse(v) !== null
}

/** 只比较 core 三段（忽略 prerelease），给"同不同"用 */
export function coreEqual(a, b) {
  const pa = parse(a); const pb = parse(b)
  if (!pa || !pb) return a === b
  return pa.major === pb.major && pa.minor === pb.minor && pa.patch === pb.patch && pa.pre.join('.') === pb.pre.join('.')
}

/** -1 / 0 / 1 ；任一边解析不了就退化成字符串比较（绝不抛） */
export function compare(a, b) {
  const pa = parse(a); const pb = parse(b)
  if (!pa || !pb) return a === b ? 0 : (String(a) < String(b) ? -1 : 1)

  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  // 有 prerelease 的**小于**同版本的正式版（1.0.0-rc < 1.0.0）
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]; const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 }
    else if (nx !== ny) return nx ? -1 : 1          // 数字段 < 字母段
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 升了哪一档：'major' | 'minor' | 'patch' | 'prerelease' | 'same' | 'unknown' */
export function bumpType(from, to) {
  const pa = parse(from); const pb = parse(to)
  if (!pa || !pb) return 'unknown'
  if (pa.major !== pb.major) return 'major'
  if (pa.minor !== pb.minor) return 'minor'
  if (pa.patch !== pb.patch) return 'patch'
  if (pa.pre.join('.') !== pb.pre.join('.')) return 'prerelease'
  return 'same'
}

/** from → to 是升级吗（含同版本，便于"至少不比现在旧"的判断） */
export function isUpgrade(from, to) {
  return compare(from, to) <= 0
}

/**
 * 判断一个依赖 spec（`^1.2.3` / `~1.2` / `>=1` / `1.x` / `*` / `latest`）是否覆盖 version。
 * 只支持我们真会遇到的写法；看不懂的**返回 null**（表示"说不准"，让上层保守处理）。
 */
export function satisfies(spec, version) {
  const v = parse(version)
  if (!v) return null
  const s = String(spec ?? '').trim()
  if (!s || s === '*' || s === 'x' || s === 'latest' || s === '') return true

  // 联合范围：`^1.0.0 || ^2.0.0`
  if (s.includes('||')) return s.split('||').some((part) => satisfies(part.trim(), version))

  // `1.2.x` / `1.x` / `1.2.*`
  if (/^[\d.]+\.(x|X|\*)$/.test(s)) {
    const base = s.replace(/\.(x|X|\*)$/, '').split('.')
    if (base.length === 1) return v.major === Number(base[0])
    if (base.length === 2) return v.major === Number(base[0]) && v.minor === Number(base[1])
    return null
  }

  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(s)
  if (!m) return null

  const op = m[1] ?? '='
  const target = `${m[2]}.${m[3] ?? '0'}.${m[4] ?? '0'}${m[5] ? `-${m[5]}` : ''}`
  const cmp = compare(version, target)
  const pT = parse(target)

  switch (op) {
    case '=':
      // 允许 `=1.2` 这种省略写法匹配整个 minor 段
      if (m[4] === undefined && m[3] !== undefined) return v.major === pT.major && v.minor === pT.minor
      if (m[3] === undefined) return v.major === pT.major
      return cmp === 0
    case '>': return cmp > 0
    case '>=': return cmp >= 0
    case '<': return cmp < 0
    case '<=': return cmp <= 0
    case '~': {
      if (cmp < 0) return false
      if (m[3] === undefined) return v.major === pT.major
      return v.major === pT.major && v.minor === pT.minor
    }
    case '^': {
      if (cmp < 0) return false
      if (pT.major > 0) return v.major === pT.major
      if (pT.minor > 0) return v.major === 0 && v.minor === pT.minor
      return v.major === 0 && v.minor === 0 && v.patch === pT.patch
    }
    default: return null
  }
}

/** 从一组版本里挑最大的稳定版（没有稳定版就挑最大 prerelease） */
export function maxVersion(versions) {
  const list = (versions ?? []).filter(isValid)
  if (list.length === 0) return null
  const stable = list.filter((v) => parse(v).pre.length === 0)
  const pool = stable.length > 0 ? stable : list
  return pool.reduce((a, b) => (compare(a, b) >= 0 ? a : b))
}

/** 版本排序（升序） */
export function sortVersions(versions) {
  return [...(versions ?? [])].filter(isValid).sort(compare)
}
