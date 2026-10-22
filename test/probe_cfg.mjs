/**
 * test/probe_cfg.mjs —— 脏配置回归：不管宿主把 config 包成什么样，profile 都得定位对。
 *
 * 跑法：node test/probe_cfg.mjs
 *
 * 🔴 为什么要有这个测试：
 *   真机上 `cfg.profileDir` 拿到过一个**对象**，String() 之后成了 "[object Object]"，
 *   被 resolve() 挂到 cwd 上 —— 补丁账本于是显示
 *   `E:\dsh\profiles\desktop\[object Object]`、并且报"没有任何本地补丁"。
 *   工具没崩、看着还在跑，但扫的是空气。这类"静默错目录"最危险，必须钉死。
 */
import { apply } from '../lib/index.js'

function makeCtx() {
  const reg = new Map()
  return {
    logger: { info() {}, warn() {} },
    effect(fn) { try { fn() } catch { /* 假 ctx，忽略 */ } },
    get(n) {
      if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    tools: {
      register(d) { reg.set(d.name, d); return () => {} },
      guard() { return () => {} },
    },
    llm: { async *stream() { yield { type: 'text-delta', text: '{}' } } },
    _reg: reg,
  }
}

const cases = [
  ['空配置', {}, true],
  ['profileDir 是空对象', { profileDir: {} }, true],
  ['profileDir 是 {value:""}', { profileDir: { value: '' } }, true],
  ['profile 是空对象', { profile: {} }, true],
  ['registry 是空对象', { registry: {} }, true],
  ['profileDir 是相对路径', { profileDir: 'foo/bar' }, false],
]

let pass = 0
let bad = 0
for (const [label, cfg, shouldSucceed] of cases) {
  const ctx = makeCtx()
  apply(ctx, cfg)
  const r = await ctx._reg.get('plugin_patches').execute({})
  const first = String(r.report ?? r.message ?? '').split('\n')[0]
  const gotObject = first.includes('[object Object]')
  const okCase = shouldSucceed ? (!gotObject && r.ok !== false) : (r.ok === false)
  if (okCase) { pass++; console.log(`  ✓ ${label}  → ${first}`) }
  else { bad++; console.log(`  ✗ ${label}  → ${first}`) }
}

console.log(`\n${bad === 0 ? '✅' : '❌'} probe_cfg：${pass} 通过 / ${bad} 失败`)
process.exit(bad === 0 ? 0 : 1)