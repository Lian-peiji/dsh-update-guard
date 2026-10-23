/**
 * 加载探针的三类包，别再误杀。
 *
 * 背景（2026-10-23 真机）：cc-safety-net 2.6.17 被旧探针判成
 * 「模块能加载，但没有导出 apply 函数 —— 这不是一个 DSH 插件」，更新被卡住。
 * 它其实是 bundle 插件（package.json 的 dsh.bundle.patch 指到 cordis.patch.yml），
 * 入口本来就只有 default，没有 apply。旧判定会把所有 bundle 插件、
 * 以及被当依赖装进来的普通库全部误杀。
 *
 * 现在的规矩：import 不抛异常 = 装得上、加载得起来；
 * 有没有 apply 只影响一句说明，不影响判决。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadInStage } from '../lib/sandbox-trial.js'
import { findToolchain } from '../lib/sandbox-trial.js'

let pass = 0
let fail = 0
function eq(a, b, what) {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    pass++
    console.log(`  ✅ ${what}`)
  } else {
    fail++
    console.log(`  ❌ ${what} —— 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
  }
}
function ok(v, what) {
  eq(Boolean(v), true, what)
}

const tc = findToolchain({ home: 'E:/dsh' })
if (!tc?.node) {
  console.log('⚠️ 找不到 node，跳过加载探针测试')
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'ug-loadprobe-'))

function pkg(name, manifest, entryCode) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    ...manifest,
  }), 'utf8')
  writeFileSync(join(dir, 'index.js'), entryCode, 'utf8')
}

// ① bundle 插件：只有 default，没有 apply（就是 cc-safety-net 那种）
pkg('fake-bundle', { dsh: { bundle: { patch: './cordis.patch.yml' } } },
  'export const SomePlugin = { name: "x" }\nexport default { id: "fake-bundle" }\n')

// ② 普通库：没有 dsh 字段、没有 apply
pkg('fake-lib', {}, 'export function helper() { return 1 }\n')

// ③ 真正的 DSH 插件：有 apply
pkg('fake-plugin', { dsh: {} }, 'export function apply() {}\nexport const name = "fake-plugin"\n')

console.log('\n【加载探针：三类包】')
{
  const r1 = await loadInStage(root, { name: 'fake-bundle', toolchain: tc })
  ok(r1.ok, 'bundle 插件（只有 default）能加载 → 判通过')
  eq(r1.verdict, 'pass', 'bundle 插件 verdict = pass')
  eq(r1.plugin, true, 'bundle 插件认成插件（因为声明了 dsh 字段）')
  eq(r1.note, '', 'bundle 插件不啰嗦说明')

  const r2 = await loadInStage(root, { name: 'fake-lib', toolchain: tc })
  ok(r2.ok, '普通库（无 apply 无 dsh）也能加载 → 判通过，不误杀')
  eq(r2.plugin, false, '普通库标成「不是 DSH 插件」')
  ok(String(r2.note).includes('不是 DSH 插件'), '普通库带一句说明')

  const r3 = await loadInStage(root, { name: 'fake-plugin', toolchain: tc })
  ok(r3.ok, '正常插件通过')
  eq(r3.plugin, true, '正常插件认成插件')
}

// ④ 加载会炸的包，必须照样判失败（别把闸门改成永远放行）
console.log('\n【加载探针：坏包仍要拦】')
{
  pkg('fake-broken', { dsh: {} }, 'throw new Error("顶层就炸了")\n')
  const r = await loadInStage(root, { name: 'fake-broken', toolchain: tc })
  eq(r.ok, false, '顶层抛异常的包 → 判失败')
  eq(r.verdict, 'load-fail', '坏包 verdict = load-fail')
  ok(String(r.reason).includes('顶层就炸了'), '错误原话带出来')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)