import { scanProfile } from '../lib/profile.js'
import { reconPackage } from '../lib/recon.js'
import { compare } from '../lib/semver.js'

const dir = 'E:/dsh/profiles/desktop'
const pkgs = scanProfile(dir)
console.log('依赖数：', pkgs.length)
const results = []
for (const p of pkgs) {
  const r = await reconPackage('https://registry.npmmirror.com/', p, {})
  results.push({ name: p.name, cur: r.current, latest: r.latest, bump: r.bump, hasUpdate: r.hasUpdate, reason: r.reason, patched: p.patched })
}
const up = results.filter(r => r.hasUpdate)
console.log('\n有更新：', up.length)
for (const u of up.sort((a,b)=>compare(b.latest,a.latest))) console.log(`  ${u.name} ${u.cur} -> ${u.latest} (${u.bump})${u.patched?' [有补丁]':''}`)
console.log('\n跳过/判不了：', results.length - up.length)
for (const s of results.filter(r=>!r.hasUpdate).slice(0,25)) console.log(`  ${s.name}: ${s.reason}`)
