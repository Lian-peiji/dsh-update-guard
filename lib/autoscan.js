/**
 * lib/autoscan.js —— 插件自己巡场（主人 m06608 / m06618）
 * ============================================================================
 * 主人原话：
 *   m06608「声明的修一下，更新让他自己来。我们这插件是一个无需主动触发的兜底插件」
 *   m06618「我们要做的是一个无需用户主动的兜底插件，日报统计的可更新就让插件自己处理」
 *
 * 所以这里不是「又一个按钮」，而是**插件的主循环**：
 *   定时扫 registry → 把有新版本的包排进队列 → 队列泵等空闲时自己审、自己试跑、自己装。
 *
 * 三条分寸（错一条就变成「一键更新」那个反面教材）：
 *   1. **只排队，不跳过审查**。排进去之后仍然是 `审查 → 试跑 → 真装 → 验证`，
 *      判决不是 install 的一律不装（见 lib/index.js 的 reviewFor）。
 *   2. **主人正在用就一步不动**。什么时候动手由 lib/idle.js 说了算，这里是纯侦察。
 *   3. **一次别排太多**。装一个要几十秒到几分钟，排一长串等于把机器占满 ——
 *      所以有 max 上限，剩下的留到下一轮（它们不会跑）。
 *
 * 这个文件里全是纯函数 + 一个薄壳，方便单测（不碰网络、不碰文件）。
 */

/** 默认多久巡一次（小时）。6 小时＝一天 4 次，够勤，也不至于把 registry 当靶子打。 */
export const DEFAULT_AUTO_SCAN_HOURS = 6

/** 一次最多排几个。剩下的下一轮再来，不抢跑。 */
export const DEFAULT_ENQUEUE_MAX = 5

/** 小时 → 毫秒（给 setInterval 用）；非法值退回默认，最小 1 小时。 */
export function autoScanIntervalMs(hours) {
  const h = Number(hours)
  const safe = Number.isFinite(h) && h > 0 ? h : DEFAULT_AUTO_SCAN_HOURS
  return Math.max(1, safe) * 3600_000
}

/**
 * 从扫描结果里挑「值得排队的」。
 *
 * @param {object} input
 * @param {Array}  input.updates   reconPackage 的结果数组（只要求 name / latest / current / hasUpdate / bump）
 * @param {Array}  input.existing  队列里现有的任务（只要 name 有值就行）
 * @param {number} input.max       这次最多挑几个
 * @returns {{ candidates: Array, skipped: Array }}
 */
export function pickEnqueueCandidates({ updates = [], existing = [], max = DEFAULT_ENQUEUE_MAX } = {}) {
  const busy = new Set(
    (existing ?? [])
      .map((j) => String(j?.name ?? '').trim())
      .filter(Boolean),
  )

  const candidates = []
  const skipped = []
  const seen = new Set()

  for (const u of updates ?? []) {
    const name = String(u?.name ?? '').trim()
    const to = String(u?.latest ?? '').trim()
    const current = String(u?.current ?? '').trim()
    if (!name || !to) continue

    if (seen.has(name)) {
      skipped.push({ name, why: '扫描结果里重复出现' })
      continue
    }
    seen.add(name)

    if (busy.has(name)) {
      skipped.push({ name, why: '已经在队列里了' })
      continue
    }
    // 只有明确「有更新」的才排：hasUpdate 缺失时退一步看 bump
    const hasUpdate = u?.hasUpdate === true || (u?.hasUpdate === undefined && u?.bump && u.bump !== 'none')
    if (!hasUpdate) {
      skipped.push({ name, why: '没有更新' })
      continue
    }
    // 版本相同 / 目标版本空 —— 排了也是白跑一趟
    if (current && to === current) {
      skipped.push({ name, why: '已经是最新' })
      continue
    }

    candidates.push({ name, to, current, bump: String(u?.bump ?? '') })
  }

  // 大版本优先：一次只放几个进去时，先让「有真变化」的走
  const weight = (b) => (b === 'major' ? 3 : b === 'minor' ? 2 : b === 'patch' ? 1 : 0)
  candidates.sort((a, b) => weight(b.bump) - weight(a.bump) || a.name.localeCompare(b.name))

  const cap = Number.isFinite(Number(max)) ? Math.max(0, Number(max)) : DEFAULT_ENQUEUE_MAX
  const picked = candidates.slice(0, cap)
  const overflow = candidates.slice(cap)
  for (const c of overflow) skipped.push({ name: c.name, why: `这次排不下（上限 ${cap} 个），下一轮再来` })

  return { candidates: picked, skipped }
}

/**
 * 巡场薄壳。真正的扫描 / 排队动作从外面注入，这样单测不用碰网络。
 *
 * @param {object}   input
 * @param {Function} input.scan       async () => updates[]（reconPackage 结果数组）
 * @param {Function} input.existing   () => 队列里的任务数组
 * @param {Function} input.enqueue    async ({name, to, current, bump}) => void
 * @param {Function} input.log        日志
 * @param {number}   input.max        一次最多排几个
 * @param {Function} input.now        时钟（测试注入）
 */
export function createAutoScan({
  scan,
  existing = () => [],
  enqueue,
  log = () => {},
  max = DEFAULT_ENQUEUE_MAX,
  now = Date.now,
} = {}) {
  if (typeof scan !== 'function') throw new Error('createAutoScan 需要 scan()')
  if (typeof enqueue !== 'function') throw new Error('createAutoScan 需要 enqueue()')

  let running = false
  let lastResult = null

  async function tick({ reason = 'timer' } = {}) {
    // 上一轮还没跑完（registry 慢的时候真的会）→ 这轮直接跳过，不叠罗汉
    if (running) return { skipped: 'busy', at: lastResult?.at ?? 0 }
    running = true
    try {
      const updates = (await scan()) ?? []
      const { candidates, skipped } = pickEnqueueCandidates({
        updates,
        existing: typeof existing === 'function' ? existing() : existing,
        max,
      })

      const added = []
      for (const c of candidates) {
        try {
          await enqueue(c)
          added.push(c)
        } catch (e) {
          skipped.push({ name: c.name, why: `排队失败：${e?.message ?? e}` })
        }
      }

      lastResult = { at: now(), reason, found: updates.length, added, skipped }
      log(`[autoscan] ${reason}：扫到 ${updates.length} 个更新，排进队列 ${added.length} 个`)
      return lastResult
    } catch (e) {
      lastResult = { at: now(), reason, error: String(e?.message ?? e), added: [], skipped: [] }
      log(`[autoscan] ${reason} 出错：${e?.message ?? e}`)
      return lastResult
    } finally {
      running = false
    }
  }

  /** 起定时器。返回 stop()；定时器 unref，绝不让它拖着进程不退。 */
  function start({ intervalMs = autoScanIntervalMs(DEFAULT_AUTO_SCAN_HOURS) } = {}) {
    const t = setInterval(() => { tick({ reason: 'timer' }).catch(() => {}) }, Math.max(60_000, Number(intervalMs) || 0))
    try { t.unref?.() } catch { /* ignore */ }
    return () => clearInterval(t)
  }

  return { tick, start, isRunning: () => running, last: () => lastResult }
}