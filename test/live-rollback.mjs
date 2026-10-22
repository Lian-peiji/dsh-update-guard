/**
 * test/live-rollback.mjs —— 对一次**真的装成功**的升级做回退
 * ============================================================================
 * 🔴 为什么必须单独验一次：
 *    live-apply 里的回滚都是「装失败后自动退回」，那时 pnpm 根本没动过文件。
 *    真正危险的是「装成功了、用了一阵、发现不对再退回」—— 那时 node_modules
 *    里已经是新版本，lockfile 也是新的，回滚要能把这两样都倒回去。
 *
 * 用法：
 *   node test/live-rollback.mjs [包名] [要退回的版本]
 *   node test/live-rollback.mjs dsh-meme 0.1.56
 *
 * 验证：版本、manifest、补丁表三者都复原，才算回滚成功。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rollback, listBackups } from '../lib/apply.js'
import { installedVersion, readPatchedDependencies } from '../lib/profile.js'
import { findToolchain } from '../lib/sandbox-trial.js'

const PROFILE = 'E:/dsh/profiles/desktop'
const NAME = process.argv[2] ?? 'dsh-meme'
const BACK = process.argv[3] ?? null

const line = (s) => console.log(s)
line('═'.repeat(64))
line('真实回滚演练：对一次「已经装成功」的升级做回退')
line('═'.repeat(64))

const verNow = installedVersion(PROFILE, NAME)
line(`包：${NAME}`)
line(`当前：${verNow}`)
const patchesBefore = JSON.stringify(readPatchedDependencies(PROFILE))
line(`回滚前补丁表：${patchesBefore}`)

// 列出所有备份，让人看清有哪些可选
const backups = listBackups(PROFILE, NAME)
line(`\n可用备份：${backups.length} 份`)
for (const b of backups.slice(0, 5)) line(`  ${b.stamp}（${b.version ?? '?'}）`)

if (backups.length === 0) {
  line('\n❌ 没有任何备份，没法回滚')
  process.exit(1)
}

// 不指定版本就退回「不是当前版本」的最近一份
const snap = BACK
  ? backups.find((b) => b.version === BACK)
  : backups.find((b) => b.version !== verNow)

if (!snap) {
  line(`\n❌ 找不到${BACK ? ` ${BACK} 的` : '其他版本的'}备份`)
  process.exit(1)
}

line(`\n用备份 ${snap.stamp} 回滚到 ${snap.version}…`)

const tc = findToolchain()
const rb = await rollback(PROFILE, { root: snap.root }, { toolchain: tc, name: NAME })

line('')
for (const s of rb.steps ?? []) line(`  ${s.ok ? '✓' : '✗'} ${s.step}：${s.detail ?? ''}`)

line('\n' + '═'.repeat(64))
line('事后核对')
line('═'.repeat(64))
let bad = 0
const check = (ok, msg) => { line(`${ok ? '✓' : '❌'} ${msg}`); if (!ok) bad++ }

const verAfter = installedVersion(PROFILE, NAME)
check(verAfter === snap.version, `版本：${verNow} → ${verAfter}（期望 ${snap.version}）`)

const mf = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
check(mf.dependencies[NAME] === snap.version, `manifest 声明：${mf.dependencies[NAME]}（期望 ${snap.version}）`)

const patchesAfter = JSON.stringify(readPatchedDependencies(PROFILE))
check(patchesAfter === patchesBefore, '补丁表原样')

line('')
if (bad === 0) line(`✅ 回滚成功 —— 已退回 ${snap.version}，环境与升级前一致`)
else { line(`❌ 回滚暴露 ${bad} 项问题`); process.exitCode = 1 }
line('\n⚠️ 如果你在用 DSH，建议刷新一下页面确认插件还能用。')
