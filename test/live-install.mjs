/**
 * test/live-install.mjs —— 在**临时沙箱**里真跑一次 pnpm install
 * ============================================================================
 * 前面的测试都只到「造出临时目录」为止，没真跑过 pnpm。可主人要的是
 * 「更新前先试跑」，试跑如果本身跑不起来，等于没有。
 *
 * 这个脚本干的事：
 *   ① 拿真 profile 的 package.json（21 个依赖 + 2 个补丁）复制到临时目录
 *   ② 把 dsh-pocket 换成一个**真实存在的新版本**
 *   ③ 真跑 pnpm install（联网，会下载，慢）
 *   ④ 真 import 一次插件入口，看能不能加载
 *   ⑤ 无论成败，临时目录删干净
 *
 * 🔴 全程只碰临时目录，主人的 profile 一个字节都不动。
 *
 * 用法：node test/live-install.mjs [目标版本]
 *       不给版本就自动查 dsh-pocket 的最新版
 * ============================================================================
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { findToolchain, sandboxTrial, renderTrial, TRIAL_VERDICT } from '../lib/sandbox-trial.js'
import { readPatchedDependencies, scanProfile } from '../lib/profile.js'

const PROFILE = 'E:/dsh/profiles/desktop'
const NAME = process.argv[3] ?? 'dsh-meme'

const wantVersion = process.argv[2] ?? null

console.log('═'.repeat(64))
console.log('沙箱真装测试：拿真 profile 在临时目录里跑一次完整更新')
console.log('═'.repeat(64))
console.log(`真 profile：${PROFILE}`)
console.log(`目标包：${NAME}`)

if (!existsSync(PROFILE)) {
  console.log('\n⚠️ 这个 profile 不在这台机器上，跳过')
  process.exit(0)
}

const pkgs = scanProfile(PROFILE)
const me = pkgs.find((p) => p.name === NAME)
if (!me) {
  console.log(`\n⚠️ profile 里没装 ${NAME}，跳过`)
  process.exit(0)
}
console.log(`当前版本：${me.actualVersion}（声明 ${me.spec}）`)
console.log(`补丁：${me.patched ? '有' : '无'}`)

const tc = findToolchain()
console.log(`node：${tc.node}`)
console.log(`pnpm：${tc.pnpm ?? '（没找到，只能跳过）'}`)
if (!tc.pnpm) {
  console.log('\n⚠️ 找不到 pnpm，无法真装。这不是失败，是环境限制。')
  process.exit(0)
}

// 挑目标版本
let toVersion = wantVersion
if (!toVersion) {
  // 查 registry 拿最新版
  const res = await fetch(`https://registry.npmjs.org/${NAME}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  }).catch(() => null)
  if (res?.ok) {
    const data = await res.json().catch(() => null)
    toVersion = data?.['dist-tags']?.latest ?? null
  }
}
if (!toVersion) {
  console.log('\n⚠️ 查不到目标版本，跳过')
  process.exit(0)
}
console.log(`目标版本：${toVersion}\n`)

if (toVersion === me.actualVersion) {
  console.log('⚠️ 目标版本跟当前版本一样，没有意义，跳过')
  process.exit(0)
}

console.log('开始试跑（会真下载，可能要几分钟）…\n')
const started = Date.now()

const trial = await sandboxTrial({
  profileDir: PROFILE,
  name: NAME,
  fromVersion: me.actualVersion,
  toVersion,
  toolchain: tc,
  installTimeoutMs: 600_000,
  loadTimeoutMs: 120_000,
})

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(renderTrial(trial))
console.log(`\n耗时：${elapsed}s`)

// 临时目录必须已经被删掉
const stagePath = trial.detail?.match(/临时 profile：(.+?)(?:；|$)/)?.[1]
if (stagePath) {
  if (existsSync(stagePath)) {
    console.log(`\n⚠️ 临时目录没被清掉，手动删：${stagePath}`)
    try { rmSync(stagePath, { recursive: true, force: true }); console.log('已删除') } catch { /* 忽略 */ }
  } else {
    console.log('\n✓ 临时目录已清理干净')
  }
}

console.log('\n' + '═'.repeat(64))
if (trial.verdict === TRIAL_VERDICT.PASS) {
  console.log('✅ 试跑通过 —— 这个版本在沙箱里装得上、加载得起来')
  console.log('   （这不等于没问题，只等于「没装崩」。功能对不对还得看审查结论）')
} else if (trial.verdict === TRIAL_VERDICT.SKIP) {
  console.log('⏭️ 跳过 —— 环境不具备，没有得出结论')
} else {
  console.log(`❌ 试跑不通过：${trial.verdict}`)
  console.log(`   理由：${trial.reason ?? '(无)'}`)
  if (trial.stderr) console.log(`   错误输出：\n${String(trial.stderr).split('\n').slice(0, 15).join('\n')}`)
  console.log('\n   按设计，这种情况下**不应该更新** —— 宁可不升，也别装崩。')
}
