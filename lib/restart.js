/**
 * lib/restart.js —— 装完要重启，但**绝不能只杀不拉**
 * ============================================================================
 * 🔴 这是本项目最贵的教训，来自主人的真实事故（记忆 project_dsh_2026-10-22_mess.md）：
 *   「为验证 WorkBuddy 把 dsh-our-free-model 降级，重启时**杀了进程树但没拉起来**，
 *     应用后台死了约 2 小时，靠每日 10:00 计划任务救回。」
 *   主人原话：「你干嘛了？怎么退出了？没有重启？要不是我设置了每日 10 点启动计划，
 *              你就要在后台待一天了」
 *
 * 所以重启这件事的能力顺序是：
 *   ① 有 Electron 就用它自己的 `app.relaunch()` —— 官方 API，退出后由 Electron
 *      负责拉起新进程，最不容易出事；
 *   ② 无论走哪条路，都先起一个**独立的重启帮手**（detached 子进程）：
 *      它盯着旧进程死没死 → 等新进程起来 → 探活 → 连续稳定 8 秒才算成功；
 *      起不来就**再拉**，最多 3 次；三次都失败就写一个显眼的失败标记 + 日志，
 *      明确告诉主人「去这里手动开」——绝不留下一个静默死掉的后台。
 *
 * 帮手必须是 detached 且 stdio 全 ignore：
 *   我们自己的进程马上就要退出，任何还挂在它身上的管道都会跟着断。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

export const BOOT_SETTLE_MS = 8_000
export const RESTART_TRIES = 3

/**
 * 拿 Electron 的 `app` 对象 —— 这是社区标准做法，也是 DSH 自己用的那条路。
 *
 * 关键细节（踩过）：**必须走 CJS 的 `require('electron')`**。
 * 宿主主进程里 Electron 把 `require` 打了个补丁，'electron' 是内置模块，一定有；
 * 而 ESM 的 `await import('electron')` 会去 node_modules 找真包，找不到就
 * ERR_MODULE_NOT_FOUND —— 这就是之前策略一直退化成 kill-and-spawn 的原因。
 *
 * 依据：DSH 本体自己的重启就是 `app.relaunch(); quitWithoutConfirmation()`
 *（见 app.asar 内 `lib/main.js`），官方 API 比我们在外面杀进程再拉稳得多。
 */
export function getElectronApp() {
  if (!process.versions?.electron) return null
  const tries = []
  try {
    const req = createRequire(import.meta.url)
    tries.push(() => req('electron'))
  } catch { /* ignore */ }
  tries.push(() => globalThis.require?.('electron'))
  tries.push(() => process.mainModule?.require?.('electron'))
  for (const t of tries) {
    try {
      const mod = t()
      const app = mod?.app ?? mod?.default?.app ?? null
      if (app && typeof app.relaunch === 'function') return app
    } catch { /* 换下一种拿法 */ }
  }
  return null
}

/**
 * 决定用哪种策略重启。
 * @param {{appExe?: string, hasElectron?: boolean, electronApp?: object}} o
 */
export function planRestart({ appExe, hasElectron = false, electronApp = null } = {}) {
  const exe = appExe || process.execPath
  const canRelaunch = !!(hasElectron && electronApp && typeof electronApp.relaunch === 'function' && typeof electronApp.quit === 'function')
  return {
    ok: !!exe,
    strategy: canRelaunch ? 'electron-relaunch' : 'kill-and-spawn',
    appExe: exe ?? null,
    appName: exe ? basename(exe) : null,
    // 没有 Electron 也能重启（帮手负责杀+拉），所以不是硬失败
    note: canRelaunch
      ? '用 Electron 自带的 relaunch：退出后由 Electron 负责拉起新进程'
      : '没有 Electron relaunch 可用，由帮手杀旧进程再拉起新进程（仍然带重试）',
  }
}

export function helperPath(dir) {
  return join(dir, '.update-guard', 'restart-helper.mjs')
}

export function restartLogPath(dir) {
  return join(dir, '.update-guard', 'restart.log')
}

export function restartResultPath(dir) {
  return join(dir, '.update-guard', 'restart-result.json')
}

/**
 * 生成重启帮手脚本。
 * 它是一个**独立进程**，不 import 本插件的任何文件（我们退出后模块可能已不可用）。
 */
export function renderHelper({ appExe, appName, settleMs = BOOT_SETTLE_MS, tries = RESTART_TRIES } = {}) {
  // 注意：这里刻意用字符串模板，不依赖构建工具。
  return `// 由 dsh-update-guard 生成：重启帮手。独立进程，只干一件事 —— 让 DSH 活着回来。
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { request } from 'node:http'

const APP = ${JSON.stringify(appExe)}
const APP_NAME = ${JSON.stringify(appName || '')}
const SETTLE = ${Number(settleMs) || 8000}
const TRIES = ${Number(tries) || 3}
const OUT = process.argv[2]
const PARENT = Number(process.argv[3] || 0)
const WINDOWS = process.platform === 'win32'

const LOGFILE = join(dirname(OUT), 'restart.log')
// 看门狗模式：宿主自己用 app.relaunch() 重启时，帮手**不许碰旧进程**，
// 只负责「等新实例起来 / 没起来就补拉」。
const WATCH = process.env.UG_HELPER_WATCH === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ')
  try { mkdirSync(dirname(LOGFILE), { recursive: true }); appendFileSync(LOGFILE, line + '\\n', 'utf8') } catch {}
}
function done(obj) {
  try { writeFileSync(OUT, JSON.stringify(obj, null, 2), 'utf8') } catch {}
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

async function waitGone(pid, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(400) }
  return !alive(pid)
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    try {
      // 🔴 windowsHide:true 是硬要求。不加的话每调一次 tasklist/netstat
      //    就闪一个 CMD 黑窗；探活期间每 1.2s 一次，主人看到的就是
      //    「CMD 窗口一直弹出然后消失」（2026-10-22 真机反馈）。
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => { out += String(d) })
      p.on('error', () => resolve(''))
      p.on('close', () => resolve(out))
    } catch { resolve('') }
  })
}

async function pidsByName() {
  const want = (APP_NAME || basename(APP || '')).toLowerCase()
  if (!want) return []
  if (WINDOWS) {
    const out = await sh('tasklist', ['/FO', 'CSV', '/NH'])
    const ids = []
    for (const line of out.split(/\\r?\\n/)) {
      if (!line.toLowerCase().includes(want)) continue
      const m = line.match(/","(\\d+)","/)
      if (m) ids.push(Number(m[1]))
    }
    return ids
  }
  const out = await sh('pgrep', ['-f', basename(APP || '')])
  return out.split(/\\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
}

async function listeningPorts(pids) {
  const set = new Set(pids)
  const ports = new Set()
  if (WINDOWS) {
    const out = await sh('netstat', ['-ano'])
    for (const line of out.split(/\\r?\\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\\s+/)
      const local = cols[1] || ''
      const pid = Number(cols[cols.length - 1])
      if (!set.has(pid)) continue
      const port = Number((local.match(/:(\\d+)$/) || [])[1])
      if (port && port >= 1024) ports.add(port)
    }
  } else {
    const out = await sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
    let curPid = 0
    for (const line of out.split(/\\n/)) {
      if (line.startsWith('p')) curPid = Number(line.slice(1))
      else if (line.startsWith('n') && set.has(curPid)) {
        const port = Number((line.match(/:(\\d+)$/) || [])[1])
        if (port && port >= 1024) ports.add(port)
      }
    }
  }
  return [...ports]
}

function probe(port, timeoutMs = 3000, path = '/') {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      // 只认「HTTP 服务真的在答话」：2xx/3xx（正常）或 401/403（要登录，也算活着）。
      // 5xx 说明还在启动中/半死，不能算「起来了」。
      resolve(res.statusCode > 0 && res.statusCode < 500)
    })
    req.on('timeout', () => { try { req.destroy() } catch {} ; resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 探「这个端口是不是我们自己的 GUI」。
 * 先打本插件自己的接口（能通就是「宿主 + 插件都活了」，最强证据），
 * 再退回根路径（插件被禁用时也还认得出是 DSH）。
 */
async function probeDsh(port) {
  for (const p of ['/dsh-update-guard-api/overview', '/']) {
    if (await probe(port, 3000, p)) return p
  }
  return null
}

/**
 * 拉起一个实例。
 *
 * 🔴 2026-10-22 真机教训：直接 spawn(APP) 虽然探到了端口，
 *    但主人那边**看不到窗口**，以为「有成功退出、没有重启」。
 *    Windows 上改用 explorer.exe 拉起（跟双击一模一样，窗口一定出来），
 *    并且全程 windowsHide，不再闪 CMD。
 */
function launchViaShell(tag) {
  if (WINDOWS) {
    try {
      const c = spawn('explorer.exe', [APP], { detached: true, stdio: 'ignore', windowsHide: true })
      c.on('error', (e) => log(tag, 'explorer 拉起失败', String(e && e.message || e)))
      c.unref()
      return true
    } catch (e) { log(tag, 'explorer 抛错', String((e && e.message) || e)) }
  }
  return launchDirect(tag)
}

function launchDirect(tag) {
  try {
    const c = spawn(APP, [], { detached: true, stdio: 'ignore', cwd: dirname(APP) })
    c.on('error', (e) => log(tag, '直接拉起失败', String(e && e.message || e)))
    c.unref()
    return true
  } catch (e) { log(tag, '直接拉起失败', String(e)); return false }
}

/** 找「当前活着的 DSH 在哪个端口」——探到能响应 HTTP 才算数 */
async function findUp(deadlineMs, exclude) {
  const skip = exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : [])
  const end = Date.now() + deadlineMs
  let beat = 0
  while (Date.now() < end) {
    // 必须排掉旧进程：万一它没死透，探到的就是它，会误判「已经起来了」
    const pids = (await pidsByName()).filter((p) => p !== process.pid && !skip.has(p))
    if (pids.length) {
      const ports = await listeningPorts(pids)
      for (const port of ports) {
        const hit = await probeDsh(port)
        if (hit) return { pid: pids[0], port, via: hit }
      }
      // 有心跳日志，下一次出问题才查得动（之前 85 秒空白全靠猜）
      if (Date.now() - beat > 10000) {
        beat = Date.now()
        log('等新实例：进程 ' + pids.join(' ') + '，监听端口 ' + (ports.join(' ') || '（还没开）'))
      }
    } else if (Date.now() - beat > 10000) {
      beat = Date.now()
      log('等新实例：还没有同名进程')
    }
    await sleep(1000)
  }
  return null
}

/** 连续稳定：要「连续 N 次都探到」才算数，不是「整段时间里成功过一次」 */
async function waitStable(port, ms) {
  const need = Math.max(2, Math.ceil(ms / 1000))
  let streak = 0
  while (streak < need) {
    if (await probeDsh(port)) streak += 1
    else streak = 0
    if (streak < need) await sleep(1000)
  }
  return Boolean(await probeDsh(port))
}

/**
 * 把「这个 app 的进程」全结束掉。
 *
 * 🔴 2026-10-22 真机教训：上一次只结束了宿主子进程，主进程和渲染进程还活着 ——
 *    窗口卡在「应用无法启动或已意外停止」的对话框上，动不了，后台也没退干净，
 *    最后由主人手动重启。半死状态比直接死更难收拾。
 *    → 所以现在**按进程名整体结束**：不碰 /T（那会把帮手自己带走），
 *      但也不留下任何一个同名的半死进程。
 */
async function killByName() {
  const ids = (await pidsByName()).filter((p) => p !== process.pid)
  if (!ids.length) return []
  log('结束旧进程', ids.join(' '))
  for (const pid of ids) {
    try {
      if (WINDOWS) spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
      else process.kill(pid, 'SIGKILL')
    } catch (e) { log('kill ' + pid + ' 失败', String(e)) }
  }
  return ids
}

async function main() {
  const DRY = process.env.UG_HELPER_DRYRUN === '1'
  log('帮手启动；目标：', APP, '旧主进程', PARENT, DRY ? '（试运行：只观察不动手）' : '')

  // ① 稍等一下再动手：给「工具结果 / 助手回复」一点时间送到界面，别话没说完就把宿主关了
  const delay = Number(process.env.UG_HELPER_DELAY || 4000)
  if (!DRY) await sleep(delay)

  // ② 先把旧的全体请走（含主进程、渲染进程、宿主），一个不留
  const before = (await pidsByName()).filter((p) => p !== process.pid)
  log('动手前同名进程：', before.join(' ') || '（无）')
  if (WATCH) log('看门狗模式：不动旧进程，只等宿主自己 relaunch 出新实例')
  if (!DRY && !WATCH) {
    for (let round = 0; round < 5; round += 1) {
      await killByName()
      await sleep(900)
      if (!(await pidsByName()).filter((p) => p !== process.pid).length) break
    }
  }
  const left = WATCH ? [] : (await pidsByName()).filter((p) => p !== process.pid)
  if (!DRY && left.length) {
    log('❌ 旧进程清不干净：', left.join(' '), '—— 不敢在旁边再拉一个（那会卡成半死）')
    return done({ ok: false, reason: '旧进程清不干净，为避免半死状态放弃拉起', left, appExe: APP, at: new Date().toISOString() })
  }
  log(DRY ? '试运行：跳过结束旧进程' : (WATCH ? '等宿主退出' : '旧进程已全部退出'))
  await sleep(1200)

  // ② 探：只认「不在旧名单里」的新进程
  //
  // 🔴 这里有个曾经把重启拖成 85 秒的坑：杀+拉模式下如果先 findUp(90s) 等新实例，
  //    那 90 秒里根本没人去拉 —— 唯一会拉的就是帮手自己，纯属干等。
  //    所以：**杀完立刻拉**；只有看门狗模式（宿主自己 relaunch）才先等。
  let up = null
  if (WATCH) {
    up = await findUp(75000, new Set(before))
    log(up ? '新进程已起来，端口 ' + up.port : '还没探到新进程')
    if (!up) {
      const still = (await pidsByName()).filter((p) => p !== process.pid && before.includes(p))
      if (still.length) {
        log('旧实例仍在运行（重启大概被取消了），不强行再拉一个')
        return done({ ok: false, reason: '旧实例还在运行（重启可能被取消），没有强行再拉一个', left: still, appExe: APP, at: new Date().toISOString() })
      }
      log('旧进程已退出但新实例没出现 —— 转由帮手拉起')
    }
  }

  let attempt = 0
  while (attempt < TRIES) {
    if (up && (await waitStable(up.port, SETTLE))) {
      log('连续稳定 ' + SETTLE + 'ms，端口 ' + up.port + '，重启成功')
      return done({ ok: true, port: up.port, pid: up.pid, attempts: attempt, appExe: APP, dryRun: DRY || undefined, at: new Date().toISOString() })
    }
    if (up) {
      // 已经起来了但不稳：**绝不再拉一个**（会撞单实例锁、卡成半死），只是继续观察
      attempt += 1
      log('实例在但还不稳，第 ' + attempt + ' 次观察')
      up = await findUp(DRY ? 8000 : 20000, new Set(before))
      continue
    }
    attempt += 1
    if (DRY) { log('试运行：跳过第 ' + attempt + ' 次拉起'); break }
    log('第 ' + attempt + ' 次拉起', APP)
    // 直接 exec 是**实测有效**的那条路（2026-10-22 真机上确实把端口拉起来了）；
    // explorer.exe 在某些会话里拉不动 GUI，只当兜底。
    launchDirect('第 ' + attempt + ' 次')
    up = await findUp(DRY ? 8000 : 25000, new Set(before))
    if (!up && !DRY) {
      log('第 ' + attempt + ' 次：25s 内没探到，改用 explorer 兜底')
      launchViaShell('第 ' + attempt + ' 次兜底')
      up = await findUp(25000, new Set(before))
    }
    log(up ? '第 ' + attempt + ' 次拉起后探到端口 ' + up.port : '第 ' + attempt + ' 次拉起后仍未探到')
  }
  if (DRY) {
    log('试运行结束（没真的拉起）')
    return done({ ok: false, dryRun: true, probeFound: !!up, attempts: attempt, appExe: APP, at: new Date().toISOString(), hint: '这是试运行，什么都没改' })
  }
  log('❌ ' + TRIES + ' 次都没拉起来 —— 请手动启动 DSH')
  done({ ok: false, attempts: attempt, appExe: APP, at: new Date().toISOString(), hint: '请手动双击启动 DSH；日志见 ' + LOGFILE })
}

main().catch((e) => { log('帮手异常', String(e && e.stack || e)); done({ ok: false, error: String(e && e.message || e) }) })
`
}

/**
 * 起一个独立帮手，然后按策略触发重启。
 *
 * 返回**在进程退出之前**就返回，所以调用方拿得到结果。
 * 真正的重启由 `fire()`（默认 setTimeout 后调用 electron.quit）执行。
 *
 * @param {object} o
 * @param {string} o.dir           profile 目录（日志/结果/帮手都放这里）
 * @param {string} o.node          运行帮手用的真 node
 * @param {string} [o.appExe]
 * @param {boolean} [o.hasElectron]
 * @param {object} [o.electronApp]
 * @param {number} [o.delayMs]     多久之后真的退出（给工具结果留时间）
 * @param {(s: string) => void} [o.log]
 */
export function restartSelf({ dir, node, appExe, hasElectron = false, electronApp = null, delayMs = 1200, env = null, log = () => {} } = {}) {
  const plan = planRestart({ appExe, hasElectron, electronApp })
  if (!plan.ok || !node) {
    return { ok: false, reason: '找不到可执行文件或 node，没法安全重启', plan }
  }
  const outFile = restartResultPath(dir)
  const hp = helperPath(dir)
  try {
    mkdirSync(dirname(hp), { recursive: true })
    writeFileSync(hp, renderHelper({ appExe: plan.appExe, appName: plan.appName }), 'utf8')
  } catch (e) {
    return { ok: false, reason: `写重启帮手失败：${e?.message ?? e}`, plan }
  }

  // 🔴 spawn 一个不存在的可执行文件时，错误是**异步**的 'error' 事件；
  //    不挂监听器会把宿主的进程直接掀翻（单测里就当场崩过一次）。
  //    所以先硬检查存在性，再挂兜底监听器 —— 两道都要。
  if (!existsSync(node)) {
    return { ok: false, reason: `找不到 node（${node}），不敢重启`, plan }
  }

  let child
  try {
    child = spawn(node, [hp, outFile, String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      cwd: dir,
      env: {
        ...process.env,
        ...(plan.strategy === 'electron-relaunch' ? { UG_HELPER_WATCH: '1' } : {}),
        ...(env ?? {}),
      },
    })
    child.unref()
    // 异步失败（找不到/没权限）不许变成未捕获异常
    child.on('error', (e) => {
      log(`起重启帮手失败（异步）：${e?.message ?? e}`)
      try { writeFileSync(outFile, JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2), 'utf8') } catch { /* ignore */ }
    })
  } catch (e) {
    return { ok: false, reason: `起重启帮手失败：${e?.message ?? e}`, plan }
  }

  const fire = () => {
    try {
      if (plan.strategy === 'electron-relaunch') {
        // 这是社区标准做法，也是 DSH 本体自己的做法（app.asar 的 lib/main.js：
        // `app.relaunch(); quitWithoutConfirmation()`）。退出后由 Electron 自己
        // 拉起新进程，不需要我们杀进程、也不会有 CMD 窗口。
        log('调用 app.relaunch() + app.quit()（与 DSH 本体重启同一路径）')
        electronApp.relaunch({ args: process.argv.slice(1) })
        electronApp.quit()
        // app.quit() 可能弹「确认退出」（有会话在跑时）。主人点确认即可；
        // 不确认就什么也不发生 —— 帮手会如实报告「重启被取消」，绝不硬杀。
        const t = setTimeout(() => log('20s 后仍在运行：可能在等退出确认；未做任何强制动作'), 20000)
        if (typeof t.unref === 'function') t.unref()
      } else {
        // 没有 Electron：**自己什么都不做**，由帮手连同主进程一起结束再拉起。
        // 上一次的教训：只退出宿主子进程 → 主进程和窗口半死不活地卡在错误框上。
        log('没有 relaunch：交给帮手整体结束进程再拉起（本进程不必自己退出）')
      }
    } catch (e) {
      log(`退出失败：${e?.message ?? e}`)
    }
  }

  const t = setTimeout(fire, Math.max(300, Number(delayMs) || 1200))
  if (typeof t.unref === 'function') t.unref()

  return {
    ok: true,
    plan,
    helperPid: child.pid,
    logFile: restartLogPath(dir),
    resultFile: outFile,
    settleMs: BOOT_SETTLE_MS,
    note: '帮手会盯着：旧进程退出 → 新进程起来 → 连续稳定 8 秒才算成功；起不来会再拉，最多 3 次',
  }
}