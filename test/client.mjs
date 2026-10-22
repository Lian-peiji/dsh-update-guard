/**
 * test/client.mjs —— 客户端 bundle 的回归测试
 *
 * 为什么需要这个测试：
 *   client.js 是 `window.__ModuleLoader__.load({...})` 的浏览器 bundle，
 *   语法对不代表能跑。真机上它挂了的表现是**设置页整个白屏**，
 *   而且因为它在浏览器里，宿主日志里什么都没有 —— 最难查的一类问题。
 *   所以在 Node 里搭一个最小的假 window/document/React 把它跑一遍。
 *
 * 测什么：
 *   ① 模块能被 ModuleLoader 接收，id 等于包名（否则宿主报
 *      "loaded without registering <name>"）
 *   ② exports.apply / exports.inject 都在
 *   ③ apply 能正常注册 settings.section，且卸载时摘干净
 *   ④ 没有 slots 服务时安静退出，不 throw
 *   ⑤ 面板能渲染出来（用假 React 收集元素树）
 *   ⑥ 格式化函数行为正确
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

let pass = 0, failed = 0
const ok = (c, m) => { if (c) { pass++ } else { failed++; console.error('  ✗ ' + m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n      实际=${JSON.stringify(a)}\n      期望=${JSON.stringify(b)}`)

// ── 最小假 React ────────────────────────────────────────────────────────
//  只要 createElement / useState / useEffect / useCallback，
//  而且 createElement 只负责把「树」记下来，不真渲染。
function makeFakeReact() {
  const state = { hooks: [], cursor: 0 }
  return {
    __state: state,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(init) {
      const i = state.cursor++
      if (state.hooks[i] === undefined) state.hooks[i] = typeof init === 'function' ? init() : init
      const set = (v) => { state.hooks[i] = typeof v === 'function' ? v(state.hooks[i]) : v }
      return [state.hooks[i], set]
    },
    useEffect(fn) {
      const i = state.cursor++
      // 不真跑副作用（会发 fetch），只记一笔，验证调用点存在
      state.hooks['effect' + i] = fn
    },
    useCallback(fn) {
      const i = state.cursor++
      state.hooks['cb' + i] = fn
      return fn
    },
    __resetCursor() { state.cursor = 0 },
  }
}

// ── 最小假 window / document ────────────────────────────────────────────
function makeEnv() {
  const styles = []
  const env = {
    loaded: [],
    styles,
    window: {
      __ModuleLoader__: {
        load(spec) { env.loaded.push(spec) },
      },
    },
    document: {
      head: { appendChild(el) { styles.push(el) } },
      createElement(tag) {
        const el = { tag, textContent: '', setAttribute(k, v) { el[k] = v }, remove() { const i = styles.indexOf(el); if (i >= 0) styles.splice(i, 1) } }
        return el
      },
    },
    fetchCalls: [],
  }
  return env
}

/** 在假环境里执行 client.js，返回它导出的模块 */
function loadClient() {
  const env = makeEnv()
  const React = makeFakeReact()
  const src = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

  // 用 Function 而不是 import：client.js 是浏览器 bundle，顶层就摸 window
  const fn = new Function('window', 'document', 'fetch', 'require', src)
  const fakeFetch = async (url) => {
    env.fetchCalls.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true, ledger: [], stats: {}, errors: [], patches: [], backups: [],
      }),
    }
  }
  const fakeRequire = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  fn(env.window, env.document, fakeFetch, fakeRequire)

  if (env.loaded.length !== 1) throw new Error(`期望 ModuleLoader 收到 1 个模块，实际 ${env.loaded.length}`)
  const spec = env.loaded[0]
  const exports = spec.factory(fakeRequire)
  return { env, spec, exports, React }
}

// ══ ① 模块注册 ═══════════════════════════════════════════════════════════
console.log('\n① 模块注册')
{
  const { spec, exports } = loadClient()
  eq(spec.id, PKG.name, 'ModuleLoader 的 id 必须等于包名')
  ok(typeof spec.factory === 'function', 'factory 是函数')
  ok(typeof exports.apply === 'function', '导出 apply')
  ok(Array.isArray(exports.inject), '导出 inject 数组')
  ok(exports.inject.includes('slots'), 'inject 里有 slots')
  ok(exports.__test && typeof exports.__test.fmtTime === 'function', '导出 __test 辅助')
}

// ══ ② apply 注册设置页 ═══════════════════════════════════════════════════
console.log('\n② apply 注册设置页')
{
  const { exports, env } = loadClient()
  const registered = []
  const effects = []
  const disposers = []
  const ctx = {
    effect(fn) {
      effects.push(fn)
      const off = fn()
      if (typeof off === 'function') disposers.push(off)
    },
    get(name) {
      if (name !== 'slots') return undefined
      return {
        inject(slotName, cb) {
          ok(slotName === 'settings.section', 'inject 的是 settings.section')
          cb()
        },
        register(spec, render) {
          registered.push({ spec, render })
          return () => { registered.pop() }
        },
      }
    },
  }
  exports.apply(ctx)

  eq(registered.length, 1, '注册了 1 个设置页')
  eq(registered[0].spec.name, 'settings.section', 'slot 名正确')
  eq(registered[0].spec.id, 'update-guard', 'section id 是 update-guard')
  ok(typeof registered[0].spec.label === 'string' && registered[0].spec.label.length > 0, '有中文标签')
  ok(typeof registered[0].render === 'function', 'render 是函数')

  // 样式被挂上，且卸载时摘掉
  ok(env.styles.length >= 1, '注入了样式')
  ok(env.styles[0].textContent.includes('.ug-panel'), '样式里有 .ug-panel')
  ok(effects.length >= 1, '用了 ctx.effect 管理生命周期')
  disposers.forEach((d) => d())
  eq(env.styles.length, 0, '卸载后样式被摘干净（热重载不叠 style）')
}

// ══ ③ 没有 slots 时安静退出 ══════════════════════════════════════════════
console.log('\n③ 没有 slots 服务')
{
  const { exports } = loadClient()
  let threw = null
  try {
    exports.apply({
      effect(fn) { const off = fn(); if (typeof off === 'function') off() },
      get() { return undefined },
    })
  } catch (e) { threw = e }
  ok(threw === null, '没有 slots 时不 throw（设置页消失但插件不崩）')
}

// ══ ④ 面板能渲染 ═════════════════════════════════════════════════════════
console.log('\n④ 面板渲染')
{
  const { exports, React } = loadClient()
  let renderFn = null
  exports.apply({
    effect(fn) { const off = fn(); if (typeof off === 'function') off() },
    get(name) {
      if (name !== 'slots') return undefined
      return {
        inject(_n, cb) { cb() },
        register(_spec, render) { renderFn = render; return () => {} },
      }
    },
  })
  ok(typeof renderFn === 'function', '拿到 render')

  // 渲染：不崩就是通过（真渲染要 React，这里只看它能不能走完）
  React.__resetCursor()
  let tree = null
  let threw = null
  try { tree = renderFn() } catch (e) { threw = e }
  ok(threw === null, 'render 不 throw' + (threw ? `（${threw.message}）` : ''))
  // 注册的 render 返回的是「组件元素」（type 是函数），要再调一层才是真正的树
  ok(tree && typeof tree.type === 'function', 'render 返回组件元素')
  let panel = null
  try { panel = tree.type(tree.props ?? {}) } catch (e) { threw = e }
  ok(threw === null, '组件函数执行不 throw' + (threw ? `（${threw.message}）` : ''))
  ok(panel && panel.type === 'div', '渲染出根 div')
  ok(panel && panel.props.className === 'ug-panel', '根节点 class 是 ug-panel')

  // 四个页签都在：更新记录 / 错误知识库 / 补丁账本 / 后台队列
  // （注意 .ug-tabs 容器也以 ug-tab 开头，要精确匹配 ug-tab 后面跟空格/结束）
  const tabs = findNodes(panel, (n) => n.props && typeof n.props.className === 'string' && /^ug-tab(\s|$)/.test(n.props.className))
  ok(tabs.length === 4, `渲染出 4 个页签（实际 ${tabs.length}）`)
}

/** 深度遍历假元素树 */
function findNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out }
  if (node.type && pred(node)) out.push(node)
  if (node.children) for (const c of node.children) findNodes(c, pred, out)
  return out
}

// ══ ⑤ 纯函数 ═════════════════════════════════════════════════════════════
console.log('\n⑤ 格式化函数')
{
  const { exports } = loadClient()
  const { fmtTime, resultBadge, severityBadge } = exports.__test

  eq(fmtTime('2026-10-22T07:00:00.000Z'), '2026-10-22 07:00', 'ISO → 可读时间')
  eq(fmtTime(null), '未知时间', '空值 → 未知时间')

  eq(resultBadge('applied').text, '成功', 'applied → 成功')
  eq(resultBadge('ok').text, '成功', 'ok → 成功')
  eq(resultBadge('rolled-back').text, '已回滚', 'rolled-back → 已回滚')
  eq(resultBadge('rolled-back').cls, 'warn', '回滚是黄色警告不是红色')
  eq(resultBadge('refused').cls, 'bad', '拒绝是红色')
  eq(resultBadge('noop').text, '无需更新', 'noop → 无需更新')

  eq(severityBadge('critical').text, '致命', 'critical → 致命')
  eq(severityBadge('high').text, '严重', 'high → 严重')
  eq(severityBadge('low').text, '轻微', 'low → 轻微')
  eq(severityBadge(undefined).text, '中等', '缺省 → 中等')
}

// ══ ⑥ 接口路径一致 ═══════════════════════════════════════════════════════
console.log('\n⑥ 客户端与宿主接口路径一致')
{
  const hostSrc = readFileSync(join(HERE, '..', 'lib', 'webapi.js'), 'utf8')
  const clientSrc = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
  const hostRoute = /export const ROUTE = '([^']+)'/.exec(hostSrc)
  ok(hostRoute !== null, '宿主侧有 ROUTE 常量')
  const clientBase = /const API_BASE = '([^']+)'/.exec(clientSrc)
  ok(clientBase !== null, '客户端侧有 API_BASE 常量')
  eq(clientBase[1], hostRoute[1], '两侧前缀必须一致（改了要同步，否则设置页全 404）')

  // 第四个页签「后台队列」两边都要有：客户端要请求 /queue，宿主要有对应分支
  ok(clientSrc.includes("'后台队列'"), '客户端有「后台队列」页签')
  ok(/apiGet\('\/queue'/.test(clientSrc), '客户端会请求 /queue')
  ok(/sub === 'queue'/.test(hostSrc), '宿主有 /queue 分支')
  ok(/sub === 'queue\/remove'/.test(hostSrc), '宿主有 /queue/remove 分支')
  ok(/sub === 'queue\/clear'/.test(hostSrc), '宿主有 /queue/clear 分支')
}

console.log(`\n${failed === 0 ? '✅' : '❌'} client：${pass} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
