/**
 * test/live-restart-dry.mjs —— 真机验证「重启帮手」的行为，但**绝不真的重启**
 * ============================================================================
 * 为什么要单独一个脚本：
 *   2026-10-22 的教训是「只杀不拉，应用在后台死了两小时」。所以帮手这东西
 *   光看代码不算数，得真跑一次，看它是不是真能等到旧进程退出、真能探到活着的
 *   实例、真不把自己一起杀掉。
 *
 * 怎么做到「真跑但不真重启」：
 *   1. 起一个**替身进程**当「旧 DSH」，把它自己的 pid 交给帮手；
 *   2. 让帮手跑在 UG_HELPER_DRYRUN=1 下 —— 它只观察、只探活，**不 spawn 应用**；
 *   3. 我们把替身杀掉，看帮手是不是正确记录「旧进程已退出」并给出结论；
 *   4. 顺便数一下真 DSH 的进程数，确认前后一样（证明没偷偷开第二个实例）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

import { renderHelper } from '../lib/restart.js'

const NODE = process.execPath
const APP = 'E:\\deepseek harness\\DeepSeek Harness.exe'
const APP_NAME = 'DeepSeek Harness.exe'

let pass = 0
const fails = []
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push(name); console.log(`  ✗ ${name} —— ${e?.message ?? e}`) }
}
const ok = (v, msg) => { if (!v) throw new Error(msg ?? '期望为真') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function countApp() {
  return new Promise((resolve) => {
    const p = spawn('tasklist', ['/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.on('error', () => resolve(-1))
    p.on('close', () => {
      const n = out.split(/\r?\n/).filter((l) => l.toLowerCase().includes('deepseek harness')).length
      resolve(n)
    })
  })
}

const dir = mkdtempSync(join(tmpdir(), 'ug-restart-dry-'))
const guard = join(dir, '.update-guard')
mkdirSync(guard, { recursive: true })
const helperFile = join(guard, 'restart-helper.mjs')
const resultFile = join(guard, 'restart-result.json')

console.log('=== restart 帮手：真跑一遍（试运行，不重启）===')
console.log(`  临时目录：${dir}`)

const before = await countApp()
console.log(`  真 DSH 进程数（起手）：${before}`)

// 替身「旧 DSH」
const dummy = spawn(NODE, ['-e', 'setInterval(() => {}, 500)'], { stdio: 'ignore' })
console.log(`  替身进程 pid：${dummy.pid}`)

writeFileSync(helperFile, renderHelper({ appExe: APP, appName: APP_NAME, settleMs: 3000, tries: 1 }), 'utf8')

const helper = spawn(NODE, [helperFile, resultFile, String(dummy.pid)], {
  stdio: 'ignore',
  env: { ...process.env, UG_HELPER_DRYRUN: '1' },
})

// 1.2 秒后杀掉替身 —— 模拟「DSH 自己退出了」
await sleep(1200)
try { process.kill(dummy.pid) } catch { /* 可能已经退了 */ }

// 等帮手给出结论（最多 90 秒）
const deadline = Date.now() + 90_000
let result = null
while (Date.now() < deadline) {
  if (existsSync(resultFile)) {
    try { result = JSON.parse(readFileSync(resultFile, 'utf8')) } catch { /* 还没写完 */ }
    if (result) break
  }
  await sleep(500)
}

const logText = existsSync(join(guard, 'restart.log')) ? readFileSync(join(guard, 'restart.log'), 'utf8') : ''

t('帮手活到了最后（没被连带杀掉，也没有未捕获异常）', () => {
  ok(result !== null, '90 秒内没写出 restart-result.json')
})
t('帮手记下了「动手前有哪些同名进程」（要整体结束，不是只关一个）', () => {
  ok(logText.includes('动手前同名进程'), `日志里没有这一行：\n${logText}`)
})
t('试运行时不结束任何进程', () => {
  ok(logText.includes('试运行：跳过结束旧进程'), '试运行却去杀进程了')
})
t('这次是试运行：结果里标了 dryRun', () => {
  ok(result?.dryRun === true, `dryRun=${result?.dryRun}`)
})
t('试运行时帮手没有真的去拉起应用（就算没探到也只会记一笔）', () => {
  ok(logText.includes('试运行：跳过第 1 次拉起'), '试运行没有跳过拉起')
  ok(!/\] 第 \d+ 次拉起 E:/.test(logText), '试运行却真的执行了拉起')
})

const after = await countApp()
console.log(`  真 DSH 进程数（收工）：${after}`)
t('没有偷偷开出第二个 DSH 实例', () => {
  ok(after === before, `进程数从 ${before} 变成了 ${after}`)
})

try { helper.kill() } catch { /* ignore */ }
try { dummy.kill() } catch { /* ignore */ }

console.log(`\n帮手日志：\n${logText.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n')}`)
console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log('❌ 有失败：' + fails.join('、')); process.exitCode = 1 } else { console.log('✅ 重启帮手真机演练通过（全程未重启）') }

// 留证据但清临时目录：日志拷一份到项目里方便复看
try {
  writeFileSync(join(process.cwd(), 'test', '_last-restart-dry.log'), logText, 'utf8')
} catch { /* ignore */ }
rmSync(dir, { recursive: true, force: true })