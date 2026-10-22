# 更新记录

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
