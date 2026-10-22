/**
 * test/assemble.mjs —— 装配冒烟：用**假 ctx** 把 apply() 真跑一遍。
 *
 * 跑法：
 *   node test/assemble.mjs
 *
 * 🔴 为什么需要这一层：
 *   smoke.mjs 只验纯函数，验不到"插件装进 profile 之后会不会 failed to import"。
 *   而后者恰恰是最贵的事故 —— DSH 会把这个 bundle 条目整条摘掉、页面 404。
 *   这里用一个最小可用的假 ctx 把 apply() 跑起来，只要它不抛、工具都注册上了，
 *   就说明"至少能被加载"，再去装真环境。
 */
import { strict as assert } from 'node:assert'

let pass = 0
let failed = 0
const out = []
function t(name, fn) {
  try { fn(); pass++; out.push(`  ✓ ${name}`) }
  catch (e) { failed++; out.push(`  ✗ ${name}\n      ${e?.stack ?? e?.message ?? e}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
//  最小假 ctx：只实现插件实际用到的那些
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeCtx({ withLlm = true, withGuard = true, withDefaultModel = true } = {}) {
  const registered = new Map()
  const guards = []
  const effects = []
  const logs = []
  const services = new Map()
  // P4 起插件监听 agent/status 等事件判空闲。假 ctx 也提供 on()，
  // 只记录不真跑 —— 事件真流由宿主负责，这里只验「接得上、退得掉」。
  const eventHandlers = new Map()

  const ctx = {
    logger: { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`) },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    on(ev, fn) {
      eventHandlers.set(ev, [...(eventHandlers.get(ev) ?? []), fn])
      return () => {
        const list = eventHandlers.get(ev) ?? []
        eventHandlers.set(ev, list.filter((f) => f !== fn))
      }
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        if (!withDefaultModel) return undefined
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      return services.get(name)
    },
    tools: {
      register(def) {
        if (registered.has(def.name)) throw new Error(`重复注册工具 ${def.name}`)
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
      ...(withGuard ? { guard(fn) { guards.push(fn); return () => {} } } : {}),
    },
    llm: withLlm
      ? {
          async *stream(opts) {
            // 模拟一段真实流：先吐文本，再 finish
            yield { type: 'text-delta', text: '{"verdict":"install","confidence":0.9,' }
            yield { type: 'text-delta', text: '"summary":"测试用假模型"}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
          listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
          listModels: async () => [{ id: 'deepseek-chat', name: 'chat' }],
        }
      : undefined,
  }
  return { ctx, registered, guards, effects, logs, services }
}

// ─────────────────────────────────────────────────────────────────────────────
const mod = await import('../lib/index.js')

t('模块能被 import（不抛）', () => {
  assert.ok(mod, '模块是空的')
})
t('导出 name', () => {
  assert.equal(typeof mod.name, 'string')
  assert.equal(mod.name, 'update-guard')
})
t('导出 inject（工具/模型两条硬依赖）', () => {
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('tools'))
  assert.ok(mod.inject.includes('llm'))
})
t('导出 apply', () => {
  assert.equal(typeof mod.apply, 'function')
})

// ── 装配 ───────────────────────────────────────────────────────────────────
const { ctx, registered, guards, effects, logs } = makeFakeCtx()

t('apply() 不抛', () => {
  assert.doesNotThrow(() => mod.apply(ctx, {}))
})
t('注册了该有的工具', () => {
  // 🔴 别把工具数写死：每加一个工具这条断言就得改，改到最后就变成
  //    「为了让它绿而改数字」，等于没测。这里只断言「该有的必须有」，
  //    再单独钉一个下限防止工具集体消失。
  const want = [
    // P1：只读侦察 + 审查 + 新装体检 + 补丁台账
    'plugin_update_scan', 'plugin_update_review', 'plugin_install_check', 'plugin_patches',
    // P2：沙箱试跑 + 真装 + 回滚
    'plugin_update_trial', 'plugin_update_apply', 'plugin_update_rollback',
    // P3：记忆双库
    'plugin_memory',
  ]
  for (const n of want) assert.ok(registered.has(n), `缺工具 ${n}（实际：${[...registered.keys()].join(', ')}）`)
  assert.ok(registered.size >= want.length, `工具数比预期少：${[...registered.keys()].join(', ')}`)
})
t('每个工具都有 name/description/parameters/output/execute', () => {
  for (const [n, d] of registered) {
    assert.equal(typeof d.name, 'string', `${n}.name`)
    assert.ok(d.description && d.description.length > 20, `${n}.description 太短`)
    assert.equal(typeof d.parameters, 'object', `${n}.parameters`)
    assert.equal(d.parameters.type, 'object', `${n}.parameters.type 必须是 object`)
    // 宿主 parameterSchemaSpecToJsonSchema 的产物：{ type:'object', properties:{...} }，
    // 不带 additionalProperties；绝不能出现一个叫 type 的字段（那是 spec/JSONSchema 写混了）
    assert.ok(d.parameters.properties && typeof d.parameters.properties === 'object',
      `${n}.parameters 缺 properties`)
    assert.ok(!('type' in d.parameters.properties),
      `${n}.parameters 里有个名为 type 的字段 —— parameters 写成了 JSON Schema，应该是字段映射`)
    for (const [pk, pv] of Object.entries(d.parameters.properties)) {
      assert.equal(typeof pv, 'object', `${n}.parameters.${pk} 必须是 value schema 对象`)
      assert.ok(
        ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'].includes(pv.type)
          || pv.oneOf !== undefined,
        `${n}.parameters.${pk}.type 不合法：${JSON.stringify(pv.type)}`,
      )
    }
    assert.ok(d.output && typeof d.output.schema === 'object', `${n}.output.schema`)
    assert.equal(typeof d.output.render, 'function', `${n}.output.render`)
    assert.equal(typeof d.execute, 'function', `${n}.execute`)
  }
})
t('必填参数都列在 required 里', () => {
  const review = registered.get('plugin_update_review')
  assert.deepEqual(review.parameters.required, ['name'])
  const check = registered.get('plugin_install_check')
  assert.deepEqual(check.parameters.required, ['spec'])
})
t('装上了硬拦截 guard', () => {
  assert.equal(guards.length, 1, `guard 数量不对：${guards.length}`)
})

// ── guard 行为 ─────────────────────────────────────────────────────────────
const guard = guards[0]

t('guard 放行无关工具', () => {
  assert.equal(guard({ name: 'read', arguments: {} }), undefined)
})
t('guard 放行 plugin_manager 的其它动作', () => {
  assert.equal(guard({ name: 'plugin_manager', arguments: { action: 'list_plugins' } }), undefined)
})
t('guard 拦下没体检过的 install_bundle', () => {
  const r = guard({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'evil-plugin@1.0.0' } })
  assert.equal(typeof r, 'string', '没拦住')
  assert.ok(r.includes('还没体检过'), `拦截理由不对：${r}`)
})
t('guard 自己出错时不拦正常操作', () => {
  // 传个会让内部读参数炸的形状
  assert.doesNotThrow(() => guard({ name: 'plugin_manager', arguments: null }))
})

// ── 工具执行（不打网络的路径）──────────────────────────────────────────────
const scan = registered.get('plugin_update_scan')
const patches = registered.get('plugin_patches')

const runScan = () => scan.execute({}, { signal: new AbortController().signal })
const runPatches = () => patches.execute({}, { signal: new AbortController().signal })

const scanRes = await runScan().catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_update_scan 不抛异常（成功或优雅失败都行）', () => {
  assert.equal(scanRes.threw, undefined, `工具抛异常了：${scanRes.threw}`)
  assert.equal(typeof scanRes.ok, 'boolean', `返回值没有 ok 字段：${JSON.stringify(scanRes).slice(0, 300)}`)
})

const patchRes = await runPatches().catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_patches 能盘点真实 profile 的补丁', () => {
  assert.equal(patchRes.threw, undefined, `工具抛异常了：${patchRes.threw}`)
  assert.equal(patchRes.ok, true, `盘点失败：${patchRes.message ?? ''}`)
  assert.ok(typeof patchRes.report === 'string' && patchRes.report.includes('补丁账本'), '报告没生成')
})

// ── 记忆双库工具（P3）──────────────────────────────────────────────────────
//  🔴 这里必须真跑，不能只看"注册上了"：
//     记忆是这个插件的存在理由（主人 m00002「需要记忆功能」），
//     工具注册成功但一调就炸，等于记忆全废，而且要到主人真用的时候才发现。
const mem = registered.get('plugin_memory')

t('plugin_memory 有四个 action', () => {
  const acts = mem.parameters.properties.action.enum
  for (const a of ['stats', 'history', 'errors', 'record_error']) {
    assert.ok(acts.includes(a), `少了 action：${a}`)
  }
})

const runMem = (args) => mem.execute(args, { signal: new AbortController().signal })

const memStats = await runMem({ action: 'stats' }).catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_memory stats 不抛且给得出报告', () => {
  assert.equal(memStats.threw, undefined, `抛异常了：${memStats.threw}`)
  assert.equal(memStats.ok, true, `失败：${memStats.message ?? ''}`)
  assert.ok(memStats.report.includes('记忆双库'), '报告没生成')
  assert.ok(memStats.report.includes('更新档案'), '报告里没有更新档案段')
  assert.ok(memStats.report.includes('错误知识库'), '报告里没有错误知识库段')
})

const memHist = await runMem({ action: 'history', name: 'dsh-meme', limit: 5 })
  .catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_memory history 查单个包不抛', () => {
  assert.equal(memHist.threw, undefined, `抛异常了：${memHist.threw}`)
  assert.equal(memHist.ok, true, `失败：${memHist.message ?? ''}`)
  assert.ok(memHist.report.includes('dsh-meme'), '报告里没出现包名')
})

const memErr = await runMem({ action: 'errors' }).catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_memory errors 不抛', () => {
  assert.equal(memErr.threw, undefined, `抛异常了：${memErr.threw}`)
  assert.equal(memErr.ok, true, `失败：${memErr.message ?? ''}`)
})

// record_error 缺 title 必须优雅拒绝，不能抛
const memBad = await runMem({ action: 'record_error' }).catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_memory record_error 缺 title 时优雅拒绝', () => {
  assert.equal(memBad.threw, undefined, `抛异常了：${memBad.threw}`)
  assert.equal(memBad.ok, false, '缺 title 居然成功了')
  assert.ok(String(memBad.message).includes('title'), `报错信息没说清缺什么：${memBad.message}`)
})

const memUnknown = await runMem({ action: 'nope' }).catch((e) => ({ threw: String(e?.message ?? e) }))
t('plugin_memory 不认识的 action 优雅拒绝', () => {
  assert.equal(memUnknown.threw, undefined, `抛异常了：${memUnknown.threw}`)
  assert.equal(memUnknown.ok, false)
})

// ── render 不能返回空数组（空结果会让界面卡住）──────────────────────────────
t('所有工具的 render 都返回非空 ContentBlock[]', () => {
  for (const [n, d] of registered) {
    const cases = [{ ok: true, report: 'x' }, { ok: false, message: 'y' }, null, undefined]
    for (const c of cases) {
      const blocks = d.output.render({}, c)
      assert.ok(Array.isArray(blocks), `${n}.render 没返回数组`)
      assert.ok(blocks.length > 0, `${n}.render 返回了空数组（界面会卡住）`)
      assert.equal(blocks[0].type, 'text')
    }
  }
})

// ── 降级路径 ───────────────────────────────────────────────────────────────
t('没有 llm 服务时 apply 也不炸', () => {
  const { ctx: c2 } = makeFakeCtx({ withLlm: false })
  assert.doesNotThrow(() => mod.apply(c2, {}))
})
t('没有 tools.guard 时 apply 也不炸（老宿主兼容）', () => {
  const { ctx: c3, registered: r3 } = makeFakeCtx({ withGuard: false })
  assert.doesNotThrow(() => mod.apply(c3, {}))
  // 老宿主没有 guard 钩子，工具照样要全注册（硬拦截降级成「不拦」，不是「不装」）
  assert.ok(r3.size >= 7, `没有 guard 也应该照常注册工具，实际只有 ${r3.size} 个`)
})
t('没有默认模型服务时 apply 也不炸', () => {
  const { ctx: c4 } = makeFakeCtx({ withDefaultModel: false })
  assert.doesNotThrow(() => mod.apply(c4, {}))
})

// ─────────────────────────────────────────────────────────────────────────────
console.log(out.join('\n'))
console.log(`\n${failed === 0 ? '✅' : '❌'} ${pass} 通过 / ${failed} 失败`)
if (logs.length > 0) {
  console.log('\n插件日志：')
  for (const l of logs.slice(0, 8)) console.log(`  ${l}`)
}
process.exit(failed === 0 ? 0 : 1)
