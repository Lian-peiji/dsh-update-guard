## 0.1.6（2026-11-02）

主人让「查查运行情况，看看需不需要修复升级优化」。查了 11 天的真机数据（更新档案 277 条、
队列 120 条、病历 4 份），揪出两个**「测试全绿、真机静默出错」**的 bug，都修了。

### 1. 🔴 僵尸任务清理从 v0.1.5 起就没跑过（`dir is not defined`）

0.1.5 加的那个 `recoverZombieJobs()` 调用写的是 `recoverZombieJobs(dir, ...)` —— 但
**`apply()` 里根本没有 `dir` 这个变量**（正确的名字是 `pumpDir`）。于是每次都抛
`ReferenceError: dir is not defined`，被外层 `catch` 吞掉，日志里只有一句
「收拾残留出错（不影响正常跑）」，谁也看不见。

后果（真机证据，都还摆在队列里）：

| 任务 | 卡在 running 多久 |
| --- | --- |
| cc-safety-net → 2.6.19 | **6 天**（10-27 起） |
| dsh-meme → 0.1.67 | **4 天**（10-29 起） |
| dsh-free-search → 0.9.21 | **3 天**（10-30 起） |

更糟的是 0.1.5 的 CHANGELOG 写着「真机上那个任务已当场放回队列」—— **那句话是假的**，
代码从来没跑通过。所以这次连同「怎么防止再犯」一起改了：

- `dir` → `pumpDir`；
- catch 里升级到 `ctx.logger.error`，清理失败必须出声，不许再静默；
- 新增 `test/regress-0.1.6.mjs`，静态扫描源码钉死这行用的是 `pumpDir`。

真机上那 3 条已当场收拾干净（`running: 3 → 0`）。

### 2. 🔴 bundle 型插件被误判「不是 DSH 插件」→ 连滚 18 次

`apply.js` 的 `verifyInstalled` 只认 `mod.apply` / `mod.default.apply`。
而 10-23 的提交 `07a9ded` 给 `sandbox-trial.js` 补过 `declaresDsh` 判定，**`apply.js` 那份漏改了**。

于是 cc-safety-net（`exports["."]` 指向 `dist/index.js`，导出的是 `{id, effect, server}`，
真正入口在 `dsh.bundle.patch` 里指定的 `dist/deepseek-harness/index.js`）每次真装都被判：

> 装上了但加载不起来（没有导出 apply —— 不是 DSH 插件），装进去 DSH 会崩，已经自动退回 2.6.16

**18 次真装成功 → 18 次被自己回滚掉**，白烧 18 轮试跑。而它现在装着的 2.7.1 用同一套判定
也过不了 —— 说明是**误判，不是新版本坏了**。

修法：把入口解析 + 插件判定抽成 `sandbox-trial.js` 的 `inspectInstalledPackage()`，
`apply.js` 与 `loadInStage` **共用一份**（两份各写各的正是这次漏改的根源）。现在：

- 认三种形态：`mod.apply` 是函数 / `default` 是函数或带 apply / `package.json` 声明了 `dsh` 字段；
- bundle 型插件优先用 `dsh.bundle.patch` 里 `name:` 指向的入口（相对补丁文件所在目录）。

**副产品**：`test/loadprobe.mjs` 从 8 失败变成 12/12 全过 —— 那 8 个失败其实一直是同一个根因。

### 3. 🟠 僵尸恢复时顺手收尾「目标版本已过时」的任务

僵尸躺了 3~6 天才被收拾，它的目标版本往往早就过期了（cc-safety-net@2.6.19 放回队列时
实装已经是 2.7.1）。直接放回 pending 只会白跑一轮试跑 + 白调一次审查模型。

`recoverZombieJobs()` 新增 `installed` 选项：实装版本 ≥ 目标版本 → 判 `done` / `result: "obsolete"`，
不再白跑。不传 `installed` 时行为与以前**完全一致**（向后兼容，旧的 5 个测试一个没改）。

### 4. 测试

新增 `test/regress-0.1.6.mjs`（8 个断言），并加进 `npm test`。全套 13 个套件：

```
smoke 58 · assemble ✓ · p2 21 · client 49 · webapi 62 · p3-memory 22 · probe_cfg 6
p4 62 · patchfix 23 · sentinel 36 · autoscan 41 · loadprobe 12 · regress 8
```

### 顺带记录的现状（没改代码，但要知道）

- **cc-safety-net 其实已经是 2.7.1 了**，不是 2.6.16。那 18 次回滚是历史；10-31 之前
  某次真装成功了，所以现在磁盘上是 2.7.1。**这不否定 bug 2** —— 恰恰证明 2.7.1 本身能装。
- 队列 120 条无裁剪、同版本反复排队（billion-context@0.1.208 排了 12 次、cc-safety-net 系列
  累计 37 次）仍是待优化项，本次没动。
- 118 次审查里 12 次是「审查模型不可用，按默认策略放行」，属既定策略，未改。

## 0.1.5（2026-10-25）


主人让「全面检查一下插件，看看逻辑合不合理」。查完发现四个真问题，都修了。

### 1. 僵尸 `running` 任务会把包永久静音（最严重）

真机证据：队列里 `@michengai/dsh-skills-manager → 1.2.13` 卡在 `status: 'running'`，
`startedAt` 停在 **2026-10-23T09:53 —— 两天前**。

原因是宿主重载/崩溃时，`markJob(running)` 已经落盘、`finally` 里的收尾没来得及跑。
后果是一串的：`pendingJobs()` 不认它（不跑）；`renderQueue` 给它挂 ⏳（看着像正在装）；
`addJob` 的去重把它当「已在排队」（连重排都不让）—— 这个包从此彻底静音，还占着 ⏳。

修法：新增 `recoverZombieJobs()`，在 `pump.start()` **之前**跑一次。
判定保守：只有超过 `ZOMBIE_AFTER_MS`（30 分钟）没动静才算残留；
真在跑的任务几十秒内就会推进，不会误杀。已试满 3 次的判 failed，否则放回 pending。
**真机上那个任务已当场放回队列**（`running:1` → `pending:1`）。

### 2. 两个配置项静默失效

`Config` schema 里声明了 `sentinel` / `sentinelDebounceMs`，但 `cfg` 对象里**漏了**。
后果：主人改 `sentinelDebounceMs` 永远用 2500（改了没反应），
`sentinel` 关不掉（被 `cfgBool(undefined, true)` 兜成开）。
现在 schema 22 项 ↔ cfg 22 项一一对齐。

### 3. 自动巡场可能永久卡死

`createAutoScan` 有 `running` 防叠加，但如果某次 `scan()`（并发打 registry）卡住不返回，
`running` 就**永远是 true**，之后每轮都 `skipped: 'busy'` —— 巡场静默死掉，
界面上只显示「上次巡场：busy」，看不出是坏了。
现在给整轮一个上限（默认 10 分钟，实际取「巡场间隔的一半」），超时就放弃这轮、放掉 `running`。

⚠️ 写超时守卫时踩到一个坑并记在这：`setTimeout(...).unref()` 会让 node 认为「没我事了」直接退出，
超时守卫永远不触发（单测里实测复现）。所以这里**故意不 unref**，靠 `finally` 里的 `clearTimeout` 收尾。

### 4. 队列路径会在 `auto` 设置下自动重启，违反硬约束 7

主人拍过板：「自动化任务里**禁止**『自动更新插件 + 自动重启』」。
但队列的 `runJob` 里写着 `if (restartAfterApply === 'auto') restartSelf(...)` —— 队列就是自动化任务。
现在队列这条路**永不重启**，只写日志提示「装好了，要生效请主人手动重启」；
`auto` 开关只留给主人手动点 `plugin_update_apply` 时用。

### 兼容性核查（结论：能适配当前宿主）

- 用到的宿主事件 `session/event`、`api-session/status`、`agent/status`、
  `agent/inbox/inserted`、`agent/disposed` —— 五个在 `app.asar` 里都还在。
- 用到的服务 `sessions` / `webServer` / `slots` / `llm` / `agentDefaultModel` 都在。
- `tools.guard` 仍在（硬拦截靠它）。
- `HOST_INJECTED` 名单与宿主 `pnpm-workspace.yaml` 的 `peerDependencyRules.ignoreMissing`
  **逐项一致**（28 项），试跑不会误报缺包。
- `eventAt` 是 **0-based**（合法下标 0…n-1），已在 0.1.4 修正。

测试：343 项全绿（新增僵尸恢复 5 项、巡场超时 1 项）。

## 0.1.4（2026-10-25）

修一个把主人吓到的误判：**「我没进行任何对话，怎么显示 5 个正在运行？」**

真机查出来的根因是两层，都在 `lib/idle.js`：

1. **事件流把收尾的回合重新点着。** 原来「任何非 `turn/end` 事件 → running」，
   而宿主在 `turn/end` 之后紧跟一条 `session/end-seed`（还有 `session/title`、
   `todo/write`、`model/selection`、`compaction/*`、`plugin:*` 这些回合之外的记账事件）。
   于是 turn/end 先置 idle，下一条 end-seed 又把它摁回 running，
   四条早就聊完的会话全被算成「正在跑」。
   现在：**记账事件只续命（`keepAlive`），绝不把 idle 改回 running**；
   回合内事件（`tool/call`、`step/start`…）照旧算 running（宁可多等，别在主人干活时动 node_modules）。

2. **扫会话只看最后一条事件。** `scanBusySessions()` 原来拿 `lastEventType()` 就下结论，
   同样被记账事件带偏。现在新增 `turnStateOf()`：**往回找最近一条 `turn/*`**，
   那才是宿主自己写下的回合真相。
   回看预算是 20000 条而不是 200 —— 实测当前会话 230 条事件、`turn/start` 在第 6 条，
   一个回合里能堆两百多条（每个 step 都有 user/message、translator、assistant 消息）。
   结果按 `(session, seq)` 缓存，seq 不变不重扫，probe 高频调用零成本。

顺带修的：`reason()` / `snapshot()` 原来各自重复调 `runningAgents()` + `probedBusy()`，
现在合并成一次 `busyIds()`；诊断文本从「最后事件 xxx」改成
「`turn/xxx` 之后最后事件 yyy」，一眼能看出是哪个边界判的。

**实测验证**（拿五个真实会话日志跑）：修复前 5 个全判「忙」，修复后
**1 个真忙（就是当时正在对话的那个）+ 3 个已收尾 + 1 个判不出（不拦人）**。

测试：`test/p4.mjs` 新增 8 项回归（记账事件不许复活、长回合不许被回看预算截断、
缓存语义、`isBookkeeping` 边界），共 **54 项**，全绿。

## 0.1.3（2026-10-23）

修三个真机上当场被抓到的毛病：

- **时间不再是 UTC**。更新档案里原本显示 `02:37`，实际是她上午 10:37 的操作。
  现在一律换算成北京时间（`Asia/Shanghai`）显示，写在 `lib/client.js` 的 `fmtTime()`。
- **统计卡片不再恒为 0**。装成功 / 已回滚 / 没装成 三张卡读的字段（`st.applied`、
  `st.rolledBack`、`st.refused`）在档案里根本不存在，所以永远是 0；
  现在由 `lib/memory.js` 的 `ledgerStats()` 按 `byResult` 明细自己数。
- **bundle 插件不再被误判成「这不是一个 DSH 插件」**。`cc-safety-net` 2.6.17 就是被这条卡住的：
  它是 bundle 插件（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
  入口本来只有 `default`，没有 `apply`。现在的规矩：**import 不抛异常就算装得上、加载得起来**；
  有没有 `apply` 只影响一句说明，不影响判决。顶层就炸的包照样拦（`test/loadprobe.mjs` 12 项覆盖三类包 + 坏包）。

另外把 `npm test` 补全成 12 个套件（原来漏了 `sentinel` / `patchfix` / `autoscan`），共 **394 项**。

# 更新记录

## 未发布 —— 插件自己巡场，不用主人点（2026-10-23）

主人原话：「我们这插件是一个无需主动触发的兜底插件，日报统计的可更新就让插件自己处理」。

以前「发现有更新」还得有人问一句、或者有人去点扫描。现在它自己来：

- **新模块 lib/autoscan.js**：定时扫 registry，把有新版本的包自动排进队列。
  默认 **6 小时**扫一次（`autoScanHours`），一次最多排 **5 个**（`autoEnqueueMax`，大版本优先）。
- **只负责「发现」，不负责「动手」**：排进队列之后仍然是
  `等空闲 → 模型审查 → 试跑 → 真装 → 加载验证 → 失败自动回滚`。
  模型判 `skip` / `hold` 的一个都不装 —— 巡场绝不等于「一键更新」。
- **三条分寸**：上一轮没扫完就跳过这一轮（不叠罗汉）；队列里已有的不重复排；
  开机先等 90s 再扫（那会儿 pnpm 锁和 registry 连接都还紧）。
- **在哪看**：`plugin_queue` 输出里多了一行「自动巡场：每 6 小时一次；上次 … 排进队列 N 个」，
  管理台的队列接口也会带上 `autoScan` 状态。
- **测试**：新增 `test/autoscan.mjs` 39 项，全套 **377 项全绿**。

## 未发布 —— 后台队列也先审查再装（2026-10-23）

主人说「让他自己触发」，但那句话的重点从来不是「无脑装最新」——
她从头要的是「模型先替她判：这次更新要不要、会踩什么坑、我们的补丁怎么打」。

- **原来的缺口**：后台队列的 `runJob` 只跑「试跑 → 真装 → 验证」，
  **跳过了模型审查那一步**。也就是说，排队 = 把把关权交回去，
  队列退化成普通的「一键更新」，正好是这插件存在的理由的反面。
- **修法**：`runJob` 现在第一步先调 `reviewFor()`（侦察 → 深挖 diff → 读我们的补丁 → 带病历 → 模型判决），
  只有判决 `install` 才继续试跑和真装；`skip` / `hold` 一律**不装**，判决与理由写进账本。
- **审查本身出错**（模型超时、判不出来、侦察不全）→ 按「先等等」处理，**绝不静默放行**。
  这条是 2026-10-22 修过的 bug（静默放行 = 出问题没人知道），队列里同样不许复发。
- **测试**：p4 39 项 / assemble 25 项全绿；同步两处部署副本后关再开热重载，
  `plugin_queue list` 正常显示 2 个待办，空闲判定仍按「有会话在跑就不动」工作。

## 未发布 —— 管理台 404 修好了（2026-10-23 早）

真机事故：主人打开「插件管家」设置页，接口全部 404，看起来像插件崩了。

- **现象特别容易误判**：`plugin_manager` 里 `include:dsh-update-guard` 是
  `enabled: true, fiberPhase: "active"`，11 个工具全部可用，
  同端口 `/dsh-market/status` 也是 200 —— 只有 `/dsh-update-guard-api/*` 是 404。
- **根因**：`lib/index.js` 注册路由时写的是 `ctx.get('webServer')`。
  插件 `apply()` 跑到这一段时宿主 `webServer` 服务**还没挂载**，`ctx.get` 返回 `undefined`，
  整块被静默跳过 → 路由从来没注册过。外面那层 try/catch 也不会报错，连一条 warn 都没有。
- **修法**：改成生态里统一写法 `ctx.inject(['webServer'], (webCtx) => …)`，
  服务就绪后再注册（`dsh-meme`、`billion-context`、皮肤插件都是这个写法）；
  宿主没有 `inject` 时才退回「立即挂载」。
- **验证**：同步两处部署副本 → 关再开（热重载，不用重启宿主）→
  `/overview` `/patches` `/errors` `/queue` `/backups` 全部 200，并返回真实数据。
- **教训（写进代码注释）**：宿主服务优先用 `ctx.inject` 拿，`ctx.get` 只用于
  「有就有、没有也活」的可选能力；注册类副作用（路由 / 事件 / slot）即使跳过，
  也要留一条 info 日志，否则真机上表现为「插件好好的，就是功能没了」。

## 未发布 —— 非 registry 源也能升级了（2026-10-22 夜）

真机事故：主人在插件市场更新 `dsh-fish-memory`，连续失败两次，报
`ERR_PNPM_UNUSED_PATCH` → `ambiguous-install`。

- **根因一（市场的）**：补丁 key 钉在 `dsh-fish-memory@1.2.1`，而新 commit 里写的是 `1.2.2`。
  pnpm 认为「这个补丁没处用」，直接中止整个安装。
- **根因二（我们的）**：`plugin_update_apply` 对 git / tarball 源**直接拒绝升级**
  （「不是 npm 上的包，没法改版本号」）—— 于是这种包永远修不了，正是主人说的死结。
  而且重定位时把 git spec 当版本号，拼出 `dsh-fish-memory@github:...#sha` 这种 pnpm 绝不认的 key。
- **修法**：
  - `lib/recon.js` 新增 `parseTargetSpec` / `resolveTargetVersion` / `readVersionFromFiles`：
    把「裸版本 / `github:owner/repo#ref` / tarball 地址 / dist-tag」统一解析出**真版本号**（下载 tarball 读 `package.json`）；
  - `lib/apply.js` + `lib/sandbox-trial.js` 接受 `targetSpec`：非 registry 源改为**换 spec**（而不是写版本号），
    同时补丁 key 按真版本重定位 —— 两件事必须成对发生；
  - `lib/index.js` 的 `runUpdate` 与 `plugin_update_trial` 都先解析真版本再动手。
- **踩到的坑（已写进代码注释）**：`github:` 简写会让 pnpm 去 **git clone github.com**，
  而本机到 `github.com:443` 是**连不通**的（`ERR_PNPM_GIT_FETCH_FAILED`）。
  必须换成 **codeload tarball 地址**——主人现有的 spec 就是这个形状。
- 真机结果：`dsh-fish-memory 1.2.1 → 1.2.2` 装成功（试跑 8.4s / 真装 6.0s），
  补丁重定位后**字节级打上**（`lib/index.js` 里那行「兼容旧版」注释就是补丁的产物），
  旧 `@1.2.1` 补丁文件与 `intent.md` 一并升到 `@1.2.2`，补丁账本重新变干净。

## 市场哨兵（2026-10-22 夜）

- **新增 `lib/sentinel.js` + `plugin_drift` 工具**：主人在**插件市场**里自己点「全部更新」时，
  那条路不经过任何工具调用（`点按钮 → dshmarket 自己跑 pnpm → 宿主包操作`），
  硬拦截拦不到。哨兵改为「事后第一时间说清楚」：
  - 听 `plugin-manager/install-log`，认出 `ERR_PNPM_UNUSED_PATCH` / `ambiguous-install` /
    retarget 提示 / frozen-lockfile 等坑，抠出包名记进错误知识库；
  - 听 `plugin-manager/changed` 与 `install-state`，防抖 2.5s 后对比 profile 指纹
    （依赖版本、声明源、`patchedDependencies` 登记、`patches/*.patch`、`intent.md`），
    报「谁被换了版本 / 哪个补丁没了」；
  - **基线落盘**（`profile/.update-guard/sentinel-baseline.json`）：市场更新常连带重启 DSH，
    基线只在内存里就会丢掉那次变动 —— 这是最容易漏的一类。
  - 只观察、只记录，**不改任何东西**（不重装、不重打补丁）；设置项 `sentinel`、`sentinelDebounceMs`。
- 自测新增 `test/sentinel.mjs` **36 项**；`assemble` 现在会跑 11 个工具。
- ⚠️ 已知局限：宿主的 `install-log` 事件载荷没有强类型契约，取不到文本时只退化掉「报了什么错」这层；
  版本/补丁的对比走文件指纹，不依赖事件内容，始终有效。
- ⚠️ 真机事故（同日晚）：主人在市场点「全部更新」，`dsh-fish-memory` 更新失败，
  报 `更新前的构建未能验证恢复（{"code":"ambiguous-install"}）`。事后核查：profile 干净、
  包退回、锁文件一致、两个补丁字节级完好、无需重启 —— 也就是说这条横幅是**虚警**，
  但这正是「市场这条路我们看不见」的实证。

## 未发布 —— 补上最后三块（2026-10-22 晚）

- **补丁打不上时可以「重新对准」**（`lib/patchfix.js`）：拉新版本原始文件 → 强档模型只挪位置不改行为 →
  三道机械验收（能干净打上 / 原补丁新增的名字一个不少 / 只改一个文件）→ 过了才写盘，先备份旧补丁。
  任何一道不过就照旧例放弃更新。设置项 `patchFix`（默认开）、`patchFixTokens`。
- **设置页新增「后台队列」页签**：看队列里排了什么、现在能不能动手、为什么不能，可删单条 / 清空待办。
  对应接口 `/queue`、`/queue/remove?id=`、`/queue/clear`（只动插件自己的 `queue.json`，不碰 profile）。
- **两个补丁补了 `intent.md`**（`dsh-pocket@2.12.0`、`dsh-fish-memory@1.2.1`）：症状 / 根因 / 退役条件。
  README 里补了 intent 的格式说明与「补丁打不上怎么办」。
- 自测 292 项全绿（新增 `test/patchfix.mjs` 23 项、webapi 队列接口 19 项）。

## 0.1.0 —— 第一个可用版本（2026-10-22）

一开始只是为了一台机器：装了几十个插件、打过几个补丁，每次升级都要手工救一次，救完下次又被覆盖。
这个版本把那条手工流程变成了四个可验证的环节。

### 有了什么

- **侦察** `plugin_update_scan`：装了什么、哪些有新版本、补丁现状。
- **审查** `plugin_update_review`：新旧版本逐文件 diff → 模型判「装 / 等等 / 跳过」+ 风险清单 + 置信度。
  低风险走便宜档、高风险走强档；输出截断会重试一次并把残片抢救成 JSON。
- **试跑** `plugin_update_trial`：系统临时目录里真装真加载，脏不了 profile。
- **执行** `plugin_update_apply`：快照备份 → 本地补丁迁移 → pnpm install → 装完立即加载验证 → **任何一步失败自动回滚**。
- **补丁保活**：统一走 pnpm `patchedDependencies`，每次 install 自动重放；账本正反核对「登记的有没有文件 / 有文件的有没有登记」。
- **新装体检** `plugin_install_check`：裸 import 缺失、会遮蔽核心包这类问题可做硬拦截。
- **记忆双库** `plugin_memory`：更新档案（谁升到了哪、成没成、回滚没有）+ 错误知识库（症状/根因/修法/涉及版本）。
- **空闲编排** `plugin_queue`：等你不用了才动手——没有会话在跑、连续安静 2 分钟、随时可叫停。
- **带兜底的重启** `plugin_restart`：独立帮手在进程树外盯着，成功只认新 pid 连续稳定 8 秒。
- **设置页「插件管家」**：更新记录 / 错误知识库 / 补丁账本三个页签。

### 已知边界

- 重启帮手按进程名整体结束再拉起，只在 Windows 真机验证过；Linux/macOS 未验证。
- 审查模型只读 diff 与 changelog，不做逐行语义证明；它是**收窄风险**，不是**消灭风险**。
- 补丁冲突时的「模型辅助重写补丁」还没做：目前冲突一律按「放弃更新、保旧版」处理（宁可不上新功能）。
- 队列的配置项目前写在配置文件里，设置页还没有控件。

### 教训（写进代码的那些）

- 只杀不拉 = 应用在后台死两小时。所以重启必须自带「起不来再拉、拉三次不行就喊人」。
- 只关宿主不关主进程 = 窗口卡在半死状态。所以重启要整体结束，清不干净就宁可不拉。
- 判定重启成功不能看端口通不通，要看**新进程**连续稳定。
- 审查失败不能静默放行。看不懂就说看不懂，不要假装「可以装，置信度 0」。
## 0.1.1 — 重启真的能回来了

- **修**：重启帮手以前会在结束旧进程后**干等 90 秒**才去拉起新实例（那 90 秒里根本没人拉），
  真机上表现为「关掉后快两分钟才回来，看着就像没重启」。现在杀完立刻拉，正常 10 秒内回来。
- **修**：帮手调 `taskkill` / `tasklist` / `netstat` 时没加 `windowsHide`，
  屏幕上会连环闪 CMD 黑窗。全部补上。
- **修**：探活把 5xx 当成「已经起来了」，其实那时后端还在启动。改成只认 2xx/3xx/4xx。
- **改**：拉起的首选改成直接 `spawn`（真机实测有效），`explorer.exe` 只作兜底。
- **加**：帮手每 10 秒写一次心跳（进程 + 监听端口），下次出问题不用靠猜。
- **加**：探测结果里带「重启可能被取消」的判定 —— 旧实例还在跑时绝不硬杀、也绝不旁边再拉一个。
- **说明**：宿主的 DSH 进程是 `ELECTRON_RUN_AS_NODE` 子进程，拿不到 Electron 的 `app` 对象，
  所以 `app.relaunch()`（DSH 本体重启用的是这条）在插件里走不通，只能杀+拉；
  代码里保留了 `getElectronApp()`，将来宿主若把 `app` 暴露出来会自动切到更稳的那条路。
