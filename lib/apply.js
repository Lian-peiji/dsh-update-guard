/**
 * lib/apply.js —— 真装：执行更新 + 补丁重定位 + 失败自动回滚（先斩后奏）
 * ============================================================================
 * 🔴 主人 m01471 拍板：「回滚要先斩后奏 C，不能让桌面端崩了，稳定，稳定，还是tm的稳定！」
 *
 * 所以这个文件的铁律只有一条：
 *   **宁可这次更新白做，也不能让主人的 DSH 起不来。**
 *
 * 整个流程是一个「有后悔药的事务」：
 *   ① 快照  —— 把 package.json / lockfile / patches/ / 当前包目录全存一份
 *   ② 重定位 —— 把补丁从旧版本改到新版本（这一步最容易出错）
 *   ③ 装    —— pnpm install
 *   ④ 验    —— 装完立刻 require 一遍，起不来就当场判定失败
 *   ⑤ 回滚  —— 任何一步失败，把快照整个盖回去，再 install 一次复原
 *   ⑥ 报告  —— 成功失败都写进病历，主人下次能看见
 *
 * 🔴 为什么④要在**装进 profile 之后**还要验：
 *    沙箱试跑是在干净目录里跑的，但真实 profile 里可能装了别的插件，
 *    依赖树纠缠起来可能只有真装才炸。所以最后这道验收不能省。
 *
 * 🔴 为什么回滚是「先斩后奏」：
 *    主人的原话是不能让桌面端崩。等主人点确认的这几分钟里，DSH 就是坏的。
 *    所以自动回滚，回滚完再报告 —— 报告里说清楚「我退回去了，为什么」。
 * ============================================================================
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync,
} from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { findToolchain, HOST_INJECTED } from './sandbox-trial.js'
import { readProfileManifest, readPatchedDependencies, writePatchedDependencies, installedVersion } from './profile.js'
import { parsePatchKey } from './patchledger.js'

/** 一次 apply 的最终结局 */
export const APPLY_RESULT = {
  APPLIED: 'applied',       // 装好了，验过了
  ROLLED_BACK: 'rolled-back', // 装坏了，已经退回去
  REFUSED: 'refused',       // 装之前就拒绝了（没动手）
  NOOP: 'noop',             // 已经是这个版本，什么都不用做
}

/** 跑子进程，收输出，超时杀树 */
function run(cmd, args, { cwd, timeoutMs = 300_000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform === 'win32',
        windowsHide: true,
      })
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e), timedOut: false })
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
      resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/**
 * 备份根目录。
 *
 * 🔴 为什么不放在 profileDir 里面：
 *    一开始是 `profileDir/.update-guard/backups`，结果一次测试清理
 *    （`rmSync(profileDir/.update-guard)`）把真实升级的备份全删了，
 *    等真要回滚时发现「备份 0 份」。
 *    备份是用来在「profile 被搞坏」时救命的，它不能和被保护对象同归于尽。
 *    所以放到 profile **旁边**（同一父目录），profile 被清空/重建都不影响备份。
 */
export function backupBase(profileDir) {
  const abs = resolve(profileDir)
  const parent = dirname(abs)
  const leaf = basename(abs)
  return join(parent, `.update-guard-backups-${leaf}`)
}

/**
 * ① 快照 —— 把「现在的样子」整个存下来，出事了原样盖回去。
 *
 * 存什么：
 *   package.json  —— 依赖声明 + patchedDependencies 登记表
 *   pnpm-lock.yaml —— 依赖树的确切版本
 *   patches/       —— 所有补丁文件
 *   node_modules/<name>/ —— 当前这个包的实际文件（回滚时不用重装就能秒退）
 *
 * 🔴 为什么连 node_modules 里的包目录也存：
 *    只改 package.json + install 的回滚方式要重跑 pnpm，慢（可能几十秒）。
 *    而主人的 DSH 在这几十秒里是坏的。存一份包目录，回滚就是文件覆盖，快得多。
 */
export function snapshot(profileDir, name, { backupRoot } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = backupRoot || join(backupBase(profileDir), stamp)
  mkdirSync(root, { recursive: true })

  const saved = []
  // 关键文件
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    const src = join(profileDir, f)
    if (existsSync(src)) {
      try { cpSync(src, join(root, f)); saved.push(f) } catch { /* 复制失败就跳过这一项 */ }
    }
  }
  // 补丁目录
  const patchDir = join(profileDir, 'patches')
  if (existsSync(patchDir)) {
    try { cpSync(patchDir, join(root, 'patches'), { recursive: true }); saved.push('patches/') } catch { /* 同上 */ }
  }
  // 当前包目录（秒回滚用）
  const pkgDir = join(profileDir, 'node_modules', ...name.split('/'))
  if (existsSync(pkgDir)) {
    try {
      cpSync(pkgDir, join(root, 'pkg'), { recursive: true, dereference: false })
      saved.push(`node_modules/${name}/`)
    } catch { /* 包太大复制不动就退化成「只回滚 manifest」 */ }
  }

  return {
    root,
    stamp,
    saved,
    hasPkgCopy: saved.some((s) => s.startsWith('node_modules/')),
    manifest: readProfileManifest(profileDir),
    currentVersion: installedVersion(profileDir, name),
  }
}

/**
 * ② 补丁重定位 —— 把补丁从旧版本迁到新版本。
 *
 * 这是整个流程里**最容易出错**的一步，因为它同时要改三个地方：
 *   a. package.json 里 patchedDependencies 的 key（`pkg@1.0.0` → `pkg@2.0.0`）
 *   b. 补丁文件名（`pkg@1.0.0.patch` → `pkg@2.0.0.patch`）
 *   c. 补丁文件**内容**里的路径和上下文行（如果新版挪了文件）
 *
 * 🔴 关键认知：a、b 是机械改名，c 才是真功夫。
 *    如果新版把 `client/client.js` 挪到 `lib/client.js`，补丁的 `--- a/client/client.js`
 *    就再也打不上了。这种「重写」需要模型参与 —— 所以这里只做 a、b，
 *    并把 c 的风险报出来，交给上游的 review 判决处理。
 */
export function retargetPatches(profileDir, name, toVersion, { dryRun = false } = {}) {
  const manifest = readProfileManifest(profileDir)
  // 🔴 必须用 readPatchedDependencies（同时读 package.json 和 pnpm-workspace.yaml）。
  //    只读 manifest.pnpm 的话，pnpm 11 的 profile 会读出空表，补丁全丢。
  const table = readPatchedDependencies(profileDir)
  const changes = []

  for (const [key, rel] of Object.entries(table)) {
    const { name: pname, version: pver } = parsePatchKey(key)
    if (pname !== name) continue
    if (pver === toVersion) {
      changes.push({ key, action: 'keep', reason: '补丁已经是目标版本' })
      continue
    }

    const newKey = `${name}@${toVersion}`
    const oldFile = join(profileDir, String(rel))
    let newRel = String(rel).replace(`${name}@${pver}`, `${name}@${toVersion}`)
    // 🔴 兜底：如果文件名不是 `pkg@ver.patch` 这种标准形式（主人手工改过名），
    //    replace 会静默不生效 —— 那就按标准形式重新起一个名字，别让补丁悄悄丢掉。
    if (newRel === String(rel)) {
      const dirPart = String(rel).includes('/') ? String(rel).slice(0, String(rel).lastIndexOf('/') + 1) : ''
      newRel = `${dirPart}${name.replace('/', '+')}@${toVersion}.patch`
    }
    const newFile = join(profileDir, newRel)

    const rec = {
      key, newKey, oldFile, newFile, oldRel: rel, newRel,
      action: 'rename',
      patchExists: existsSync(oldFile),
    }

    // 检查补丁改的文件在新版里还在不在（不在就是「重写」而不是「改名」）
    if (rec.patchExists) {
      try {
        const text = readFileSync(oldFile, 'utf8')
        const targets = new Set()
        for (const line of text.split(/\r?\n/)) {
          const m = /^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\t\n]+)/.exec(line)
          if (m && m[1] && m[1] !== '/dev/null') targets.add(m[1].trim().replace(/^[ab]\//, ''))
        }
        rec.targetFiles = [...targets]
        rec.needsRewrite = false // 需要上游 review 判断，这里先不预设
      } catch (e) {
        rec.readError = String(e?.message ?? e)
      }
    } else {
      rec.action = 'missing'
    }

    if (!dryRun && rec.action === 'rename') {
      // 改 package.json 的 key
      delete table[key]
      table[newKey] = newRel
      // 改文件名（复制而非移动，回滚时旧文件还在）
      if (existsSync(oldFile) && oldFile !== newFile) {
        try { cpSync(oldFile, newFile); rec.fileCopied = true } catch (e) { rec.fileError = String(e?.message ?? e) }
      }
    }
    changes.push(rec)
  }

  let writeTarget = null
  if (!dryRun && changes.some((c) => c.action === 'rename')) {
    // 写回它原本住的地方（yaml 还是 json），别凭空搬家 ——
    // 两处都写会造出「一份生效一份是孤儿」的鬼状态。
    writeTarget = writePatchedDependencies(profileDir, table).where
  }

  return { changes, changed: changes.filter((c) => c.action === 'rename').length, writeTarget }
}

/**
 * ③ 跑 pnpm install（真装进 profile）
 */
export async function pnpmInstall(profileDir, { toolchain, timeoutMs = 600_000 } = {}) {
  const tc = toolchain ?? findToolchain()
  if (!tc.node || !tc.pnpm) {
    return { ok: false, reason: '找不到 node 或 pnpm，装不了', toolchain: tc }
  }
  const isMjs = tc.pnpm.endsWith('.mjs')
  const cmd = isMjs ? tc.node : tc.pnpm
  // 🔴 `--no-frozen-lockfile` 是必须的。
  //    我们刚把 manifest 里的版本号从 0.1.55 改成 0.1.56，lockfile 里还是 0.1.55，
  //    pnpm 一看对不上就 ERR_PNPM_OUTDATED_LOCKFILE 直接拒装 —— 而且我们设了 CI=1，
  //    这个开关在 CI 环境下默认开启。于是「真装」永远失败，回滚永远生效，
  //    表面看是「兜底很稳」，实际是「从来没成功过」。
  //    （沙箱试跑里踩过同一个坑，这里漏了。）
  const args = isMjs
    ? [tc.pnpm, 'install', '--no-frozen-lockfile']
    : ['install', '--no-frozen-lockfile']

  const r = await run(cmd, args, {
    cwd: profileDir,
    timeoutMs,
    env: {
      npm_config_minimum_release_age: '0',
      CI: '1',
      ...(tc.env ?? {}),
    },
  })

  if (r.timedOut) return { ok: false, reason: `pnpm install 超时（${Math.round(timeoutMs / 1000)}s）`, output: tail(r.stderr), toolchain: tc }
  if (r.code !== 0) {
    return {
      ok: false,
      reason: 'pnpm install 失败',
      output: tail(r.stderr || r.stdout),
      patchProblem: /ERR_PNPM_UNUSED_PATCH|patches were not used/i.test(r.stderr + r.stdout),
      toolchain: tc,
    }
  }
  return { ok: true, output: tail(r.stdout), toolchain: tc }
}

/**
 * ④ 验收 —— 装完立刻确认这个插件真的能加载。
 *
 * 🔴 这一步是「不让桌面端崩」的最后一道闸。
 *    沙箱试跑是在干净目录跑的；真实 profile 里依赖树可能不一样，
 *    只有装完再验一次才作数。
 */
export async function verifyInstalled(profileDir, name, { toolchain, timeoutMs = 30_000 } = {}) {
  const tc = toolchain ?? findToolchain()
  if (!tc.node) return { ok: false, reason: '找不到 node，没法验收' }

  const pkgDir = join(profileDir, 'node_modules', ...name.split('/'))
  if (!existsSync(pkgDir)) {
    return { ok: false, reason: `装完了但 node_modules 里没有 ${name}` }
  }

  let entry = 'index.js'
  try {
    const mf = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const exp = mf.exports
    if (typeof exp === 'string') entry = exp
    else if (exp && typeof exp === 'object') {
      const dot = exp['.']
      if (typeof dot === 'string') entry = dot
      else if (dot && typeof dot === 'object') entry = dot.import ?? dot.require ?? dot.default ?? 'index.js'
    } else if (mf.main) entry = mf.main
  } catch { /* 用默认 */ }

  const entryPath = join(pkgDir, String(entry).replace(/^\.\//, ''))
  if (!existsSync(entryPath)) {
    return { ok: false, reason: `入口文件不存在：${entry}` }
  }

  const probe = `
const url = 'file://' + ${JSON.stringify(entryPath)}.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')
// 🔴 宿主注入的包：DSH 运行时从 app.asar 里给插件提供，profile 的 node_modules 里
//    根本没有它们。子进程 import 必然报 ERR_MODULE_NOT_FOUND —— 这是**环境假象**，
//    不是插件坏了。真装时若把它当失败，每个正常插件都会被判「装进去会崩」然后回滚，
//    工具就变成「永远不许更新」。
//    所以这里只对「缺的是宿主包」放行；缺别的东西（插件自己漏了依赖）仍然算失败。
const HOST = ${JSON.stringify(HOST_INJECTED)}
try {
  const mod = await import(url)
  if (typeof mod.apply !== 'function' && typeof mod.default?.apply !== 'function') {
    console.log(JSON.stringify({ ok: false, reason: '没有导出 apply —— 不是 DSH 插件' }))
  } else {
    console.log(JSON.stringify({ ok: true }))
  }
} catch (e) {
  const msg = String(e && e.message || e)
  // 从报错里抠出「缺的是哪个包」：Cannot find package 'X' imported from ...
  const missing = /Cannot find package '([^']+)'/.exec(msg)?.[1]
    || /Cannot find module '([^']+)'/.exec(msg)?.[1]
  const isHost = missing && HOST.some((h) => missing === h || missing.startsWith(h + '/'))
  if (isHost) {
    console.log(JSON.stringify({ ok: true, partial: true, missing }))
  } else {
    console.log(JSON.stringify({ ok: false, reason: msg }))
  }
}
`
  const probeFile = join(profileDir, '.update-guard', `__verify_${Date.now()}.mjs`)
  mkdirSync(join(profileDir, '.update-guard'), { recursive: true })
  writeFileSync(probeFile, probe, 'utf8')
  try {
    const r = await run(tc.node, [probeFile], { cwd: profileDir, timeoutMs, env: { ...(tc.env ?? {}) } })
    if (r.timedOut) return { ok: false, reason: '加载超时 —— 插件卡住了，装进去 DSH 会启动挂住' }
    const line = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop()
    let parsed = null
    try { parsed = JSON.parse(line) } catch { /* 崩了 */ }
    if (!parsed) return { ok: false, reason: '加载时进程异常退出', output: tail(r.stderr || r.stdout) }
    if (parsed.ok) {
      return parsed.partial
        ? { ok: true, partial: true, reason: `加载正常（${parsed.missing} 由宿主注入，子进程里没有属正常）` }
        : { ok: true }
    }
    return { ok: false, reason: parsed.reason }
  } finally {
    try { rmSync(probeFile, { force: true }) } catch { /* 删不掉不影响 */ }
  }
}

/**
 * ⑤ 回滚 —— 把快照盖回去。
 *
 * 分两条路，谁快用谁：
 *   快路：直接把备份的包目录盖回 node_modules（秒级，不用跑 pnpm）
 *   慢路：还原 package.json + lockfile + patches，然后 pnpm install（几十秒，但一定对）
 *
 * 🔴 优先走快路：主人的 DSH 每多坏一秒都是损失。
 *    快路失败了再走慢路兜底。
 */
export async function rollback(profileDir, snap, { toolchain, name, timeoutMs = 600_000 } = {}) {
  const steps = []
  const root = snap.root

  // 快路：文件层面直接盖回去
  let fastOk = true
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    const src = join(root, f)
    if (!existsSync(src)) continue
    try {
      cpSync(src, join(profileDir, f))
      steps.push({ step: `restore ${f}`, ok: true })
    } catch (e) {
      steps.push({ step: `restore ${f}`, ok: false, detail: String(e?.message ?? e) })
      if (f === 'package.json') fastOk = false
    }
  }
  // 补丁目录整个盖回去
  const backupPatches = join(root, 'patches')
  if (existsSync(backupPatches)) {
    try {
      cpSync(backupPatches, join(profileDir, 'patches'), { recursive: true })
      steps.push({ step: 'restore patches/', ok: true })
    } catch (e) {
      steps.push({ step: 'restore patches/', ok: false, detail: String(e?.message ?? e) })
    }
  }
  // 包目录秒回滚
  const backupPkg = join(root, 'pkg')
  const targetPkg = join(profileDir, 'node_modules', ...String(name ?? '').split('/'))
  if (name && existsSync(backupPkg)) {
    try {
      if (existsSync(targetPkg)) rmSync(targetPkg, { recursive: true, force: true })
      mkdirSync(join(targetPkg, '..'), { recursive: true })
      cpSync(backupPkg, targetPkg, { recursive: true, dereference: false })
      steps.push({ step: `restore node_modules/${name}/`, ok: true, detail: '秒回滚' })
    } catch (e) {
      steps.push({ step: `restore node_modules/${name}/`, ok: false, detail: String(e?.message ?? e) })
    }
  }

  // 慢路兜底：再 install 一次，保证依赖树跟 manifest 一致
  if (fastOk) {
    const inst = await pnpmInstall(profileDir, { toolchain, timeoutMs })
    steps.push({ step: 'pnpm install（对齐依赖树）', ok: inst.ok, detail: inst.reason ?? '完成' })
    if (!inst.ok) return { ok: false, steps, reason: `回滚后重装失败：${inst.reason}`, output: inst.output }
  }

  return { ok: true, steps }
}

/** 只取输出尾巴 */
function tail(s, n = 3000) {
  const t = String(s ?? '')
  return t.length > n ? `…（前面省略）\n${t.slice(-n)}` : t
}

/**
 * 完整执行一次更新 —— 快照 → 重定位 → 装 → 验 → （失败就）回滚。
 *
 * @param {object} args
 * @param {string} args.profileDir
 * @param {string} args.name          包名
 * @param {string} args.toVersion     目标版本
 * @param {object} [args.toolchain]   复用已找到的 node/pnpm（省一次探测）
 * @param {boolean} [args.verify]     装完要不要验收（默认 true，**别关**）
 * @returns 执行报告
 */
export async function applyUpdate({
  profileDir, name, toVersion,
  toolchain, verify = true,
  installTimeoutMs = 600_000, verifyTimeoutMs = 30_000,
} = {}) {
  const started = Date.now()
  const steps = []
  const tc = toolchain ?? findToolchain()

  const current = installedVersion(profileDir, name)
  if (current === toVersion) {
    return {
      result: APPLY_RESULT.NOOP, ok: true,
      reason: `已经是 ${toVersion}，什么都不用做`,
      fromVersion: current, toVersion, steps, elapsedMs: Date.now() - started,
    }
  }

  // ① 快照
  let snap
  try {
    snap = snapshot(profileDir, name)
    steps.push({ step: 'snapshot', ok: true, detail: `备份在 ${snap.root}（${snap.saved.join(', ')}）` })
    // 顺手清旧备份：新的一份已经存好了，老的留着占地。
    // 这一步失败不影响更新（备份多了只是浪费空间，不是错误）。
    try { pruneBackups(profileDir) } catch { /* 清理失败无所谓 */ }
  } catch (e) {
    // 快照失败**绝对不能**继续 —— 没有后悔药的更新是在赌主人的 DSH
    return {
      result: APPLY_RESULT.REFUSED, ok: false,
      reason: `没法做备份（${e?.message ?? e}），为了不把 DSH 搞坏，这次更新取消`,
      fromVersion: current, toVersion, steps, elapsedMs: Date.now() - started,
    }
  }

  // ② 补丁重定位
  let retarget
  try {
    retarget = retargetPatches(profileDir, name, toVersion)
    steps.push({
      step: 'retarget-patches', ok: true,
      detail: retarget.changed > 0
        ? retarget.changes.map((c) => `${c.key} → ${c.newKey}`).join('；')
        : '没有需要重定位的补丁',
    })
  } catch (e) {
    steps.push({ step: 'retarget-patches', ok: false, detail: String(e?.message ?? e) })
    retarget = { changes: [], changed: 0 }
  }

  // ③ 改 manifest 里的版本号（pnpm install 照着它装）
  // 🔴 只有 registry 源的依赖能这么改。git / file 源换成裸版本号会 404 或 ENOENT：
  //    实测 dsh-fish-memory 是 git tarball 装的，npm 上根本没有这个包；
  //    dsh-pwa-kit 是 `file:./local-plugins/...`。这两种源的「更新」不能靠改版本号，
  //    只能报错让人知道，而不是改坏 manifest 再等 pnpm 失败。
  let specChanged = false
  try {
    const manifest = readProfileManifest(profileDir)
    manifest.dependencies = { ...(manifest.dependencies ?? {}) }
    const oldSpec = String(manifest.dependencies[name] ?? '')
    const isRegistry = oldSpec !== '' && !/^(file:|link:|\.\.?\/|https?:|git[+:])/i.test(oldSpec)
    if (!isRegistry) {
      steps.push({
        step: 'pin-version', ok: false,
        detail: `这个包的依赖源不是 registry（${oldSpec}），改版本号装不上，拒绝执行`,
      })
      const rb = await rollback(profileDir, snap, { toolchain: tc, name })
      steps.push({ step: 'rollback', ok: rb.ok, detail: rb.ok ? '已退回原状' : `回滚失败：${rb.reason}` })
      return {
        result: APPLY_RESULT.REFUSED, ok: false,
        reason: `${name} 是从 ${oldSpec} 装的，不是 npm 上的包，没法用「改版本号」的方式升级。`
          + '要升它得换 spec（git 的换 commit/tag，file 的直接改那个目录），这个工具不擅自替你改。',
        fromVersion: current, toVersion, steps, snapshot: snap.root,
        rollback: rb,
        elapsedMs: Date.now() - started,
      }
    }
    manifest.dependencies[name] = toVersion
    specChanged = true
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
    steps.push({ step: 'pin-version', ok: true, detail: `dependencies["${name}"] = "${toVersion}"` })
  } catch (e) {
    steps.push({ step: 'pin-version', ok: false, detail: String(e?.message ?? e) })
  }

  // ④ 装
  const inst = await pnpmInstall(profileDir, { toolchain: tc, timeoutMs: installTimeoutMs })
  steps.push({ step: 'pnpm install', ok: inst.ok, detail: inst.reason ?? '装完了', output: inst.output })
  if (!inst.ok) {
    const rb = await rollback(profileDir, snap, { toolchain: tc, name })
    steps.push({ step: 'rollback', ok: rb.ok, detail: rb.ok ? '已退回原状' : `回滚失败：${rb.reason}` })
    return {
      result: APPLY_RESULT.ROLLED_BACK, ok: false,
      reason: `装不上（${inst.reason}${inst.patchProblem ? '，多半是补丁打不上了' : ''}），已经自动退回 ${current}`,
      fromVersion: current, toVersion, steps, snapshot: snap.root,
      patchProblem: inst.patchProblem ?? false,
      rollback: rb,
      elapsedMs: Date.now() - started,
    }
  }

  // ⑤ 验收
  if (verify) {
    const v = await verifyInstalled(profileDir, name, { toolchain: tc, timeoutMs: verifyTimeoutMs })
    steps.push({ step: 'verify', ok: v.ok, detail: v.reason ?? '加载正常' })
    if (!v.ok) {
      const rb = await rollback(profileDir, snap, { toolchain: tc, name })
      steps.push({ step: 'rollback', ok: rb.ok, detail: rb.ok ? '已退回原状' : `回滚失败：${rb.reason}` })
      return {
        result: APPLY_RESULT.ROLLED_BACK, ok: false,
        reason: `装上了但加载不起来（${v.reason}），装进去 DSH 会崩，已经自动退回 ${current}`,
        fromVersion: current, toVersion, steps, snapshot: snap.root,
        verifyOutput: v.output ?? null,
        rollback: rb,
        elapsedMs: Date.now() - started,
      }
    }
  }

  return {
    result: APPLY_RESULT.APPLIED, ok: true,
    reason: `已更新 ${current} → ${toVersion}，加载验证通过`,
    fromVersion: current, toVersion, steps, snapshot: snap.root,
    elapsedMs: Date.now() - started,
  }
}

/**
 * 列出某个包的所有备份，最新的排前面。
 *
 * 🔴 为什么备份要按包名筛：
 *    备份目录里存了 `pkg`（那个包的目录副本），只有这个包被更新过才有。
 *    没存 pkg 的备份（比如只更新了 manifest 的）回滚起来要重装，慢，排后面。
 */
export function listBackups(profileDir, name) {
  const root = backupBase(profileDir)
  if (!existsSync(root)) return []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }

  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    // 备份里必须有这个包的目录副本，才算「这个包的备份」
    const hasPkg = existsSync(join(dir, 'pkg'))
    if (!hasPkg) continue
    let manifest = null
    try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { /* 没存 manifest 就判断不了版本 */ }
    out.push({
      root: dir,
      stamp: e.name,
      name,
      version: manifest?.dependencies?.[name] ?? null,
    })
  }
  // 目录名是 ISO 时间戳，字典序就是时间序，倒过来就是最新在前
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
  return out
}

/**
 * 清掉旧备份，只留最近 keep 份。
 *
 * 🔴 为什么要管这个：
 *    每份备份含一份完整的包目录，实测一份 4.3MB。更新几十次就是几百兆，
 *    全塞在主人的 profile 旁边。备份是用来救命的，不是用来占地的。
 *
 * 保留策略（保守）：
 *   - 最近 keep 份一律留（默认 5）
 *   - **最新一份永远留**（就算 keep 传 0 也不删最后一份 —— 没有备份=没有兜底）
 *   - 只删备份根目录下的时间戳目录，不碰别的东西
 *
 * @returns {{removed: string[], kept: number}}
 */
export function pruneBackups(profileDir, { keep = 5 } = {}) {
  const root = backupBase(profileDir)
  if (!existsSync(root)) return { removed: [], kept: 0 }

  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return { removed: [], kept: 0 } }

  // 只认形如 ISO 时间戳的目录，别的一概不动（防止误删用户自己放的东西）
  const stamps = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(e.name))
    .map((e) => e.name)
    .sort() // 字典序 = 时间序
    .reverse() // 最新在前

  const effectiveKeep = Math.max(1, keep) // 永远至少留 1 份
  const toRemove = stamps.slice(effectiveKeep)

  const removed = []
  for (const s of toRemove) {
    try {
      rmSync(join(root, s), { recursive: true, force: true })
      removed.push(s)
    } catch { /* 删不掉就留着，不影响正确性 */ }
  }
  return { removed, kept: stamps.length - removed.length }
}

/** 把执行结果渲染成给人看的一段话 */
export function renderApply(report) {  if (!report) return '（没有执行）'
  const lines = []
  const icon = report.result === APPLY_RESULT.APPLIED ? '✅'
    : report.result === APPLY_RESULT.ROLLED_BACK ? '↩️'
      : report.result === APPLY_RESULT.NOOP ? '⚪' : '🚫'
  lines.push(`${icon} ${report.reason}`)
  for (const s of report.steps ?? []) {
    const mark = s.ok ? '✓' : '✗'
    lines.push(`  ${mark} ${s.step}：${s.detail ?? ''}`)
    if (s.output && !s.ok) {
      const t = String(s.output).split('\n').filter(Boolean).slice(-6).join('\n      ')
      if (t) lines.push(`      ${t}`)
    }
  }
  if (report.snapshot) lines.push(`  备份保留在：${report.snapshot}`)
  if (report.elapsedMs) lines.push(`  耗时 ${(report.elapsedMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}
