/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到"自己的依赖"）
 * ============================================================================
 * 🔴 为什么要有它：
 *   `@deepseek-ai/*` 在插件 package.json 里是 **optional peer**，而桌面版 profile
 *   （`autoInstallPeers: false`）**永远不装它们** ⇒ 裸 import 会让插件整条不激活，
 *   DSH 只留一句 `warning: 1 entry did not activate … failed to import`。
 *
 * ⭐ 策略（三条一起走）：
 *   ① **优先从宿主那棵树里解析**（跟宿主用同一份，行为最一致）；
 *   ② 解析不到就 **bare import**（靠我们自己 package.json 的 `dependencies` 装一份保底）；
 *   ③ 全都拿不到 ⇒ 用本地等价实现，**插件照常加载** ——
 *      **绝不因为一个 import 就让整条插件不激活** ✗✓。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/** 插件自己那棵树（`dependencies` 装出来的那份）—— 用模块位置算，别依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按可能性排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有些机器上这些包是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // 插件自己那份（package.json 的 dependencies 装出来的）—— 放最后，前面优先"跟宿主同一份"
  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/** 试从宿主树里 import 一个包；拿不到返回 null（失败原因写进 notes，方便远程排查） */
async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue          // 自己那份交给下面的 bare import 处理
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/**
 * ── 宿主 defineTool 的 spec 方言（照 @deepseek-ai/dsh-tools 的 schema.js 一比一实现）──
 *
 * 关键：`parameters` **不是** JSON Schema，而是「字段 → value schema」的映射；
 * `output.schema` 是**单个** value schema。
 *
 *    parameters: {
 *      name: { type: 'string', required: true, description: '包名' },
 *      to:   { type: 'string', description: '目标版本' },
 *    }
 *    output: { schema: { type: 'json' }, render(...){...} }
 *
 * 宿主会把 parameters 编译成 `{type:'object', properties:{...}, required:[...]}`，
 * 再交给 tools.register。我们拿不到宿主 dsh-tools 时必须编译成**同一个形状**，
 * 否则 register 会抛 `JsonSchemaError: parameters.type must be a value schema object`。
 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

const fail = (path, msg) => {
  throw new Error(`defineTool schema: ${path} ${msg}`)
}

/**
 * 编译一个 value schema 节点
 * @param {any} spec 作者写的 spec
 * @param {string} path 诊断路径
 * @param {boolean} allowRequired 是否允许 required（只有 property-map 里允许）
 * @returns {object} 原始 JSON Schema 子集
 */
function compileValueSchema(spec, path, allowRequired) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail(path, '必须是 value schema 对象')

  const node = {}
  for (const k of ANNOTATION_KEYS) if (Object.hasOwn(spec, k)) node[k] = spec[k]

  if (Object.hasOwn(spec, 'oneOf')) {
    if (Object.hasOwn(spec, 'type')) fail(path, '不能同时声明 type 和 oneOf')
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) fail(`${path}.oneOf`, '至少要两个分支')
    node.oneOf = spec.oneOf.map((b, i) => compileValueSchema(b, `${path}.oneOf[${i}]`, false))
    return node
  }

  switch (spec.type) {
    case 'json':
      // 宿主把它变成「纯注解」schema（不限类型）
      return node

    case 'object': {
      if (typeof spec.additionalProperties !== 'boolean') {
        fail(`${path}.additionalProperties`, '必须显式写 true 或 false')
      }
      node.type = 'object'
      node.additionalProperties = spec.additionalProperties
      if (Object.hasOwn(spec, 'properties')) {
        const pm = compilePropertyMap(spec.properties, `${path}.properties`)
        node.properties = pm.properties
        if (pm.required) node.required = pm.required
      }
      return node
    }

    case 'array': {
      node.type = 'array'
      if (Object.hasOwn(spec, 'items')) node.items = compileValueSchema(spec.items, `${path}.items`, false)
      return node
    }

    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      node.type = spec.type
      if (Object.hasOwn(spec, 'enum')) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0) fail(`${path}.enum`, '必须是非空数组')
        node.enum = [...spec.enum]
      }
      if (Object.hasOwn(spec, 'const')) node.const = spec.const
      return node
    }

    default:
      fail(`${path}.type`, '必须是 string/number/integer/boolean/null/array/object/json，或者用 oneOf')
  }
  return node
}

/**
 * 编译「字段 → value schema」映射，顺便收集 required
 * @param {object} map 字段映射
 * @param {string} path 诊断路径
 * @returns {{properties:object, required?:string[]}}
 */
function compilePropertyMap(map, path) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) fail(path, '必须是对象')
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(map)) {
    const p = `${path}.${key}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(p, '必须是 value schema 对象')
    if (Object.hasOwn(raw, 'required') && raw.required !== true) fail(`${p}.required`, '只能是 true')
    if (raw.required === true) required.push(key)
    const { required: _ignored, ...rest } = raw
    properties[key] = compileValueSchema(rest, p, true)
  }
  return { properties, required: required.length > 0 ? required : undefined }
}

/**
 * 兜底：**我们自己的等价实现**，只在拿不到宿主的 dsh-tools 时用。
 * 语义与宿主 defineTool 一致：parameters 走 property-map，output.schema 走 value schema。
 * @param {object} options 工具定义（spec 方言）
 * @param {Function} log 记录日志
 * @returns {object} 可直接交给 ctx.tools.register 的定义（parameters 已编译成 JSON Schema）
 */
function localDefineTool(options, log) {
  const pm = compilePropertyMap(options.parameters ?? {}, 'parameters')
  const parameters = { type: 'object', properties: pm.properties }
  if (pm.required) parameters.required = pm.required

  const output = { ...options.output }
  if (options.output && Object.hasOwn(options.output, 'schema')) {
    output.schema = compileValueSchema(options.output.schema, 'schema', false)
  }

  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}）`)
  return { ...options, parameters, output }
}

/**
 * 取回宿主半端要用的一点点东西
 * @returns {Promise<{z:any, defineTool:Function, createUserMessage:Function, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  // ① schemastery（Config 要用）
  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); log('schemastery：宿主树里没有，用自己依赖里那份') }
    catch (e) {
      log(`⚠️ schemastery 彻底拿不到（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）—— 这一份插件没有 Config，设置页会降级（插件本体照常跑）`)
    }
  }
  const z = zMod?.default ?? zMod ?? null

  // ② dsh-tools 的 defineTool（拿不到就用本地等价实现）
  let defineTool = null
  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：宿主树里没有，用自己依赖里那份') }
    catch (e) { log(`dsh-tools 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`); dtMod = null }
  }
  defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  // ③ dsh-llm 的 createUserMessage
  let createUserMessage = null
  let llmMod = await fromHostTree('dsh-llm', log)
  if (!llmMod) {
    try { llmMod = await import('@deepseek-ai/dsh-llm'); log('dsh-llm：宿主树里没有，用自己依赖里那份') }
    catch (e) { log(`dsh-llm 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`); llmMod = null }
  }
  createUserMessage = llmMod?.createUserMessage || ((payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const msg = { id: randomUUID(), role: 'user', content: Array.isArray(p.content) ? p.content : [] }
    if (p.source !== undefined) msg.source = p.source
    return msg
  })

  return { z, defineTool, createUserMessage, notes }
}
