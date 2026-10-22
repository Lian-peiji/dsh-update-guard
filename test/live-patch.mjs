/**
 * test/live-patch.mjs —— 验证「补丁在沙箱里真的被打上了」
 * ============================================================================
 * 这是整个工具存在的理由：主人打的补丁，更新后不能丢。
 *
 * 前面的 live-install.mjs 证明了「装得上」，但它测的 dsh-meme 没补丁。
 * 这个脚本专门拿**有补丁的包**（dsh-pocket）在沙箱里装一遍，然后
 * 逐字节比对：沙箱里装出来的文件，跟线上**已经被打过补丁**的文件，是不是一样。
 *
 *   一样 → 补丁重放成功，更新后主人的修复还在 ✅
 *   不一样 → 补丁没打上，这个版本不能升 ❌
 *
 * 🔴 全程只碰临时目录。
 * ============================================================================
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { findToolchain, stageProfile, installInStage } from '../lib/sandbox-trial.js'
import { readPatchedDependencies, installedVersion } from '../lib/profile.js'

const PROFILE = 'E:/dsh/profiles/desktop'

const md5 = (p) => {
  try { return createHash('md5').update(readFileSync(p)).digest('hex') } catch { return null }
}

console.log('═'.repeat(64))
console.log('补丁重放验证：在沙箱里装一遍，看补丁有没有跟着走')
console.log('═'.repeat(64))

const table = readPatchedDependencies(PROFILE)
const keys = Object.keys(table)
console.log(`线上补丁 ${keys.length} 个：${keys.join(', ') || '（无）'}`)
if (keys.length === 0) {
  console.log('\n⚠️ 没有补丁，没什么可验的')
  process.exit(0)
}

const tc = findToolchain()
if (!tc.pnpm) {
  console.log('\n⚠️ 找不到 pnpm，跳过')
  process.exit(0)
}

let failed = 0

for (const key of keys) {
  const at = key.lastIndexOf('@')
  const name = at > 0 ? key.slice(0, at) : key
  const ver = at > 0 ? key.slice(at + 1) : ''
  const patchRel = table[key]

  console.log(`\n── ${name}@${ver} ──`)
  console.log(`补丁文件：${patchRel}`)

  // 从补丁内容里抠出它改的是哪些文件
  const patchPath = join(PROFILE, patchRel)
  if (!existsSync(patchPath)) {
    console.log(`  ✗ 补丁文件不存在：${patchPath}`)
    failed++
    continue
  }
  const targets = new Set()
  for (const line of readFileSync(patchPath, 'utf8').split(/\r?\n/)) {
    const m = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/.exec(line)
    if (m && m[1] && m[1] !== '/dev/null') targets.add(m[1].trim())
  }
  console.log(`  补丁改的文件：${[...targets].join(', ')}`)

  // 线上（已打补丁）的文件指纹
  const online = {}
  for (const t of targets) {
    online[t] = md5(join(PROFILE, 'node_modules', ...name.split('/'), t))
  }

  // 沙箱里装一遍（版本不变，只为验证补丁能不能重放）
  let stage = null
  try {
    const staged = stageProfile(PROFILE, { name, toVersion: ver })
    stage = staged.stage
    console.log(`  临时目录：${stage}`)
    console.log(`  补丁重定位：${staged.retargeted.map((r) => `${r.from} → ${r.to}`).join(', ') || '（无需改）'}`)

    const inst = await installInStage(stage, { toolchain: tc, timeoutMs: 600_000 })
    if (!inst.ok) {
      console.log(`  ✗ 沙箱 install 失败：${inst.reason}`)
      if (inst.output) console.log(`    ${String(inst.output).split('\n').slice(0, 10).join('\n    ')}`)
      failed++
      continue
    }
    console.log('  ✓ 沙箱 install 成功')

    // 逐个文件比对
    let allSame = true
    for (const t of targets) {
      const stagedFile = join(stage, 'node_modules', ...name.split('/'), t)
      const got = md5(stagedFile)
      const want = online[t]
      if (!existsSync(stagedFile)) {
        console.log(`  ✗ ${t}：沙箱里没这个文件`)
        allSame = false
        continue
      }
      if (got === want) {
        console.log(`  ✓ ${t}：与线上一致（${got.slice(0, 8)}）—— 补丁打上了`)
      } else {
        console.log(`  ✗ ${t}：与线上不一致`)
        console.log(`      线上（有补丁）：${want}`)
        console.log(`      沙箱（？）：    ${got}`)
        allSame = false
      }
    }
    if (!allSame) failed++
  } catch (e) {
    console.log(`  ✗ 出错：${e?.message ?? e}`)
    failed++
  } finally {
    if (stage) {
      try { rmSync(stage, { recursive: true, force: true }) } catch { /* 系统会清 */ }
    }
  }
}

console.log('\n' + '═'.repeat(64))
if (failed === 0) {
  console.log('✅ 所有补丁都能在沙箱里重放 —— 升级不会丢补丁')
} else {
  console.log(`❌ ${failed} 个包有问题 —— 这些包升级会丢补丁，按设计不该自动升`)
  process.exitCode = 1
}
