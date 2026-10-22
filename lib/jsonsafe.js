/**
 * lib/jsonsafe.js —— 把任意值变成「能无损过 JSON 往返」的值
 * ============================================================================
 * 🔴 为什么需要这个（真机事故，2026-10-22）：
 *    `plugin_update_trial` 在宿主里报
 *        tool "plugin_update_trial" returned invalid output:
 *        value is not lossless JSON
 *    同一个对象在 node 里单跑却完全正常 —— 说明返回值里混进了
 *    **JSON 表达不了、或者往返会变样**的东西。
 *
 *    JSON 往返会「掉东西」的经典几类：
 *      · `undefined`        → 键直接消失（最阴，看着没报错）
 *      · `NaN` / `±Infinity` → 变成 null
 *      · `-0`               → 变成 0
 *      · `BigInt`           → 直接抛
 *      · 孤立代理项（lone surrogate，UTF-16 半截字符）→ 编码时就坏了
 *      · Date/Map/Set/类实例 → 变成字符串或空对象
 *
 *    命令行输出、临时路径、错误栈这些「外来字符串」最容易带进上面几样。
 *    所以**所有返回给宿主的工具结果**都过一遍这里。
 * ============================================================================
 */

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** 把这个字符串收拾成安全的 UTF-16（坏掉的代理项换成 U+FFFD） */
export function safeString(s) {
  return String(s).replace(LONE_HIGH, '\uFFFD').replace(LONE_LOW, '\uFFFD')
}

/**
 * 深拷贝成 JSON 安全的值，并**如实报告改动了什么**。
 *
 * @param {any} value
 * @param {string} [path]
 * @param {string[]} [fixed] 收集「改过哪里」，方便日志里看一眼根因
 * @returns {{ value: any, fixed: string[] }}
 */
export function jsonSafe(value, path = '', fixed = []) {
  const where = path || '$'

  if (value === null) return { value: null, fixed }
  const t = typeof value

  if (t === 'undefined') {
    fixed.push(`${where}: undefined → null`)
    return { value: null, fixed }
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) { fixed.push(`${where}: ${value} → null`); return { value: null, fixed } }
    if (Object.is(value, -0)) { fixed.push(`${where}: -0 → 0`); return { value: 0, fixed } }
    return { value, fixed }
  }
  if (t === 'boolean') return { value, fixed }
  if (t === 'bigint') { fixed.push(`${where}: BigInt → 字符串`); return { value: String(value), fixed } }
  if (t === 'function') { fixed.push(`${where}: function → 省略`); return { value: null, fixed } }
  if (t === 'symbol') { fixed.push(`${where}: symbol → 字符串`); return { value: String(value), fixed } }
  if (t === 'string') {
    const s = safeString(value)
    if (s !== value) fixed.push(`${where}: 孤立代理项 → U+FFFD`)
    return { value: s, fixed }
  }

  if (Array.isArray(value)) {
    const out = value.map((v, i) => jsonSafe(v, `${path}[${i}]`, fixed).value)
    return { value: out, fixed }
  }

  if (value instanceof Date) {
    fixed.push(`${where}: Date → ISO 字符串`)
    return { value: value.toISOString(), fixed }
  }
  if (value instanceof Map) {
    fixed.push(`${where}: Map → 对象`)
    return jsonSafe(Object.fromEntries(value), path, fixed)
  }
  if (value instanceof Set) {
    fixed.push(`${where}: Set → 数组`)
    return jsonSafe([...value], path, fixed)
  }

  if (t === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      const r = jsonSafe(value[k], path ? `${path}.${k}` : k, fixed)
      out[k] = r.value
    }
    return { value: out, fixed }
  }

  fixed.push(`${where}: 未知类型 ${t} → 字符串`)
  return { value: String(value), fixed }
}

/** 只要值，不要报告 */
export function toJsonSafe(value) {
  return jsonSafe(value).value
}