/**
 * test/regress-0.1.6.mjs —— 两个真机 bug 的回归测试
 * ============================================================================
 * 🔴 为什么要有这个文件：这两个 bug 都是「测试全绿、真机静默出错」的类型。
 *    ① index.js 的 `dir` 未定义 → 被 catch 吞掉 → 僵尸清理 8 天没跑过；
 *    ② apply.js 的 verifyInstalled 只认 mod.apply → bundle 型插件连滚 18 次。
 *    单靠跑一遍业务测试抓不到，必须针对性地钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectInstalledPackage } from '../lib/sandbox-trial.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

let pass = 0
const fails = []
const t = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log('  ✓', name)
  } catch (e) {
    fails.push([name, e])
    console.log('  ✗', name, '\n      ', e.message)
  }
}

// cc-safety-net 是本机的活样本；没有它的机器上自动跳过
const CC = 'E:/dsh/profiles/desktop/node_modules/cc-safety-net'
const hasCC = existsSync(CC)

// ── bug ①：僵尸清理那行的变量名 ──────────────────────────────────────────
// 静态扫源码：那个 ctx.effect 里必须用 pumpDir，不能出现裸 `dir`。
await t('bug① 僵尸清理用 pumpDir 而不是未定义的 dir', () => {
  const src = readFileSync(join(libDir, 'index.js'), 'utf8')
  const m = /recoverZombieJobs\(\s*([A-Za-z_$][\w$]*)/.exec(src)
  assert.ok(m, '源码里找不到 recoverZombieJobs( 调用')
  assert.equal(m[1], 'pumpDir', `僵尸清理传的是 ${m[1]}，应为 pumpDir`)
})

await t('bug① 清理失败不再静默吞掉（catch 里要报错）', () => {
  const src = readFileSync(join(libDir, 'index.js'), 'utf8')
  const i = src.indexOf('recoverZombieJobs(')
  assert.ok(i > 0)
  const tail = src.slice(i, i + 1400)
  assert.ok(/logger\?\.error/.test(tail), 'catch 里没有升级到 error 级别，仍会静默')
})

// ── bug ②：verifyInstalled 必须与 trial 共用判定 ─────────────────────────
await t('bug② apply.js 用共用的 inspectInstalledPackage，不再自己写一份', () => {
  const src = readFileSync(join(libDir, 'apply.js'), 'utf8')
  assert.ok(/inspectInstalledPackage/.test(src), 'apply.js 没引用共用 helper')
  assert.ok(/declaresDsh/.test(src), 'apply.js 的 probe 里没有 declaresDsh 判定')
  // 老的那句判定必须已经消失
  assert.equal(
    /typeof mod\.apply !== 'function' && typeof mod\.default\?\.apply !== 'function'/.test(src),
    false,
    'apply.js 还留着只管 mod.apply 的老判定',
  )
})

await t('bug② probe 里三种插件形态都放行', () => {
  const src = readFileSync(join(libDir, 'apply.js'), 'utf8')
  assert.ok(/typeof mod\.default === 'function'/.test(src), '没认「default 本身是函数」')
  assert.ok(/DECLARES_DSH/.test(src), '没把 declaresDsh 传给 probe')
})

// ── inspectInstalledPackage 本身的行为 ───────────────────────────────────
await t('普通插件：exports[.] 就是入口，declaresDsh 为真', () => {
  const pkgDir = 'E:/dsh/profiles/desktop/node_modules/dsh-meme'
  if (!existsSync(pkgDir)) return // 换机器就跳过
  const info = inspectInstalledPackage(pkgDir)
  assert.ok(existsSync(info.entryPath), `入口不存在：${info.entryPath}`)
  assert.equal(info.declaresDsh, true)
})

await t('★ 活样本 cc-safety-net：能从 bundle 补丁里找到真正入口', () => {
  if (!hasCC) return
  const info = inspectInstalledPackage(CC)
  // exports["."] 指向 dist/index.js —— 那个只导出 {id,effect,server}，没有 apply
  assert.ok(/dist[\\/]index\.js$/.test(info.entryPath), `entryPath 意外：${info.entryPath}`)
  // 真正的入口在补丁里，相对补丁所在目录
  assert.ok(info.bundlePatch, '没解析出 dsh.bundle.patch')
  assert.ok(info.bundleEntry, '没从补丁里解析出 bundleEntry（这正是 18 次误判的根因）')
  assert.ok(existsSync(info.bundleEntry), `bundleEntry 不存在：${info.bundleEntry}`)
  assert.ok(/deepseek-harness[\\/]index\.js$/.test(info.bundleEntry), `bundleEntry 路径不对：${info.bundleEntry}`)
  assert.equal(info.declaresDsh, true)
})

await t('★ 活样本：bundleEntry 里的 default 真的带 apply', async () => {
  if (!hasCC) return
  const info = inspectInstalledPackage(CC)
  if (!info.bundleEntry) return
  const url = 'file://' + info.bundleEntry.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')
  const mod = await import(url)
  const callable = typeof mod.apply === 'function'
    || typeof mod.default === 'function'
    || typeof mod.default?.apply === 'function'
  assert.equal(callable, true, 'bundle entry 的 default 竟然没有 apply')
})

// ── 顺带钉住：sandbox-trial 也走同一个 helper ────────────────────────────
await t('sandbox-trial 的 loadInStage 也改用共用 helper', () => {
  const src = readFileSync(join(libDir, 'sandbox-trial.js'), 'utf8')
  const i = src.indexOf('export async function loadInStage')
  assert.ok(i > 0)
  const body = src.slice(i, i + 2000)
  assert.ok(/inspectInstalledPackage\(pkgDir\)/.test(body), 'loadInStage 没调 helper')
})

console.log(`\n${fails.length === 0 ? '✅' : '❌'} 回归测试：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) process.exit(1)
