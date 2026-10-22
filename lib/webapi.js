/**
 * lib/webapi.js —— 管理台的 HTTP 数据接口（宿主半边）
 * ============================================================================
 * 为什么要有这个文件：
 *   客户端的 `client.js` 跑在浏览器里，拿不到 Node 的 fs，也就读不到
 *   `~/.dsh/dsh-update-guard/ledger.jsonl` 和补丁账本。所以数据必须由宿主
 *   通过 `webServer.register` 开一条只读路由吐出去，客户端 fetch 它。
 *
 * 设计约束（都是踩过坑换来的）：
 *   ① **只读**。这条路由不给任何写操作。管理台是"看"的地方，写操作一律走
 *      模型工具（plugin_update_apply 等）——那些有审查、有沙箱、有回滚。
 *      一条能直接改 profile 的 HTTP 接口，等于给所有 XSS 开了一扇门。
 *   ② **只接受本机请求**。DSH 可能绑在 0.0.0.0（主人配了远程访问），
 *      这条路由会暴露更新历史/病历/补丁清单，不该让局域网随便看。
 *   ③ **数据源用注入**。这个文件不 import 任何 fs —— 全部通过参数传进来，
 *      这样单测可以喂假数据，不用造一整个 profile。
 *   ④ **永不 throw**。任何一条数据源炸了都只让那一个接口 500，
 *      不能让整个插件/整个 webServer 挂掉。
 * ============================================================================
 */

/** 路由前缀。改这里要同步改 lib/client.js 里的 API_BASE。 */
export const ROUTE = '/dsh-update-guard-api'

/** 只认这些 Host 头 —— 跟 dsh-meme 保持一致，避免两套判定标准 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function hostIsLoopback(req) {
  const raw = String((req && req.headers && req.headers.host) || '')
  if (!raw) return true
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 管理台只在本机用；这条也顺手挡掉被别的站 embed 的可能
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

/** 从 `?a=1&b=2` 里取参数。用 URLSearchParams 而不是手撸正则（编码坑太多）。 */
function queryOf(req) {
  const raw = String((req && req.url) || '')
  const q = raw.indexOf('?')
  return new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
}

/**
 * 造一个 webServer 路由 handler。
 *
 * @param {object} sources 数据源，全部是同步或异步函数，**全部可选**：
 *   - ledger({ name, limit })  → 更新档案条目数组
 *   - ledgerStats()            → { total, ok, rolledBack, refused, ... }
 *   - errors({ q, limit })     → 病历摘要数组（不含正文）
 *   - errorDetail(file)        → 单篇病历全文 { file, title, body, ... } | null
 *   - patches()                → 补丁账本数组
 *   - backups()                → 备份列表
 *   - overview()               → 管理台首页要的一次性汇总
 * @returns {(req, res) => Promise<void>}
 */
export function createApiHandler(sources) {
  const src = sources ?? {}

  /** 调数据源：没有就返回 null，炸了就返回 { error }，绝不让外层 catch 到 */
  async function call(name, ...args) {
    const fn = src[name]
    if (typeof fn !== 'function') return { __missing: name }
    try {
      return { value: await fn(...args) }
    } catch (e) {
      return { __error: String((e && e.message) || e) }
    }
  }

  return async function handler(req, res) {
    // ① 只服务本机
    if (!hostIsLoopback(req)) {
      sendJson(res, 403, { ok: false, error: '管理台只接受本机（回环地址）请求' })
      return
    }

    const url = String((req && req.url) || '')
    const rawPath = url.split('?')[0]

    // ② 非 GET 一律拒（只读接口）
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: '管理台接口是只读的' })
      return
    }

    // ③ 解码路径。浏览器会把非 ASCII 百分号编码，不先解会对不上。
    let pathname
    try {
      pathname = decodeURIComponent(rawPath)
    } catch {
      sendJson(res, 400, { ok: false, error: '路径编码不对' })
      return
    }

    const sub = pathname === ROUTE
      ? ''
      : (pathname.startsWith(ROUTE + '/') ? pathname.slice(ROUTE.length + 1) : null)

    if (sub === null) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }

    const q = queryOf(req)
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 200))

    try {
      // ── /overview ── 首页一次拿齐，省得客户端并发打 5 个请求
      if (sub === '' || sub === 'overview') {
        const [ledger, stats, errors, patches, backups] = await Promise.all([
          call('ledger', { limit: 20 }),
          call('ledgerStats'),
          call('errors', { limit: 5 }),
          call('patches'),
          call('backups'),
        ])
        sendJson(res, 200, {
          ok: true,
          ledger: pick(ledger, []),
          stats: pick(stats, {}),
          errors: pick(errors, []),
          patches: pick(patches, []),
          backups: pick(backups, []),
        })
        return
      }

      // ── /ledger?name=&limit= ──
      if (sub === 'ledger') {
        const name = String(q.get('name') || '').trim()
        const r = await call('ledger', { name: name || undefined, limit })
        sendJson(res, 200, { ok: true, items: pick(r, []) })
        return
      }

      // ── /stats ──
      if (sub === 'stats') {
        const r = await call('ledgerStats')
        sendJson(res, 200, { ok: true, stats: pick(r, {}) })
        return
      }

      // ── /errors?q=&limit= ──
      if (sub === 'errors') {
        const text = String(q.get('q') || '').trim()
        const r = await call('errors', { q: text, limit })
        sendJson(res, 200, { ok: true, items: pick(r, []) })
        return
      }

      // ── /error?file=xxx.md ── 单篇全文
      if (sub === 'error') {
        const file = String(q.get('file') || '').trim()
        if (!file) { sendJson(res, 400, { ok: false, error: '缺 file 参数' }); return }
        // 防目录穿越：只允许纯文件名（病历都是一层的 *.md）
        if (file.includes('/') || file.includes('\\') || file.includes('..')) {
          sendJson(res, 400, { ok: false, error: 'file 只能是文件名' })
          return
        }
        const r = await call('errorDetail', file)
        if (r.__missing || r.__error || r.value == null) {
          sendJson(res, 404, { ok: false, error: r.__error || '没有这篇病历' })
          return
        }
        sendJson(res, 200, { ok: true, doc: r.value })
        return
      }

      // ── /queue ── 后台队列 + 空闲判定（全是插件自己的状态，不碰 profile）
      if (sub === 'queue') {
        const r = await call('queue')
        sendJson(res, 200, { ok: true, ...(pick(r, {}) || {}) })
        return
      }

      // ── /queue/remove?id=xx ── 从待办里删掉一条
      //    ⚠️ 只删队列文件里的一条记录。真正的安装永远走工具（有试跑 / 验证 / 回滚），
      //       HTTP 这边拿不到那条安全网，所以**绝不提供「开装」的接口**。
      if (sub === 'queue/remove') {
        const id = String(q.get('id') || '').trim()
        if (!id) { sendJson(res, 400, { ok: false, error: '缺 id 参数' }); return }
        const r = await call('queueRemove', id)
        const v = pick(r, null)
        sendJson(res, v && v.ok === false ? 400 : 200, v ?? { ok: true })
        return
      }

      // ── /queue/clear ── 清空待办（正在跑的那条保留）
      if (sub === 'queue/clear') {
        const r = await call('queueClear')
        const v = pick(r, null)
        sendJson(res, v && v.ok === false ? 400 : 200, v ?? { ok: true })
        return
      }

      // ── /patches ──
      if (sub === 'patches') {
        const r = await call('patches')
        sendJson(res, 200, { ok: true, items: pick(r, []) })
        return
      }

      // ── /backups ──
      if (sub === 'backups') {
        const r = await call('backups')
        sendJson(res, 200, { ok: true, items: pick(r, []) })
        return
      }

      sendJson(res, 404, { ok: false, error: '不认识的接口：' + sub })
    } catch (e) {
      // ④ 兜底：任何没预料到的错都只影响这一个请求
      try {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      } catch { /* 响应都发不出去了，只能放弃 */ }
    }
  }

  /** 把 call() 的包装拆开：有值给值，缺/错给默认值 */
  function pick(wrapped, dflt) {
    if (!wrapped || wrapped.__missing) return dflt
    if (wrapped.__error) return dflt
    return wrapped.value == null ? dflt : wrapped.value
  }
}

/**
 * 把 webapi 需要的几个数据源从「插件内部的东西」上摘出来。
 *
 * 单独抽成函数的原因：index.js 里那堆闭包（memory / resolveProfileDir / scanPatches）
 * 直接在 apply() 里拼太乱，而且这样这段逻辑能被单测直接喂假 memory。
 *
 * @param {object} deps
 * @param {object} deps.memory      lib/memory.js 的 createMemory() 返回值
 * @param {() => object} deps.profile  返回 { dir, patchedDeps } 的函数（可能 throw）
 * @param {Function} deps.scanPatches  (dir, patchedDeps) => 补丁数组
 * @param {Function} deps.listBackups  (dir) => 备份数组
 */
export function buildSources({ memory, profile, scanPatches, listBackups, queue = null }) {
  /** 统一拿 profile 信息；拿不到就返回空，不让接口 500 */
  const profileInfo = () => {
    try {
      return profile() ?? { dir: null, patchedDeps: {} }
    } catch {
      return { dir: null, patchedDeps: {} }
    }
  }

  /**
   * 病历摘要（不含正文）。
   * ⚠️ listErrorDocs 返回的是 { file:绝对路径, filename, meta, body }，
   *    meta 里才是 title/packages/severity 这些。这里做一次摊平，
   *    并且**只吐 filename**——绝对路径不该出现在浏览器里。
   */
  function briefOf(d) {
    const meta = d?.meta ?? {}
    return {
      file: d?.filename ?? null,
      title: meta.title ?? d?.filename ?? null,
      packages: Array.isArray(meta.packages) ? meta.packages : (meta.packages ? [meta.packages] : []),
      symptoms: Array.isArray(meta.symptoms) ? meta.symptoms : (meta.symptoms ? [meta.symptoms] : []),
      severity: meta.severity ?? 'medium',
      createdAt: meta.createdAt ?? null,
      lastSeenAt: meta.lastSeenAt ?? null,
      occurrences: Number(meta.occurrences ?? 1) || 1,
    }
  }

  return {
    ledger({ name, limit } = {}) {
      const rows = memory.read({ name, limit: limit ?? 200 })
      return rows.map((r) => ({
        at: r.at ?? null,
        name: r.name ?? null,
        kind: r.kind ?? null,
        from: r.from ?? null,
        to: r.to ?? null,
        result: r.result ?? null,
        reason: r.reason ?? null,
        patches: r.patches ?? null,
        note: r.note ?? null,
      }))
    },

    ledgerStats() {
      const st = memory.stats()
      return st ?? {}
    },

    errors({ q: text, limit } = {}) {
      const docs = text
        ? memory.searchErrors({ keywords: [text], limit: limit ?? 200 })
        : memory.listErrors().slice(0, limit ?? 200)
      // 列表不要正文（病历正文可能很长），客户端点开再看
      return (docs ?? []).map(briefOf)
    },

    errorDetail(file) {
      const all = memory.listErrors() ?? []
      // ⚠️ listErrorDocs 的字段形状是 { file: 绝对路径, filename, meta, body }，
      //    元信息全在 meta 里。客户端只该看到 filename（不泄露本机绝对路径）。
      const hit = all.find((d) => d.filename === file)
      if (!hit) return null
      const meta = hit.meta ?? {}
      return {
        ...briefOf(hit),
        body: hit.body ?? '',
        symptomsText: Array.isArray(meta.symptoms) ? meta.symptoms.join('\n') : String(meta.symptoms ?? ''),
        versions: meta.versions ?? [],
      }
    },

    patches() {
      const { dir, patchedDeps } = profileInfo()
      if (!dir) return []
      const list = scanPatches(dir, patchedDeps) ?? []
      return list.map((p) => ({
        key: p.key,
        name: p.name,
        version: p.version,
        registered: !!p.registered,
        hasPatch: !!p.hasPatch,
        files: p.files ?? [],
        stats: p.stats ?? null,
        intent: p.intent ?? null,
        issue: p.issue ?? null,
        retireWhen: p.retireWhen ?? null,
        issues: p.issues ?? [],
        notes: p.notes ?? [],
      }))
    },

    backups() {
      const { dir } = profileInfo()
      if (!dir) return []
      try {
        return (listBackups(dir) ?? []).slice(0, 50)
      } catch {
        return []
      }
    },
    // ── 后台队列：这几个是**插件自己的状态**（<profile>/.update-guard/queue.json），
    //    不是 profile 的配置。删一条待办跟「改 profile」是两件事，所以允许 HTTP 写。
    queue() {
      if (!queue) return { enabled: false, items: [], idle: null, note: '队列没接上' }
      try { return queue.state() } catch (e) { return { enabled: false, items: [], idle: null, note: String(e?.message ?? e) } }
    },

    queueRemove(id) {
      if (!queue) return { ok: false, error: '队列没接上' }
      try { return queue.remove(id) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    },

    queueClear() {
      if (!queue) return { ok: false, error: '队列没接上' }
      try { return queue.clear() } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    },
  }
}
