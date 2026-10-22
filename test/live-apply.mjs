/**
 * test/live-apply.mjs —— 真的动一次 profile，把「先斩后奏」跑一遍
 * ============================================================================
 * 前面所有测试都是「不碰真环境」。可主人要的那句「装崩了自动退回去」，
 * 没真跑过就等于没有 —— 兜底代码里一个手滑，等你真出事那天才发现它自己也是坏的。
 *
 * 这个脚本做的事：
 *   ① 备份当前状态
 *   ② 补丁重定位
 *   ③ 真 pnpm install
 *   ④ 装完加载验证
 *   ⑤ 打印全过程，最后告诉你 profile 现在是好是坏
 *
 * 🔴 这是唯一一个会改主人 profile 的测试。跑之前问过主人了（m01949/m01956）。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { applyUpdate, snapshot, listBackups, renderApply, APPLY_RESULT } from '../lib/apply.js'
import { findToolchain } from '../lib/sandbox-trial.js'
import { readPatchedDependencies, installedVersion, scanProfile } from '../lib/profile.js'

const PROFILE = 'E:/dsh/profiles/desktop'
const NAME = process.argv[2] ?? 'dsh-meme'
const TO = process.argv[3] ?? null

const md5 = (p) => {
  try { return createHash('md5').update(readFileSync(p)).digest('hex') } catch { return null }
}

console.log('═'.repeat(64))
console.log('真实升级演练：真的动 profile，看「先斩后奏」能不能兜住')
console.log('═'.repeat(64))

const pkgs = scanProfile(PROFILE)
const me = pkgs.find((p) => p.name === NAME)
if (!me) {
  console.log(`⚠️ profile 里没装 ${NAME}`)
  process.exit(0)
}

console.log(`包：${NAME}`)
console.log(`当前：${me.actualVersion}（声明 ${me.spec}）`)
console.log(`补丁：${me.patched ? '有' : '无'}`)

// 目标版本
let toVersion = TO
if (!toVersion) {
  const res = await fetch(`https://registry.npmjs.org/${NAME}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  }).catch(() => null)
  if (res?.ok) {
    const d = await res.json().catch(() => null)
    toVersion = d?.['dist-tags']?.latest ?? null
  }
}
if (!toVersion) {
  console.log('⚠️ 查不到目标版本')
  process.exit(0)
}
console.log(`目标：${toVersion}`)

if (toVersion === me.actualVersion) {
  console.log('\n⚠️ 已经是最新版，没有可演练的升级')
  process.exit(0)
}

// 记录「升级前」的关键指纹，最后用来证明「要么升级成功，要么原样退回」
const patchTableBefore = JSON.stringify(readPatchedDependencies(PROFILE))
const manifestBefore = readFileSync(join(PROFILE, 'package.json'), 'utf8')
const verBefore = installedVersion(PROFILE, NAME)

console.log(`\n升级前指纹：${NAME}@${verBefore}`)
console.log(`升级前补丁表：${patchTableBefore}`)

const tc = findToolchain()
console.log(`\n开始真装（会下载，可能要一两分钟）…\n`)

const started = Date.now()
const result = await applyUpdate({
  profileDir: PROFILE,
  name: NAME,
  toVersion,
  toolchain: tc,
  verify: true,
  installTimeoutMs: 600_000,
})
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log(renderApply(result))
console.log(`\n耗时：${elapsed}s`)

// ── 验收：profile 现在到底是什么状态 ──────────────────────────────
console.log('\n' + '═'.repeat(64))
console.log('事后核对（这是最重要的一段：不管成功失败，profile 必须是能用的）')
console.log('═'.repeat(64))

const verAfter = installedVersion(PROFILE, NAME)
const manifestAfter = readFileSync(join(PROFILE, 'package.json'), 'utf8')
const patchTableAfter = JSON.stringify(readPatchedDependencies(PROFILE))

console.log(`版本：${verBefore} → ${verAfter}`)
console.log(`manifest 有没有被改：${manifestBefore === manifestAfter ? '没改' : '改了'}`)
console.log(`补丁表：${patchTableAfter}`)

let bad = 0

if (result.result === APPLY_RESULT.APPLIED) {
  // 成功路径：必须真的升上去了
  if (verAfter !== toVersion) {
    console.log(`✗ 说是成功了，但版本还是 ${verAfter}（期望 ${toVersion}）`)
    bad++
  } else {
    console.log(`✓ 升级成功，${NAME} 现在是 ${verAfter}`)
  }
} else {
  // 失败路径：必须原样退回
  if (verAfter !== verBefore) {
    console.log(`✗ 升级失败了，但版本变成了 ${verAfter}（期望退回 ${verBefore}）—— 回滚没兜住！`)
    bad++
  } else {
    console.log(`✓ 升级失败，已原样退回 ${verBefore}`)
  }
  if (patchTableAfter !== patchTableBefore) {
    console.log(`✗ 补丁表没恢复：\n   之前：${patchTableBefore}\n   现在：${patchTableAfter}`)
    bad++
  } else {
    console.log('✓ 补丁表原样恢复')
  }
}

// 备份列表
const backups = listBackups(PROFILE, NAME)
console.log(`\n备份：${backups.length} 份`)
for (const b of backups.slice(0, 3)) console.log(`  ${b.stamp}（${b.version ?? '?'}）`)

console.log('\n' + '═'.repeat(64))
if (bad === 0) {
  console.log(`✅ 演练完成 —— profile 状态正确（${result.result}）`)
} else {
  console.log(`❌ 演练暴露问题：${bad} 项不对`)
  process.exitCode = 1
}
console.log('\n⚠️ 如果你在用 DSH，建议刷新一下页面确认插件还能用。')
