/**
 * test/live-trial.mjs —— 拿**真实 profile** 做一次只读的真实性验证
 * ============================================================================
 * 前面 test/p2.mjs 全是假 profile。假的能证明逻辑对，证明不了「真环境跑得通」。
 * 这个脚本用主人真实装着的包，跑一次**只读**的检查：
 *
 *   ✅ 会做的：读 profile、找 node/pnpm、复制到临时目录、看补丁重定位结果
 *   ❌ 不会做的：pnpm install、改主人的 package.json、碰 node_modules
 *
 * 目的：确认 stageProfile 在真 manifest 上不炸（真 manifest 里有 workspace、
 * 有 devDependencies、有各种奇怪的 spec —— 假 manifest 测不出来）。
 * ============================================================================
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { stageProfile, findToolchain } from '../lib/sandbox-trial.js'
import { retargetPatches, snapshot } from '../lib/apply.js'
import { readProfileManifest, readPatchedDependencies, scanProfile } from '../lib/profile.js'

const PROFILE = 'E:/dsh/profiles/desktop'

let pass = 0
let fail = 0

function t(name, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`)
  }
}

console.log(`\n真实 profile：${PROFILE}`)
if (!existsSync(PROFILE)) {
  console.log('⚠️ 这个 profile 不在这台机器上，跳过真实环境验证')
  process.exit(0)
}

const pkgs = scanProfile(PROFILE)
console.log(`装了 ${pkgs.length} 个包\n`)

t('工具链：找得到 node', () => {
  const tc = findToolchain()
  if (!tc.node) throw new Error('找不到 node')
  console.log(`      node = ${tc.node}`)
  console.log(`      pnpm = ${tc.pnpm ?? '（没找到）'}`)
})

t('读真 manifest 不炸', () => {
  const mf = readProfileManifest(PROFILE)
  if (!mf || typeof mf !== 'object') throw new Error('读出来不是对象')
  if (!mf.dependencies) throw new Error('没有 dependencies')
})

t('读真补丁表不炸', () => {
  const table = readPatchedDependencies(PROFILE)
  const keys = Object.keys(table)
  console.log(`      线上补丁 ${keys.length} 个：${keys.join(', ') || '（无）'}`)
})

// 挑一个真装着的、有补丁的包做重定位演练（只 dryRun，不写盘）
const patched = readPatchedDependencies(PROFILE)
const target = Object.keys(patched)[0]

if (target) {
  const at = target.lastIndexOf('@')
  const pname = at > 0 ? target.slice(0, at) : target
  const pver = at > 0 ? target.slice(at + 1) : ''

  console.log(`\n用真实补丁演练：${target}`)

  t(`retargetPatches dryRun：${pname} 假装升到 9.9.9`, () => {
    const before = readFileSync(join(PROFILE, 'package.json'), 'utf8')
    const r = retargetPatches(PROFILE, pname, '9.9.9', { dryRun: true })
    const after = readFileSync(join(PROFILE, 'package.json'), 'utf8')
    if (before !== after) throw new Error('dryRun 改了主人的 package.json —— 这是绝对不能发生的')
    const c = r.changes.find((x) => x.key === target)
    if (!c) throw new Error(`没找到 ${target} 的重定位记录`)
    console.log(`      改的文件：${(c.targetFiles ?? []).join(', ') || '（读不出）'}`)
    console.log(`      新 key：${c.newKey}`)
    console.log(`      新文件：${c.newRel}`)
    if (!c.newKey.includes('9.9.9')) throw new Error('新 key 没带上目标版本')
    if (!c.patchExists) throw new Error(`补丁文件不存在：${c.oldFile}`)
  })

  t(`stageProfile 在真 manifest 上能造出临时环境（${pname} → 9.9.9）`, () => {
    let staged = null
    try {
      const r = stageProfile(PROFILE, { name: pname, toVersion: '9.9.9' })
      staged = r.stage
      const mf = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))
      if (mf.dependencies[pname] !== '9.9.9') throw new Error('版本没换过去')
      // 别的包一个都不许动
      const orig = readProfileManifest(PROFILE)
      const changed = Object.keys(orig.dependencies).filter(
        (k) => k !== pname && mf.dependencies[k] !== orig.dependencies[k],
      )
      if (changed.length > 0) throw new Error(`动了别的依赖：${changed.join(', ')}`)
      console.log(`      临时目录里 ${Object.keys(mf.dependencies).length} 个依赖，只改了 ${pname}`)
      if (r.retargeted.length > 0) {
        console.log(`      补丁重定位：${r.retargeted.map((x) => `${x.from} → ${x.to}`).join('; ')}`)
        // 真环境的补丁必须被认出来并改名，否则等于「试跑时补丁没跟着走」
        const hit = r.retargeted.find((x) => x.from.startsWith(`${pname}@`))
        if (!hit) throw new Error(`补丁没被重定位：${JSON.stringify(r.retargeted)}`)
        if (!hit.newRel.includes('9.9.9')) throw new Error(`新补丁路径没带上目标版本：${hit.newRel}`)
        // 临时目录里的 yaml 也必须已经改好了（不然 pnpm 会 ERR_PNPM_UNUSED_PATCH）
        const ws = readFileSync(join(staged, 'pnpm-workspace.yaml'), 'utf8')
        if (ws.includes(`${pname}@${hit.from.slice(hit.from.lastIndexOf('@') + 1)}:`)) {
          throw new Error('临时 yaml 里还留着旧版本的补丁 key')
        }
        if (!ws.includes(hit.to)) throw new Error(`临时 yaml 里没有新版本的补丁 key（找 ${hit.to}）`)
      }
    } finally {
      if (staged) rmSync(staged, { recursive: true, force: true })
    }
  })

  t('snapshot 能备份真实包（备份完立刻删掉，不留垃圾）', () => {
    const snap = snapshot(PROFILE, pname)
    try {
      if (!existsSync(join(snap.root, 'package.json'))) throw new Error('没备份 manifest')
      console.log(`      备份内容：${snap.saved.join(', ')}`)
      console.log(`      当前版本：${snap.currentVersion}`)
    } finally {
      // 🔴 只删**本次**产生的那个备份目录。
      //    这里原本是「删掉整个 .update-guard」，结果把真实升级留下的备份
      //    一起清空了 —— 测试跑完，回滚就没得可用。测试的清理范围必须精确到
      //    自己制造的东西，不能按目录大类一把扫。
      rmSync(snap.root, { recursive: true, force: true })
    }
  })
} else {
  console.log('\n（这个 profile 上没有补丁，跳过补丁相关演练）')
}

console.log('\n────────────────────────────────────────')
if (fail > 0) {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
} else {
  console.log(`✅ ${pass} 通过 / 0 失败`)
}
