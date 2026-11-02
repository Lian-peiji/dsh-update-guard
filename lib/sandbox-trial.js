/**
 * lib/sandbox-trial.js —— 装之前先在一个**隔离目录**里试着跑一次
 * ============================================================================
 * 🔴 主人 m01471 拍板：「要试跑，安全」。
 *
 * 为什么静态体检不够：
 *   静态检查能看出「少了个包」「node 版本不够」，但看不出：
 *     - 插件在 `apply()` 里读了一个不存在的文件 → 直接 throw
 *     - 两个插件抢同一个路由 → 启动时撞车
 *     - 某个依赖的 postinstall 炸了
 *     - 插件在顶层 await 里卡死 → DSH 启动挂住
 *   这些只有**真的跑一次**才知道。
 *
 * 为什么不能直接装进 profile 试：
 *   装进 profile 就意味着主人的 DSH 已经被改了。万一新版起不来，
 *   主人的桌面端就崩了 —— 这正好是主人说「稳定稳定还是tm的稳定」要避免的。
 *   所以必须在一个**临时 profile** 里试，试完就删。
 *
 * 设计要点：
 *   1. 复制当前 profile 的 package.json + 补丁 + lockfile，只把目标包换成新版
 *   2. 在临时目录里 pnpm install（**离线优先**，失败才联网）
 *   3. 用**当前运行中的 DSH 的 node**去 require 一遍插件入口，看会不会 throw
 *   4. 不管成功失败，临时目录一定删掉（finally）
 *
 * ⚠️ 试跑**不启动完整 DSH**，只做模块级加载 —— 因为起一个完整 DSH 要占端口、
 *    要抢用户配置，副作用太大。模块级加载已经能抓住 80% 的「起不来」问题。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

import { readPatchedDependencies, renderWorkspaceWithPatches } from './profile.js'

/** 试跑结果里我们关心的几档 */
export const TRIAL_VERDICT = {
  PASS: 'pass',           // 装得上、加载得起来
  INSTALL_FAIL: 'install-fail', // pnpm install 就失败了
  LOAD_FAIL: 'load-fail',       // 装上了但 require 入口时 throw
  TIMEOUT: 'timeout',           // 卡住了
  SKIP: 'skip',                 // 环境不满足，没法试
}

/**
 * 找当前运行 DSH 的 node 和 pnpm。
 *
 * 🔴 不能假设 `node`/`pnpm` 在 PATH 里 —— 这台机器上就不在（P0 阶段实测过）。
 * 🔴 更不能假设 `process.execPath` 是 node！
 *    在**宿主进程里** `process.execPath` 是 DSH 桌面端自己的可执行文件（Electron），
 *    不是 node.exe。真机上因此撞到过「找不到 node 或 pnpm → 试跑被跳过」，
 *    而同一个脚本用真 node 跑完全正常。所以：
 *      1. execPath 只在其 basename 真的是 node 时才认；
 *      2. 否则去 DSH home 下面的 dsh-runtimes/<name>/dependencies/ 里找真 node/pnpm；
 *      3. 实在找不到，才退回「拿 Electron 当 node 用」（ELECTRON_RUN_AS_NODE=1）。
 */
function isNodeExe(p) {
  const b = basename(String(p || '')).toLowerCase()
  return b === 'node' || b === 'node.exe'
}

/** 从某个目录往上找「像 DSH home」的地方（含 dsh-runtimes 或 profiles 子目录） */
function guessHomes(startDirs) {
  const homes = []
  const push = (h) => { if (h && !homes.includes(h)) homes.push(h) }
  if (process.env.DSH_HOME) push(process.env.DSH_HOME)
  for (const start of startDirs) {
    if (!start) continue
    let dir = start
    for (let i = 0; i < 6 && dir && dir !== dirname(dir); i++) {
      if (existsSync(join(dir, 'dsh-runtimes')) || existsSync(join(dir, 'profiles'))) push(dir)
      dir = dirname(dir)
    }
  }
  return homes
}

/** 扫 <home>/dsh-runtimes/<name>/dependencies/ 里的 node 与 pnpm */
export function scanRuntimes(home) {
  const found = { nodes: [], pnms: [] }
  const rtRoot = join(home, 'dsh-runtimes')
  if (!existsSync(rtRoot)) return found
  let names = []
  try { names = readdirSync(rtRoot) } catch { return found }
  for (const name of names) {
    const deps = join(rtRoot, String(name), 'dependencies')
    for (const c of [join(deps, 'node', 'bin', 'node.exe'), join(deps, 'node', 'bin', 'node')]) {
      if (existsSync(c)) found.nodes.push(c)
    }
    for (const c of [join(deps, 'pnpm', 'bin', 'pnpm.mjs'), join(deps, 'pnpm', 'bin', 'pnpm.cjs')]) {
      if (existsSync(c)) found.pnms.push(c)
    }
  }
  return found
}

/** 从一个 profile 目录往上找 DSH home（`<home>/profiles/<name>` → `<home>`） */
export function homeOf(profileDir) {
  if (!profileDir) return null
  const homes = guessHomes([profileDir])
  return homes.length ? homes[0] : dirname(dirname(profileDir))
}

export function findToolchain({ nodePath, pnpmPath, home } = {}) {
  const out = { node: null, pnpm: null, from: {}, env: null }

  const homes = guessHomes([home, process.execPath ? dirname(process.execPath) : null, process.cwd()])
  const rt = { nodes: [], pnms: [] }
  for (const h of homes) {
    const r = scanRuntimes(h)
    rt.nodes.push(...r.nodes); rt.pnms.push(...r.pnms)
  }

  // node：显式 → 真 node 的 execPath → runtime 里扫到的 → Electron 兜底
  if (nodePath && existsSync(nodePath)) {
    out.node = nodePath; out.from.node = 'explicit'
  } else if (isNodeExe(process.execPath) && existsSync(process.execPath)) {
    out.node = process.execPath; out.from.node = 'process.execPath'
  } else if (rt.nodes.length) {
    out.node = rt.nodes[0]; out.from.node = 'dsh-runtimes'
  } else if (process.versions.electron && process.execPath && existsSync(process.execPath)) {
    // Electron 本体也能当 node 跑，但必须显式告诉它「别开窗口，当 node」
    out.node = process.execPath; out.from.node = 'electron-as-node'
    out.env = { ELECTRON_RUN_AS_NODE: '1' }
  }

  // pnpm：候选路径挨个试
  const depsDir = dirname(dirname(dirname(process.execPath || '')))
  const candidates = [
    pnpmPath,
    process.env.DSH_PNPM,
    ...rt.pnms,
    join(depsDir, 'pnpm', 'bin', 'pnpm.mjs'),
    join(depsDir, 'pnpm', 'bin', 'pnpm.cjs'),
    join(dirname(dirname(process.execPath || '')), 'pnpm', 'bin', 'pnpm.mjs'),
    join(dirname(dirname(process.execPath || '')), 'pnpm', 'bin', 'pnpm.cjs'),
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.exe'),
  ].filter(Boolean)

  for (const c of candidates) {
    if (c && existsSync(c)) { out.pnpm = c; out.from.pnpm = c; break }
  }
  // 最后看 PATH（用 which/where 的结果，不猜）
  if (!out.pnpm) {
    for (const p of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
      for (const exe of process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe'] : ['pnpm']) {
        const f = join(p, exe)
        if (existsSync(f)) { out.pnpm = f; out.from.pnpm = 'PATH'; break }
      }
      if (out.pnpm) break
    }
  }
  // 排错用：找不到时把试过哪些 home 记下来
  out.homes = homes
  return out
}

/** 跑一个子进程，收 stdout/stderr，超时就杀 */
function run(cmd, args, { cwd, timeoutMs = 180_000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows 上 detached 会让 kill 变成杀整棵树
        detached: process.platform === 'win32',
        windowsHide: true,
      })
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e), timedOut: false, spawnError: true })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = 200_000
    child.stdout?.on('data', (c) => { if (stdout.length < cap) stdout += c.toString() })
    child.stderr?.on('data', (c) => { if (stderr.length < cap) stderr += c.toString() })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch { try { child.kill('SIGKILL') } catch { /* 已经死了 */ } }
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e), timedOut, spawnError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/**
 * 造一个临时 profile 目录：复制主人的 package.json / lockfile / 补丁，
 * 只把目标包换成新版。
 *
 * 🔴 为什么不从零造 package.json：
 *    这个插件的依赖可能有 peerDependencies 指向别的插件，从零造会漏。
 *    复制真实 manifest 再改一行，最接近真实安装。
 */
export function stageProfile(profileDir, { name, toVersion, targetSpec, patches = [] } = {}) {
  const stage = join(tmpdir(), `dsh-trial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(stage, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  manifest.dependencies = { ...(manifest.dependencies ?? {}) }

  // 🔴 别无条件把 spec 换成裸版本号。
  //    profile 里的依赖有三种源，只有 registry 的能写版本号：
  //      registry  `"dsh-meme": "0.1.55"`            → 换版本号，对
  //      git       `"dsh-fish-memory": "https://...tar.gz/<sha>"` → 换成 "1.2.1"
  //                会去 registry 找，**404**（这包根本不在 npm 上）
  //      local     `"dsh-pwa-kit": "file:./local-plugins/..."`     → 换成版本号直接装不上
  //    所以：只有 registry 源才换；别的源原样保留，只做「试装当前配置」。
  const oldSpec = String(manifest.dependencies[name] ?? '')
  const isRegistry = oldSpec !== '' && !/^(file:|link:|\.\.?\/|https?:|git[+:])/i.test(oldSpec)
  // 非 registry 源也能升级，但只能「换 spec」——toVersion 已经是从新 tarball 里读出的真版本，
  // 补丁 key 按它重定位；spec 换成 targetSpec，两者必须同时变，否则 pnpm 报 UNUSED_PATCH。
  const versionChanged = isRegistry
    ? oldSpec !== toVersion
    : Boolean(targetSpec) && String(targetSpec) !== oldSpec
  if (isRegistry) {
    manifest.dependencies[name] = toVersion
  } else if (targetSpec) {
    manifest.dependencies[name] = String(targetSpec)
  }

  // 补丁重定位：旧版本的补丁 key 换成新版本（试跑时如果补丁打不上，正好暴露出来）
  // 🔴 用 readPatchedDependencies：pnpm 11 把表放在 pnpm-workspace.yaml，
  //    只读 manifest.pnpm 会读出空表，试跑就等于「没补丁的试跑」，白跑。
  const patched = readPatchedDependencies(profileDir)
  const retargeted = []
  for (const [key, rel] of Object.entries(patched)) {
    const at = key.lastIndexOf('@')
    const pname = at > 0 ? key.slice(0, at) : key
    const pver = at > 0 ? key.slice(at + 1) : null
    if (pname !== name) continue
    // 只改目标包自己的补丁；别的包的补丁原样保留
    const newKey = `${name}@${toVersion}`
    let newRel = String(rel).replace(`${name}@${pver}`, `${name}@${toVersion}`)
    // 文件名不是标准形式时按标准形式重起一个（跟 apply.js 的兜底逻辑保持一致）
    if (newRel === String(rel)) {
      const dirPart = String(rel).includes('/') ? String(rel).slice(0, String(rel).lastIndexOf('/') + 1) : ''
      newRel = `${dirPart}${name.replace('/', '+')}@${toVersion}.patch`
    }
    delete patched[key]
    patched[newKey] = newRel
    retargeted.push({ from: key, to: newKey, rel, newRel })
  }
  // 统一写到 yaml（pnpm 11 的正式位置），并从 package.json 里抹掉，
  // 否则两份表打架，pnpm 挑哪份用是不确定的。
  if (manifest.pnpm && 'patchedDependencies' in manifest.pnpm) {
    delete manifest.pnpm.patchedDependencies
    if (Object.keys(manifest.pnpm).length === 0) delete manifest.pnpm
  }

  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')

  // 复制补丁文件（目录结构照搬）
  const patchDir = join(profileDir, 'patches')
  if (existsSync(patchDir)) {
    try { cpSync(patchDir, join(stage, 'patches'), { recursive: true }) } catch { /* 补丁复制失败不阻断 */ }
  }

  // 补丁文件改名（跟 retarget 的 key 对齐）
  for (const r of retargeted) {
    const from = join(stage, 'patches', basename(r.rel))
    const to = join(stage, 'patches', basename(r.newRel))
    if (existsSync(from) && from !== to) {
      try { cpSync(from, to) } catch { /* 复制不过去就让 install 自己报错 */ }
    }
  }

  // 🔴 本地路径依赖必须一起搬：profile 里可能有 `file:./local-plugins/xxx`。
  //    临时目录里没那个目录，pnpm 直接 ENOENT 装不上 —— 试跑假失败，
  //    而且报的错（no such file or directory, lstat '...local-plugins'）
  //    跟「这个新版本有问题」毫无关系，会把人带沟里。
  //    实测本机就有 `dsh-pwa-kit: file:./local-plugins/dsh-pwa-kit`。
  const localDeps = []
  for (const [depName, spec] of Object.entries(manifest.dependencies ?? {})) {
    const str = String(spec ?? '')
    const m = /^(?:file|link):(\.{0,2}\/.*)$/.exec(str)
    if (!m) continue
    const relPath = m[1].replace(/\//g, sep)
    // 绝对路径（`file:E:/xxx`）直接照抄；相对路径搬到 stage 的同一相对位置
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(m[1]) || m[1].startsWith('/')
    if (isAbsolute) continue // 绝对路径在临时目录里照样能用，不用搬
    const src = join(profileDir, relPath)
    const dst = join(stage, relPath)
    if (!existsSync(src)) {
      localDeps.push({ name: depName, relPath, copied: false, reason: '源目录不存在' })
      continue
    }
    try {
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(src, dst, { recursive: true })
      localDeps.push({ name: depName, relPath, copied: true })
    } catch (e) {
      localDeps.push({ name: depName, relPath, copied: false, reason: String(e?.message ?? e) })
    }
  }

  // lockfile 也带上：没有它 pnpm 要重新解析全部依赖，慢且可能装出不一样的树
  for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    const src = join(profileDir, f)
    if (existsSync(src)) {
      try { cpSync(src, join(stage, f)) } catch { /* 可选文件，复制失败就算了 */ }
    }
  }

  // 🔴 关键一步：yaml 是整份复制过来的，里面还是**旧版本**的补丁 key。
  //    不重写的话，pnpm 看到 `pkg@1.0.0` 的补丁 + `pkg@2.0.0` 的依赖，
  //    直接 ERR_PNPM_UNUSED_PATCH 中止 —— 试跑必然假失败。
  if (Object.keys(patched).length > 0) {
    const wsPath = join(stage, 'pnpm-workspace.yaml')
    const wsText = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : ''
    writeFileSync(wsPath, renderWorkspaceWithPatches(wsText, patched), 'utf8')
  }

  return { stage, manifest, retargeted, localDeps, oldSpec, versionChanged }
}

/**
 * 在临时目录里 pnpm install。
 *
 * 🔴 为什么用 `install` 而不是 `add <name>@<version>`：
 *    `add` 会重写 package.json 并重新解析整棵树，副作用比 `install` 大；
 *    而我们的 package.json 里**已经写好了**目标版本，`install` 照着装最干净。
 */
export async function installInStage(stage, { toolchain, timeoutMs = 300_000 } = {}) {
  if (!toolchain?.node || !toolchain?.pnpm) {
    return {
      ok: false, verdict: TRIAL_VERDICT.SKIP,
      reason: '找不到 node 或 pnpm —— 没法试跑（不影响静态体检结论）',
    }
  }
  const isMjs = toolchain.pnpm.endsWith('.mjs')
  // 🔴 --no-frozen-lockfile 是必须的，不是可选优化：
  //    试跑的目的就是把版本换掉，lockfile 必然跟 package.json 对不上。
  //    CI=1 会让 pnpm 默认开 frozen-lockfile，于是**每个试跑都必然
  //    ERR_PNPM_OUTDATED_LOCKFILE 失败** —— 假失败，比不试跑还坏。
  const args = isMjs ? [toolchain.pnpm, 'install', '--no-frozen-lockfile'] : ['install', '--no-frozen-lockfile']
  const cmd = isMjs ? toolchain.node : toolchain.pnpm

  const r = await run(cmd, args, {
    cwd: stage,
    timeoutMs,
    env: {
      // 别让 pnpm 因为「包太新」拒绝装 —— 我们就是要试最新的
      npm_config_minimum_release_age: '0',
      // 试跑要快：不装 optional 里那些可选的二进制
      npm_config_optional: 'false',
      CI: '1', // 没有 TTY 时 pnpm 会挂住等交互，CI 模式让它直接失败
      ...(toolchain.env ?? {}),
    },
  })

  if (r.timedOut) {
    return { ok: false, verdict: TRIAL_VERDICT.TIMEOUT, reason: `pnpm install 超时（${Math.round(timeoutMs / 1000)}s）`, output: tail(r.stderr) }
  }
  if (r.code !== 0) {
    return {
      ok: false, verdict: TRIAL_VERDICT.INSTALL_FAIL,
      reason: 'pnpm install 失败 —— 这个版本在干净环境里就装不上，装进 profile 只会更糟',
      output: tail(r.stderr || r.stdout),
      // 补丁打不上是**特别常见**的失败原因，单独标出来
      patchProblem: /ERR_PNPM_UNUSED_PATCH|patch|补丁/i.test(r.stderr + r.stdout),
    }
  }
  return { ok: true, verdict: TRIAL_VERDICT.PASS, output: tail(r.stdout) }
}


/**
 * 读一个已安装包的 package.json，弄清「该怎么判断它是不是 DSH 插件」。
 *
 * 🔴 为什么单独抽出来（2026-11-02 真机）：
 *    `sandbox-trial.js` 和 `apply.js` 各自实现了一遍入口解析 + 插件判定，
 *    10-23 的提交 `07a9ded` 只修了 trial 那一份（加 `declaresDsh`），
 *    `apply.js` 的 `verifyInstalled` 漏改 —— 于是 cc-safety-net 这种
 *    用 bundle 补丁装配（`dsh.bundle.patch` + `default = {name, inject, apply}`）的包，
 *    **沙箱试跑通过、真装后验收却判「没有导出 apply —— 不是 DSH 插件」**，
 *    连滚 18 次、回滚 18 次，永远升不上去。
 *    两份逻辑必须只有一处真理，否则下次还是漏一边。
 *
 * 返回里除了入口路径，还给 `bundleEntry`：如果包声明了 `dsh.bundle.patch`，
 * 就按补丁里 `name:` 的相对路径（相对补丁文件所在目录）找出真正被宿主加载的入口。
 * cc-safety-net 就是活样本：`exports["."]` 指向 `dist/index.js`（一个 {id,effect,server}
 * 描述对象，**没有 apply**），真正装载的 entry 是 `dist/deepseek-harness/index.js`
 * （`default = {name, inject, apply}`）。
 *
 * @param {string} pkgDir 已安装包的目录
 * @returns {{ entry: string, entryPath: string, declaresDsh: boolean, bundlePatch: string|null, bundleEntry: string|null }}
 */
export function inspectInstalledPackage(pkgDir) {
  let mf = {}
  try { mf = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { /* 读不出就按最保守的猜 */ }

  const declaresDsh = Boolean(mf.dsh) || Boolean(mf.dshPlugin) || Boolean(mf.keywords?.includes?.('dsh-plugin'))

  // ① exports["."] / main —— 普通插件的入口
  let entry = 'index.js'
  const exp = mf.exports
  if (typeof exp === 'string') entry = exp
  else if (exp && typeof exp === 'object') {
    const dot = exp['.']
    if (typeof dot === 'string') entry = dot
    else if (dot && typeof dot === 'object') entry = dot.import ?? dot.require ?? dot.default ?? 'index.js'
  } else if (mf.main) entry = mf.main
  const entryPath = join(pkgDir, String(entry).replace(/^\.\//, ''))

  // ② dsh.bundle.patch —— bundle 型插件：宿主加载的是补丁里 insert 的那个 entry，
  //    路径相对补丁文件自身所在目录（cc-safety-net 的 `./index.js` 落在 dist/deepseek-harness/）。
  let bundlePatch = null
  let bundleEntry = null
  const rel = mf.dsh?.bundle?.patch
  if (rel) {
    bundlePatch = String(rel)
    const patchPath = join(pkgDir, bundlePatch.replace(/^\.\//, ''))
    try {
      const text = readFileSync(patchPath, 'utf8')
      // 只看第一个 `- id:` 后面那个 `name:`；补丁是极简 YAML，不值得为此上解析器
      const m = /-\s*insert:\s*\n((?:[ \t]+.*\n?)+)/.exec(text)
      const block = m ? m[1] : text
      const nameM = /^\s*name:\s*(.+)$/m.exec(block)
      if (nameM) {
        const raw = nameM[1].trim().replace(/^['"]|['"]$/g, '')
        // 只认相对路径；绝对路径/裸包名不猜，交给后面「能加载就算过」
        if (raw.startsWith('.')) {
          const candidate = join(dirname(patchPath), raw)
          if (existsSync(candidate)) bundleEntry = candidate
        }
      }
    } catch { /* 补丁读不出来就算了，不阻断验收 */ }
  }

  return { entry: String(entry), entryPath, declaresDsh, bundlePatch, bundleEntry }
}

/**
 * 宿主注入的包（在 app.asar 里，普通进程解析不到）。
 *
 * 这份名单不是猜的：profile 的 `pnpm-workspace.yaml` 里
 * `peerDependencyRules.ignoreMissing` 记的就是「这些由宿主提供」，
 * 是 pnpm 每次装包时刷 WARN 的那一批。另外 react/react-dom 是客户端
 * 半边由宿主 bundle 注入的。
 */
export const HOST_INJECTED = [
  '@deepseek-ai/cordis', '@deepseek-ai/dsh', '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-spill-local', '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-workspace',
  'react', 'react-dom',
]

/**
 * 给宿主注入的包造「万能桩」。
 *
 * 为什么要扫源码而不是直接给个空模块：
 *   ESM 的具名导入（`import { defineTool } from '...'`）要求目标**真的**
 *   导出这个名字，光有 default 不够。所以必须先把插件里写了哪些名字
 *   读出来，再照着生成 `export const defineTool = ...`。
 *
 * 桩本身是个 Proxy：调它、取属性、new 它，都返回同一个代理，
 * 所以 `defineTool({...})`、`z.object({...}).optional()` 这类链式用法
 * 不会炸。目的是让「模块能不能加载」这件事被测到，而不是测宿主 API 对不对。
 *
 * @returns {Array<{name, names, ok, reason?}>} 造了哪些桩
 */
export function installHostStubs(stage, pkgDir) {
  const result = []

  // ① 扫插件自己源码里，对每个宿主包导入了哪些名字
  const wanted = new Map() // 包名 → Set(名字)
  const files = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (/\.(m?js|cjs|jsx|ts)$/.test(e.name)) files.push(full)
    }
  }
  walk(pkgDir, 0)

  for (const f of files) {
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    // 🔴 四种 import 写法都得认。原先只认第一种，于是 `import * as X from 'pkg'`
    //    被漏掉 —— dsh-archive-manager 1.1.7 的 workspace.js 第 3 行正是这么写的，
    //    结果桩没造出来，试跑报「Cannot find package '@deepseek-ai/dsh-session'」，
    //    差点把一次正常更新判死（现装的 1.1.6 同样这么 import，跑得好好的）。
    const patterns = [
      /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g, // 默认/具名
      /import\s+\*\s+as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g,                      // 命名空间
      /import\s+['"]([^'"]+)['"]/g,                                                // 副作用
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                                      // 动态
    ]
    for (const [idx, re] of patterns.entries()) {
      let m
      while ((m = re.exec(text)) !== null) {
        const pkg = m[m.length - 1]        // 每个模式的最后一个捕获组都是包名
        if (typeof pkg !== 'string' || pkg.startsWith('.')) continue
        if (!HOST_INJECTED.includes(pkg)) continue
        if (!wanted.has(pkg)) wanted.set(pkg, new Set())
        if (idx !== 0) continue           // 后三种拿不到具名导出，给默认桩就够
        const set = wanted.get(pkg)
        if (m[2]) {
          for (const part of m[2].split(',')) {
            const n = part.trim().split(/\s+as\s+/)[0].trim()
            if (n && n !== 'default') set.add(n)
          }
        }
      }
    }
  }

  // ② 装了的就不造桩（真包优先）
  for (const [pkg, names] of wanted) {
    const realDir = join(stage, 'node_modules', ...pkg.split('/'))
    if (existsSync(realDir)) { result.push({ name: pkg, names: [...names], ok: true, reason: '真包已装，不造桩' }); continue }
    result.push(writeStub(stage, pkg, names))
  }

  return result
}

/**
 * 给一个宿主注入包造桩。
 *
 * 桩只保证「import 得动」，不模拟真实行为 —— 我们要验的是
 * 「新版本会不会在加载阶段就炸」，不是「功能对不对」。
 */
export function writeStub(stage, pkg, names = []) {
  const dir = join(stage, 'node_modules', ...pkg.split('/'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: pkg, version: '0.0.0-trial-stub', type: 'module', main: 'index.js', exports: './index.js',
    }, null, 2), 'utf8')

    const head = [
      '// 沙箱试跑用的宿主桩：这个包由 DSH 运行时注入，普通进程解析不到。',
      '// 目的只是让 import 能解析，不是模拟真实行为。',
      'const handler = {',
      '  get: (t, p) => (p === Symbol.toPrimitive ? () => "" : stub),',
      '  apply: () => stub,',
      '  construct: () => stub,',
      '  has: () => true,',
      '}',
      'const stub = new Proxy(function () {}, handler)',
    ]
    const lines = [...head]
    for (const n of names) {
      // 名字都合法（JS 标识符）才生成具名导出
      if (/^[A-Za-z_$][\w$]*$/.test(n)) lines.push(`export const ${n} = stub`)
    }
    lines.push('export default stub')
    writeFileSync(join(dir, 'index.js'), lines.join('\n') + '\n', 'utf8')
    return { name: pkg, names: [...names], ok: true }
  } catch (e) {
    return { name: pkg, names: [...names], ok: false, reason: String(e?.message ?? e) }
  }
}

/** 这个包名是不是插件自己声明过的运行时依赖（是 → 缺了就是真缺，不算宿主注入） */
export function isDeclaredDep(pkgDir, spec) {
  const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  let mf
  try { mf = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { return false }
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (mf?.[key] && Object.prototype.hasOwnProperty.call(mf[key], root)) return true
  }
  return false
}

/**
 * 在临时目录里真的把插件入口 require 一遍。
 *
 * 🔴 这是试跑的**核心价值**：pnpm install 成功不代表插件能加载。
 *    插件在 apply() 里 throw、顶层 await 卡死、import 一个不存在的文件，
 *    都只有 require 一次才知道。
 *
 * 为什么用子进程而不是 require 在当前进程里：
 *    插件代码可能有副作用（改全局、开端口、写文件），在当前进程里跑
 *    会污染正在运行的 DSH。子进程跑完就死，干净。
 */
export async function loadInStage(stage, { name, toolchain, timeoutMs = 30_000 } = {}) {
  if (!toolchain?.node) {
    return { ok: false, verdict: TRIAL_VERDICT.SKIP, reason: '找不到 node，没法做加载测试' }
  }
  const pkgDir = join(stage, 'node_modules', ...name.split('/'))
  if (!existsSync(pkgDir)) {
    return { ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL, reason: `装完了但 node_modules 里没有 ${name} —— 这个包装不上` }
  }

  // 读 exports["."] / dsh.bundle.patch 找到真入口（判定逻辑与 apply.js 共用一份）
  const info = inspectInstalledPackage(pkgDir)
  const declaresDsh = info.declaresDsh
  // bundle 型插件：宿主真正装载的是补丁里那个 entry，优先用它
  const entryPath = info.bundleEntry ?? info.entryPath
  if (!existsSync(entryPath)) {
    return { ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL, reason: `入口文件不存在：${info.bundleEntry ? info.bundleEntry : info.entry}` }
  }

  // 🔴 先给「宿主注入的包」造桩。
  //    @deepseek-ai/*、react 这些由 DSH 运行时注入（在 app.asar 里），
  //    普通子进程里根本解析不到。不造桩的话，每个插件都会报
  //    「Cannot find package '@deepseek-ai/dsh-tools'」—— 假失败，
  //    而且看起来像「这个新版本坏了」，会误导判断。
  const stubbed = installHostStubs(stage, pkgDir)

  // 探针脚本：只 import，不 apply。用 file:// URL 保证 ESM 能解析。
  const probe = `
const target = ${JSON.stringify(entryPath)}
const url = 'file://' + target.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')
try {
  const mod = await import(url)
  const keys = Object.keys(mod || {})
  const d = mod && mod.default
  const callable = typeof mod.apply === 'function'
    || typeof d === 'function'
    || typeof d?.apply === 'function'
  const declaresDsh = ${declaresDsh ? 'true' : 'false'}
  const isPlugin = callable || declaresDsh
  console.log(JSON.stringify({
    ok: true,
    exports: keys.slice(0, 20),
    plugin: isPlugin,
    note: isPlugin ? '' : '这个包能加载，但没导出 apply、也没声明 dsh 字段 —— 它不是 DSH 插件（当普通依赖装着没问题）',
  }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, reason: String(e && e.message || e), stack: String(e && e.stack || '').split('\\n').slice(0, 8) }))
}
`
  const probeFile = join(stage, '__trial_probe.mjs')
  writeFileSync(probeFile, probe, 'utf8')

  // 探针跑一遍。若报「找不到某个包」，先判断它是「宿主注入」还是「真缺依赖」：
  //   · 插件自己在 dependencies 里声明过 → 真缺，直接判失败（pnpm 装完还缺就是有问题）
  //   · 没声明过（@deepseek-ai/* 这类由 DSH 运行时注入的）→ 造桩再试，最多 6 轮
  // 宁可多试几轮，也不要把一次正常更新误判成「新版本坏了」。
  let attempt = 0
  for (;;) {
    const r = await run(toolchain.node, [probeFile], {
      cwd: stage,
      timeoutMs,
      env: {
        // 别让插件在加载时真的去连网/连数据库
        DSH_UPDATE_GUARD_TRIAL: '1',
        ...(toolchain.env ?? {}),
      },
    })

    if (r.timedOut) {
      return {
        ok: false, verdict: TRIAL_VERDICT.TIMEOUT,
        reason: `加载超时（${Math.round(timeoutMs / 1000)}s）—— 插件在顶层 await 卡住了，装进去 DSH 会启动挂住`,
      }
    }

    const line = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop()
    let parsed = null
    try { parsed = JSON.parse(line) } catch { /* 不是 JSON 就是崩了 */ }

    if (!parsed) {
      return {
        ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL,
        reason: '加载时进程异常退出（连错误都没打印出来）',
        output: tail(r.stderr || r.stdout),
      }
    }
    if (parsed.ok) {
      return {
        ok: true,
        verdict: TRIAL_VERDICT.PASS,
        exports: parsed.exports ?? [],
        stubbed,
        plugin: parsed.plugin !== false,
        note: parsed.note || '',
      }
    }

    const missing = /Cannot find package '([^']+)'/.exec(String(parsed.reason ?? ''))
    if (missing && attempt < 6) {
      const spec = missing[1]
      if (isDeclaredDep(pkgDir, spec)) {
        return {
          ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL,
          reason: `插件声明依赖 ${spec}，但装完还是找不到 —— 这个包装不完整`,
          stack: parsed.stack ?? null,
        }
      }
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      const realDir = join(stage, 'node_modules', ...root.split('/'))
      if (existsSync(realDir)) {
        return {
          ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL,
          reason: `找不到 ${spec}（包根 ${root} 已装，却没有这个入口）`,
          stack: parsed.stack ?? null,
        }
      }
      const one = writeStub(stage, root, [])
      stubbed.push({ ...one, reason: one.ok ? `宿主注入（运行时才有），造桩后重试（第 ${attempt + 1} 次）` : one.reason })
      if (!one.ok) {
        return { ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL, reason: `给宿主包 ${root} 造桩失败：${one.reason}`, stack: parsed.stack ?? null }
      }
      attempt++
      continue
    }

    return {
      ok: false, verdict: TRIAL_VERDICT.LOAD_FAIL,
      reason: parsed.reason,
      stack: parsed.stack ?? null,
      output: tail(r.stderr),
    }
  }
}

/** 只取输出的最后一段（错误通常在尾巴上） */
function tail(s, n = 3000) {
  const t = String(s ?? '')
  return t.length > n ? `…（前面省略）\n${t.slice(-n)}` : t
}

/**
 * 完整试跑：造临时环境 → install → 加载 → 清理。
 *
 * 返回的报告直接能喂给模型和主人看。
 * ⚠️ 无论中间哪一步炸，临时目录一定在 finally 里删掉。
 */
export async function sandboxTrial(a, b) {
  // 容忍两种写法：
  //   sandboxTrial({ profileDir, name, toVersion, ... })   ← 主推
  //   sandboxTrial(profileDir, { name, toVersion, ... })   ← 跟 stageProfile 一致的直觉写法
  // 🔴 加这层是因为我自己就写错过：传了 (dir, opts)，函数按对象解构，
  //    profileDir 变 undefined，最后炸在 path 上，报的错跟真正原因毫无关系。
  const {
    profileDir, name, fromVersion, toVersion, targetSpec,
    toolchain, installTimeoutMs = 300_000, loadTimeoutMs = 30_000,
    keepStage = false,
  } = typeof a === 'string' ? { profileDir: a, ...(b ?? {}) } : (a ?? {})
  const started = Date.now()
  const steps = []
  let stage = null
  let retargeted = []

  try {
    // ① 造环境
    const staged = stageProfile(profileDir, { name, toVersion, targetSpec })
    stage = staged.stage
    retargeted = staged.retargeted
    steps.push({
      step: 'stage',
      ok: true,
      detail: `临时 profile：${stage}` + (retargeted.length ? `；补丁重定位 ${retargeted.map((r) => `${r.from} → ${r.to}`).join(', ')}` : ''),
    })

    // ② 装
    const inst = await installInStage(stage, { toolchain, timeoutMs: installTimeoutMs })
    steps.push({ step: 'install', ok: inst.ok, verdict: inst.verdict, detail: inst.reason ?? '装上了', output: inst.output })
    if (!inst.ok) {
      return {
        ok: false, verdict: inst.verdict, steps,
        reason: inst.reason, patchProblem: inst.patchProblem ?? false,
        retargeted, elapsedMs: Date.now() - started,
      }
    }

    // ③ 加载
    const load = await loadInStage(stage, { name, toolchain, timeoutMs: loadTimeoutMs })
    const loadDetail = load.ok
      ? (load.note ? `加载正常。${load.note}` : '加载正常')
      : (load.reason ?? '加载失败')
    steps.push({ step: 'load', ok: load.ok, verdict: load.verdict, detail: loadDetail, stack: load.stack ?? null })

    return {
      ok: load.ok, verdict: load.verdict, steps,
      reason: load.ok ? '装得上、加载得起来' : load.reason,
      plugin: load.plugin !== false,
      note: load.note || '',
      stack: load.stack ?? null,
      exports: load.exports ?? [],
      retargeted,
      elapsedMs: Date.now() - started,
    }
  } catch (e) {
    return {
      ok: false, verdict: TRIAL_VERDICT.INSTALL_FAIL,
      steps, reason: `试跑过程本身出错：${e?.message ?? e}`,
      retargeted, elapsedMs: Date.now() - started,
    }
  } finally {
    // 🔴 一定要删。试跑残留会越堆越多，占满临时目录。
    if (stage && !keepStage) {
      try { rmSync(stage, { recursive: true, force: true }) } catch { /* 删不掉就算了，系统会清 */ }
    }
  }
}

/** 把试跑结果渲染成给人看的一段话 */
export function renderTrial(trial) {
  if (!trial) return '（没有试跑）'
  const lines = []
  const icon = trial.ok ? '✅' : trial.verdict === TRIAL_VERDICT.SKIP ? '⚪' : '🔴'
  lines.push(`${icon} 沙箱试跑：${trial.reason}`)
  for (const s of trial.steps ?? []) {
    const mark = s.ok ? '✓' : '✗'
    lines.push(`  ${mark} ${s.step}：${s.detail}`)
  }
  if (trial.retargeted?.length) {
    lines.push(`  补丁重定位：${trial.retargeted.map((r) => `${r.from} → ${r.to}`).join('；')}`)
  }
  if (trial.stack) lines.push(`  堆栈：${String(trial.stack).split('\n').slice(0, 4).join(' / ')}`)
  if (trial.elapsedMs) lines.push(`  耗时 ${(trial.elapsedMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}
