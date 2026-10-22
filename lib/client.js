/**
 * lib/client.js —— dsh-update-guard 的设置页（Client 半边）
 * ============================================================================
 * 为什么要有这个文件：
 *   主人要的「记忆功能」如果只有 `plugin_memory` 工具，那只有模型能看。
 *   出事的时候主人想自己翻一翻「上次这个包升级到底怎么挂的」，
 *   总不能每次都让我去跑工具、再念给他听。所以得有个能点的界面。
 *
 * 三个页签：
 *   ① 更新记录 —— ledger.jsonl（机器档案），带统计：装了多少、回滚了多少
 *   ② 错误知识库 —— errors/*.md（人和模型都能读的病历），可搜索、点开看全文
 *   ③ 补丁账本 —— 当前 profile 的所有补丁：登记了没、能不能打、为什么打
 *
 * ⚠️ 三个必须遵守的约束（踩过坑换来的）：
 *   ① **只读**。这里一个写操作都不做。要更新就去跟模型说，走工具链
 *      （审查 → 沙箱 → 打补丁 → 装 → 验 → 回滚）。一个能直接改 profile 的
 *      按钮，等于绕过了整套安全网，比没有界面更危险。
 *   ② **注册 id 必须等于包名**（dsh-update-guard），否则 ModuleLoader 报
 *      "loaded without registering <name>"。
 *   ③ **加载失败绝不能白屏**。任何一个接口挂了都只让那一块显示错误文字，
 *      设置页其它部分照常能用——不然主人会以为整个 DSH 坏了。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-update-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 数据接口前缀，必须与 lib/webapi.js 的 ROUTE 一致 */
    const API_BASE = '/dsh-update-guard-api'

    const CSS = [
      '.ug-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ug-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:0}',
      '.ug-tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);padding:7px 14px;font-size:13px;cursor:pointer;margin-bottom:-1px;transition:color .12s ease,border-color .12s ease}',
      '.ug-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.ug-tab.on{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.ug-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ug-spacer{flex:1}',
      '.ug-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.ug-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
      '.ug-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}',
      '.ug-card .n{font-size:22px;font-weight:600;line-height:1.1}',
      '.ug-card .k{font-size:11px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.05em}',
      '.ug-list{display:flex;flex-direction:column;gap:6px}',
      '.ug-item{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 12px;display:flex;gap:10px;align-items:flex-start}',
      '.ug-item.clickable{cursor:pointer}',
      '.ug-item.clickable:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.ug-item .badge{flex:none;font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:600;white-space:nowrap}',
      '.ug-item .badge.ok{color:#1a7f37;background:color-mix(in srgb,#1a7f37 14%,transparent)}',
      '.ug-item .badge.bad{color:#c93c37;background:color-mix(in srgb,#c93c37 14%,transparent)}',
      '.ug-item .badge.warn{color:#9a6700;background:color-mix(in srgb,#9a6700 16%,transparent)}',
      '.ug-item .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.ug-item .title{font-weight:600;overflow-wrap:anywhere}',
      '.ug-item .sub{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.ug-empty{padding:24px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}',
      '.ug-err{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,#c93c37 10%,transparent);border:1px solid color-mix(in srgb,#c93c37 35%,transparent);color:#c93c37;font-size:12px;overflow-wrap:anywhere}',
      '.ug-panel input[type=text],.ug-panel input[type=search]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;min-width:180px}',
      '.ug-panel input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ug-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}',
      '.ug-panel button:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.ug-panel button:disabled{opacity:.5;cursor:default}',
      '.ug-pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;max-height:420px;overflow:auto}',
      '.ug-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:4px}',
      '.ug-back{align-self:flex-start}',
    ].join('\n')

    /** 注入一段受管的样式；卸载时由 ctx.effect 摘掉，避免热重载叠一堆 <style> */
    function createOwnedStyle(text) {
      if (typeof document === 'undefined') return { remove() {} }
      const el = document.createElement('style')
      el.setAttribute('data-owner', 'dsh-update-guard')
      el.textContent = text
      document.head.appendChild(el)
      return el
    }

    /** 统一的 GET；失败返回 { ok:false, error }，永不 throw */
    async function apiGet(path, params) {
      let url = API_BASE + path
      if (params) {
        const qs = new URLSearchParams()
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
        }
        const s = qs.toString()
        if (s) url += '?' + s
      }
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } })
        let json = null
        try { json = await res.json() } catch { /* 非 JSON 响应 */ }
        if (!res.ok) {
          return { ok: false, error: (json && json.error) || `HTTP ${res.status}` }
        }
        if (!json) return { ok: false, error: '接口返回的不是 JSON' }
        return json
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }

    /** 把 ISO 时间变成「2026-10-22 15:04」这种能一眼看懂的 */
    function fmtTime(v) {
      if (!v) return '未知时间'
      const s = String(v)
      const t = s.replace('T', ' ')
      return t.slice(0, 16)
    }

    /** 结果码 → 徽章样式与文字 */
    function resultBadge(result) {
      const r = String(result ?? '')
      if (r === 'ok' || r === 'applied') return { cls: 'ok', text: '成功' }
      if (r === 'rolled-back') return { cls: 'warn', text: '已回滚' }
      if (r === 'refused') return { cls: 'bad', text: '拒绝' }
      if (r === 'noop') return { cls: '', text: '无需更新' }
      if (!r) return { cls: '', text: '未知' }
      return { cls: '', text: r }
    }

    function severityBadge(sev) {
      const s = String(sev ?? 'medium')
      if (s === 'high' || s === 'critical') return { cls: 'bad', text: s === 'critical' ? '致命' : '严重' }
      if (s === 'low') return { cls: '', text: '轻微' }
      return { cls: 'warn', text: '中等' }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  更新记录
    // ───────────────────────────────────────────────────────────────────────
    function LedgerTab({ state, reload }) {
      const h = React.createElement
      const { loading, error, data } = state
      if (loading && !data) return h('div', { className: 'ug-empty' }, '正在读取更新档案…')
      if (error) return h('div', { className: 'ug-err' }, '读不到更新档案：' + error)

      const items = (data && data.ledger) || []
      const st = (data && data.stats) || {}

      const cards = [
        { k: '总记录', n: st.total ?? items.length },
        { k: '装成功', n: st.applied ?? st.ok ?? 0 },
        { k: '已回滚', n: st.rolledBack ?? 0 },
        { k: '被拒绝', n: st.refused ?? 0 },
      ]

      return h('div', { className: 'ug-panel' },
        h('div', { className: 'ug-row' },
          h('span', { className: 'ug-muted' },
            '这份档案在 ~/.dsh/dsh-update-guard/ledger.jsonl，每次更新都留一条，插件重装也不会丢。'),
          h('div', { className: 'ug-spacer' }),
          h('button', { onClick: reload, disabled: loading }, loading ? '刷新中…' : '刷新'),
        ),
        h('div', { className: 'ug-cards' },
          cards.map((c, i) => h('div', { className: 'ug-card', key: i },
            h('span', { className: 'n' }, String(c.n)),
            h('span', { className: 'k' }, c.k),
          )),
        ),
        items.length === 0
          ? h('div', { className: 'ug-empty' },
            '还没有更新记录。',
            h('div', { className: 'ug-muted', style: { marginTop: 6 } },
              '下次让我检查插件更新时，这里就会开始记东西。'))
          : h('div', { className: 'ug-list' },
            items.map((r, i) => {
              const b = resultBadge(r.result)
              const ver = (r.from || r.to) ? `${r.from ?? '?'} → ${r.to ?? '?'}` : ''
              return h('div', { className: 'ug-item', key: i },
                h('span', { className: 'badge ' + b.cls }, b.text),
                h('div', { className: 'body' },
                  h('div', { className: 'title' }, r.name || '（未记包名）'),
                  h('div', { className: 'sub' },
                    [fmtTime(r.at), ver].filter(Boolean).join('　'),
                    r.reason ? '　' + String(r.reason).slice(0, 160) : '',
                  ),
                ),
              )
            }),
          ),
      )
    }

    // ───────────────────────────────────────────────────────────────────────
    //  错误知识库
    // ───────────────────────────────────────────────────────────────────────
    function ErrorsTab({ state, reload, query, setQuery }) {
      const h = React.createElement
      const { loading, error, data } = state
      const [openFile, setOpenFile] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailErr, setDetailErr] = React.useState(null)

      React.useEffect(() => {
        if (!openFile) { setDetail(null); setDetailErr(null); return }
        let alive = true
        setDetail(null); setDetailErr(null)
        apiGet('/error', { file: openFile }).then((r) => {
          if (!alive) return
          if (r.ok) setDetail(r.doc)
          else setDetailErr(r.error)
        })
        return () => { alive = false }
      }, [openFile])

      if (openFile) {
        return h('div', { className: 'ug-panel' },
          h('button', { className: 'ug-back', onClick: () => setOpenFile(null) }, '← 返回列表'),
          detailErr ? h('div', { className: 'ug-err' }, '读不到这篇病历：' + detailErr) : null,
          !detail && !detailErr ? h('div', { className: 'ug-empty' }, '正在读取…') : null,
          detail ? h('div', { className: 'ug-panel' },
            h('div', { className: 'ug-row' },
              h('span', { className: 'badge ' + severityBadge(detail.severity).cls }, severityBadge(detail.severity).text),
              h('span', { className: 'title' }, detail.title || detail.file),
            ),
            h('div', { className: 'ug-muted' },
              [
                detail.packages && detail.packages.length ? '涉及：' + detail.packages.join(', ') : '',
                '首次：' + fmtTime(detail.createdAt),
                detail.occurrences > 1 ? `踩了 ${detail.occurrences} 次` : '',
              ].filter(Boolean).join('　'),
            ),
            h('div', { className: 'ug-pre' }, detail.body || '（这篇病历没有正文）'),
          ) : null,
        )
      }

      if (loading && !data) return h('div', { className: 'ug-empty' }, '正在读取错误知识库…')
      if (error) return h('div', { className: 'ug-err' }, '读不到错误知识库：' + error)

      const items = (data && data.errors) || []

      return h('div', { className: 'ug-panel' },
        h('div', { className: 'ug-row' },
          h('input', {
            type: 'search',
            placeholder: '搜包名或症状，比如「401」「白屏」「dsh-pocket」',
            value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') reload() },
          }),
          h('button', { onClick: reload, disabled: loading }, loading ? '搜…' : '搜索'),
          h('div', { className: 'ug-spacer' }),
          h('span', { className: 'ug-muted' }, `共 ${items.length} 条`),
        ),
        h('div', { className: 'ug-muted' },
          '每踩一个坑就存一篇，存在 ~/.dsh/dsh-update-guard/errors/。审查模型每次开工前会自动读它，所以同一个坑不会被踩第二遍。'),
        items.length === 0
          ? h('div', { className: 'ug-empty' }, query ? '没有匹配的病历。' : '还没有病历——说明暂时没出过事。')
          : h('div', { className: 'ug-list' },
            items.map((d, i) => {
              const b = severityBadge(d.severity)
              return h('div', {
                className: 'ug-item clickable',
                key: i,
                onClick: () => setOpenFile(d.file),
              },
                h('span', { className: 'badge ' + b.cls }, b.text),
                h('div', { className: 'body' },
                  h('div', { className: 'title' }, d.title || d.file),
                  h('div', { className: 'sub' },
                    [
                      d.packages && d.packages.length ? d.packages.join(', ') : '',
                      fmtTime(d.lastSeenAt || d.createdAt),
                      d.occurrences > 1 ? `踩了 ${d.occurrences} 次` : '',
                    ].filter(Boolean).join('　'),
                  ),
                ),
              )
            }),
          ),
      )
    }

    // ───────────────────────────────────────────────────────────────────────
    //  补丁账本
    // ───────────────────────────────────────────────────────────────────────
    function PatchesTab({ state, reload }) {
      const h = React.createElement
      const { loading, error, data } = state
      if (loading && !data) return h('div', { className: 'ug-empty' }, '正在扫描补丁…')
      if (error) return h('div', { className: 'ug-err' }, '读不到补丁账本：' + error)

      const items = (data && data.patches) || []
      const backups = (data && data.backups) || []
      const bad = items.filter((p) => (p.issues || []).length > 0)
      const soft = items.filter((p) => (p.issues || []).length === 0 && (p.notes || []).length > 0)

      // 补丁是好的、只是缺备注 → 别用红色吓人，用黄色「建议补充」
      const summary = bad.length > 0
        ? `当前 profile 有 ${items.length} 个补丁，${bad.length} 个有问题` +
          (soft.length > 0 ? `，${soft.length} 个只是缺备注。` : '。')
        : `当前 profile 有 ${items.length} 个补丁，全部正常` +
          (soft.length > 0 ? `（${soft.length} 个建议补一句备注）。` : '。')

      return h('div', { className: 'ug-panel' },
        h('div', { className: 'ug-row' },
          h('span', { className: 'ug-muted' }, summary),
          h('div', { className: 'ug-spacer' }),
          h('button', { onClick: reload, disabled: loading }, loading ? '扫描中…' : '重新扫描'),
        ),
        items.length === 0
          ? h('div', { className: 'ug-empty' }, '这个 profile 没有打任何补丁。')
          : h('div', { className: 'ug-list' },
            items.map((p, i) => {
              const issues = p.issues || []
              const notes = p.notes || []
              const b = issues.length > 0
                ? { cls: 'bad', text: '有问题' }
                : notes.length > 0
                  ? { cls: 'warn', text: '建议补充' }
                  : (p.registered ? { cls: 'ok', text: '已生效' } : { cls: 'warn', text: '未登记' })
              return h('div', { className: 'ug-item', key: i },
                h('span', { className: 'badge ' + b.cls }, b.text),
                h('div', { className: 'body' },
                  h('div', { className: 'title' },
                    h('span', { className: 'ug-code' }, p.key || `${p.name}@${p.version}`)),
                  p.issue || p.intent
                    ? h('div', { className: 'sub' }, '为什么打：' + String(p.issue || p.intent).slice(0, 200))
                    : h('div', { className: 'sub' }, '没有 intent.md —— 半年后没人记得这补丁为什么打'),
                  p.retireWhen
                    ? h('div', { className: 'sub' }, '什么时候能撤：' + String(p.retireWhen).slice(0, 200))
                    : null,
                  (p.files || []).length > 0
                    ? h('div', { className: 'sub' }, '改的文件：' + p.files.join(', '))
                    : null,
                  issues.length > 0
                    ? h('div', { className: 'sub', style: { color: '#c93c37' } }, '⚠ ' + issues.join('；'))
                    : null,
                  notes.length > 0
                    ? h('div', { className: 'sub', style: { color: '#c58a00' } }, '💡 ' + notes.join('；'))
                    : null,
                ),
              )
            }),
          ),
        backups.length > 0
          ? h('div', { className: 'ug-panel' },
            h('div', { className: 'ug-muted' }, `最近的备份（${backups.length} 个，出事能一键退回去）`),
            h('div', { className: 'ug-list' },
              backups.slice(0, 8).map((b, i) => h('div', { className: 'ug-item', key: i },
                h('span', { className: 'badge' }, '备份'),
                h('div', { className: 'body' },
                  h('div', { className: 'sub' }, String(b.stamp || '').replace(/-/g, (m, off) => off > 10 ? ':' : '-')),
                ),
              )),
            ),
          )
          : null,
      )
    }

/**
 * 队列页签的组件源码（单独放文件，避免脚本里嵌模板/引号打架）
 */
    function QueueTab({ state, reload }) {
      const h = React.createElement
      const [q, setQ] = React.useState({ loading: true, error: null, data: null })
      const [busy, setBusy] = React.useState('')

      const load = React.useCallback(() => {
        setQ((s) => ({ ...s, loading: true }))
        apiGet('/queue').then((r) => {
          if (r.ok) setQ({ loading: false, error: null, data: r })
          else setQ({ loading: false, error: r.error, data: null })
        })
      }, [])

      React.useEffect(() => { load() }, [load])

      const drop = (id) => {
        setBusy(id)
        apiGet('/queue/remove', { id }).then(() => { setBusy(''); load() })
      }
      const clearAll = () => {
        setBusy('__all__')
        apiGet('/queue/clear').then(() => { setBusy(''); load() })
      }

      if (q.loading && !q.data) return h('div', { className: 'ug-empty' }, '正在读队列…')
      if (q.error) return h('div', { className: 'ug-err' }, '读不到队列：' + q.error)

      const d = q.data || {}
      const items = d.items || []
      const idle = d.idle || {}
      const running = (idle.running || []).length || 0
      const canWork = d.enabled && items.length > 0 && !idle.busy && running === 0

      const statusBadge = (st) => {
        if (st === 'done') return { cls: 'ok', text: '已完成' }
        if (st === 'failed') return { cls: 'bad', text: '失败' }
        if (st === 'running') return { cls: 'warn', text: '正在跑' }
        return { cls: 'warn', text: '排队中' }
      }

      return h('div', { className: 'ug-panel' },
        h('div', { className: 'ug-row' },
          h('span', { className: 'ug-muted' },
            d.enabled ? `后台队列：开（每 ${Math.round((d.intervalMs || 60000) / 1000)} 秒看一次）` : '后台队列：关（去插件设置里打开）'),
          h('div', { className: 'ug-spacer' }),
          items.length > 0 ? h('button', { onClick: clearAll, disabled: busy === '__all__' }, busy === '__all__' ? '清空中…' : '清空待办') : null,
          h('button', { onClick: load, disabled: q.loading }, q.loading ? '刷新中…' : '刷新'),
        ),

        h('div', { className: 'ug-muted', style: { marginTop: 6 } },
          '动手条件：' + (canWork
            ? '现在可以动手（队列有活、没人正在用）'
            : (items.length === 0
              ? '队列里没有待办'
              : (running > 0 ? `还有 ${running} 个会话在跑，先不动` : '刚有活动，再等一会')))
          + (idle.reason ? `（${idle.reason}）` : '')),

        items.length === 0
          ? h('div', { className: 'ug-empty' }, '队列是空的。想让某个插件排队更新，让模型用 plugin_queue 排一条就行。')
          : h('div', { className: 'ug-list' },
            items.map((j, i) => {
              const b = statusBadge(j.status)
              return h('div', { className: 'ug-item', key: j.id || i },
                h('span', { className: 'badge ' + b.cls }, b.text),
                h('div', { className: 'body' },
                  h('div', { className: 'title' },
                    h('span', { className: 'ug-code' }, j.name + (j.to ? '@' + j.to : '')),
                  ),
                  h('div', { className: 'sub' },
                    `试了 ${j.tries || 0} 次` + (j.note ? ' · ' + j.note : '')),
                  j.lastError ? h('div', { className: 'sub', style: { color: '#c93c37' } }, '上次失败：' + String(j.lastError).slice(0, 160)) : null,
                ),
                j.status === 'pending'
                  ? h('button', { onClick: () => drop(j.id), disabled: busy === j.id }, busy === j.id ? '删…' : '删掉')
                  : null,
              )
            }),
          ),

        h('div', { className: 'ug-muted', style: { marginTop: 10, fontSize: 12 } },
          `装完怎么处理：${d.restartAfterApply === 'auto' ? '自动重启' : (d.restartAfterApply === 'never' ? '什么都不做' : '只提示（推荐）')}`
          + ` · 补丁打不上时自动重对准：${d.patchFix ? '开' : '关'}`),
      )
    }

    // ───────────────────────────────────────────────────────────────────────
    //  主面板
    // ───────────────────────────────────────────────────────────────────────
    const TABS = [
      { id: 'ledger', label: '更新记录' },
      { id: 'errors', label: '错误知识库' },
      { id: 'patches', label: '补丁账本' },
      { id: 'queue', label: '后台队列' },
    ]

    function GuardPanel() {
      const h = React.createElement
      const [tab, setTab] = React.useState('ledger')
      const [tick, setTick] = React.useState(0)
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [query, setQuery] = React.useState('')

      // 一个 overview 请求就够首页用了：档案 + 统计 + 病历 + 补丁 + 备份
      React.useEffect(() => {
        let alive = true
        setState((s) => ({ ...s, loading: true, error: null }))
        apiGet('/overview').then((r) => {
          if (!alive) return
          if (r.ok) setState({ loading: false, error: null, data: r })
          else setState({ loading: false, error: r.error, data: null })
        })
        return () => { alive = false }
      }, [tick])

      // 搜索是独立请求，不能等 overview
      React.useEffect(() => {
        if (tab !== 'errors' || !query) return
        let alive = true
        setState((s) => ({ ...s, loading: true }))
        apiGet('/errors', { q: query, limit: 200 }).then((r) => {
          if (!alive) return
          setState((s) => ({
            ...s,
            loading: false,
            error: r.ok ? null : r.error,
            data: r.ok ? { ...(s.data || {}), errors: r.items } : s.data,
          }))
        })
        return () => { alive = false }
      }, [tab, query, tick])

      const reload = React.useCallback(() => setTick((t) => t + 1), [])

      const shared = { state, reload, query, setQuery }

      return h('div', { className: 'ug-panel' },
        h('div', { className: 'ug-tabs' },
          TABS.map((t) => h('button', {
            key: t.id,
            className: 'ug-tab' + (tab === t.id ? ' on' : ''),
            onClick: () => setTab(t.id),
          }, t.label)),
        ),
        tab === 'ledger' ? h(LedgerTab, shared) : null,
        tab === 'errors' ? h(ErrorsTab, shared) : null,
        tab === 'patches' ? h(PatchesTab, shared) : null,
        tab === 'queue' ? h(QueueTab, shared) : null,
      )
    }

    // ───────────────────────────────────────────────────────────────────────
    //  插件入口
    // ───────────────────────────────────────────────────────────────────────
    const inject = ['slots']

    function apply(ctx) {
      // 样式挂到 ctx.effect：热重载/关插件时自动摘掉，不会叠 <style>
      const styleEl = createOwnedStyle(CSS)
      ctx.effect(() => () => { try { styleEl.remove() } catch { /* 已经没了 */ } }, 'dsh-update-guard: styles')

      const slots = ctx.get('slots')
      if (!slots) return

      // 设置页的一个独立入口（不是塞进「插件」页的子页签——更新管理是独立主题，
      // 跟「插件列表」不是一回事，混在一起反而找不到）。
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'update-guard', order: 30, label: '插件管家' },
        () => React.createElement(GuardPanel),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    // 纯函数导出给回归测试用（宿主不消费）
    exports.__test = { fmtTime, resultBadge, severityBadge }
    return module.exports
  },
})
