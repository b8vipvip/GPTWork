# GPTWork 修复开发计划

> 适用分支：`fix/complete-master-tab-authority`（PR #187）
>
> 原则：在下述 P0/P1 项全部通过自动化测试和人工回归前，不合并 `main`，不发布正式版。

## 目标

本轮不是继续叠加兼容补丁，而是把运行时控制权收敛成清晰的三层：

1. **全局总开关（Master）**：只负责 GPTWork 整体启用/停用；关闭时所有窗口立即 fail-open、停止网络调试/本地核心/轮询，不再修改 ChatGPT 行为。
2. **窗口级功能状态（Window Feature State）**：Work 模式与模型锁按 Chrome `windowId` 隔离，同一窗口内的 ChatGPT 标签页共享状态，不同窗口互不影响。
3. **账号权益/并发窗口额度（Entitlement/Quota）**：只决定某窗口是否允许启用功能，不再与旧产品授权码系统混用。

## 已确认的未完成项

| ID | 优先级 | 问题 | 当前证据/风险 | 完成标准 |
| --- | --- | --- | --- | --- |
| R1 | P0 | 停用扩展或自动更新后 Chrome 多窗口卡死/崩溃 | 已打开页面中的旧 content runtime 可能在扩展上下文失效后继续计时、监听、重试；service worker 启动还会批量恢复注入；Debugger attach 缺少完整 single-flight | 多窗口、多标签页下停用/启用/更新/重载扩展均不出现浏览器假死、CPU/内存重试风暴、重复注入或 Debugger 泄漏 |
| R2 | P0 | Debugger attach 并发竞态 | `attachedTabs` 只能阻止“已完成 attach”的重复调用，不能阻止两个同时进行中的 attach | 同一 tab 任意时刻最多一个 attach/detach 生命周期；重复调用复用同一 Promise；导航/关闭/总开关关闭后清理完整 |
| R3 | P0 | content runtime 恢复策略过于激进 | 当前 service worker 每次启动都扫描所有 ChatGPT 标签页并在 ping 失败时注入整套脚本；MV3 worker 重启并不等于扩展升级 | 普通 service worker 唤醒/重启不再触发全浏览器批量重注入；真正扩展 install/update 才执行受控恢复，并限制并发、二次确认缺失后才注入 |
| R4 | P0 | 旧 runtime 的 terminal invalidation 不完整 | 单个 `content.js` 有 fail-open 检查，但其他 content 脚本可能仍保留 timer/observer/listener；`Extension context invalidated` 必须被视为终止状态而非普通断线 | 一旦检测到扩展上下文失效，旧 runtime 永久停止重连/轮询/阻断/DOM 对齐；不再尝试访问失效的 `chrome.runtime` |
| R5 | P1 | Work/模型锁实际按 tab 隔离，不是按窗口隔离 | `tab-feature-runtime.js` 当前状态 Map、持久化 key、GET/SET、清理逻辑全部以 `tabId` 为主键 | 状态改为 `windowId`；同窗口新开/切换标签继承；跨窗口移动标签重新绑定目标窗口状态；关闭窗口清理 session 状态；不同窗口可独立开关 |
| R6 | P1 | 总开关职责不纯、关闭语义不完整 | `master-runtime-safety.js` 通过 monkey patch `connectNative`、`alarms.create`、`windows.onCreated/onRemoved.addListener` 实现 gating，甚至会让必要的生命周期清理事件在 OFF 时不执行 | 不 monkey patch Chrome API；总开关由单一状态源显式驱动；OFF 时 detach/stop/fail-open，生命周期清理 listener 仍始终可运行；ON/OFF 在所有窗口即时一致 |
| R7 | P1 | 全局总开关与窗口功能状态耦合错误 | 当前 background 的 `enabled` 还叠加 `tabFeatureEnabledSync(tabId)`，导致“总开关开着但某 tab 功能未开”被当作 GPTWork 整体 disabled | Master 与窗口功能状态分别建模；Master=OFF 一票否决，Master=ON 时由窗口功能决定 Work/模型锁，不再把“功能未开”伪装成全局关闭 |
| R8 | P1 | 旧授权码/产品 License 体系仍需仓库级审计与彻底移除 | PR 已删除一部分消息兼容分支，但不能仅以 UI 不显示为完成；需要禁止旧协议、旧 storage key、激活/清除逻辑、旧提示重新进入运行路径 | 扩展生产代码/UI/存储迁移中不再存在旧产品授权码激活、校验、清除、额度授权逻辑；账号登录/订阅权益保留；增加 forbidden-token 回归测试 |
| R9 | P1 | `Unexpected token 'import'` 注入路径需要根因闭环 | 运行日志曾出现模块脚本被 classic script 环境解析的错误；当前 manifest service worker 是 module，但动态脚本注入仍需逐项检查 | 所有 `chrome.scripting.executeScript({files})` 只能注入 classic-safe 文件；模块只通过 module graph 加载；新增测试阻止 module 文件进入 content recovery bundle |
| R10 | P1 | CI 当前失败 | PR head 的 Extension checks 在 `Test extension policy` 失败，其他构建不能替代扩展测试通过 | Extension checks、Private Core Boundary、Store Package、Native Core/Private Engine、打包相关检查全部为绿 |
| R11 | P2 | PR 描述与真实实现不一致 | PR 目前仍写“per-tab isolation”，与本轮需求相反，也会误导后续维护 | 代码完成后同步更新 PR 描述、架构文档和测试名称，使其明确为 window-level isolation |

## 分阶段实施

### Stage 0 — 基线、问题清单和测试护栏

状态：**进行中**

- 固化本文件作为单一修复清单。
- 记录当前 PR head、CI 失败项及关键运行时文件。
- 为 P0 生命周期问题先补回归测试，再修改实现。
- 每完成一个 Stage 独立提交，避免把行为修复和大规模清理混在一个 commit。

退出条件：所有 R1–R11 都有明确 owner（当前均由本 PR 承担）、完成标准和测试入口。

### Stage 1 — P0：停用/更新卡死与 Debugger 生命周期

状态：**待修复（本轮优先）**

实施项：

- `network-monitor.js` 增加 attach/detach single-flight，解决同一 tab 并发 attach 竞态。
- 重构 `content-runtime-recovery.js`：
  - 普通 service worker 启动不再全量恢复；
  - install/update 采用受控、串行/限并发恢复；
  - 注入前进行二次 ping；
  - tab loading、关闭、URL 越界、master OFF 时立即取消。
- 建立 content runtime terminal invalidation 机制，优先覆盖所有会持续运行的 timer/observer/retry 模块。
- 检查所有 `executeScript` 文件列表，禁止 ES module 进入 classic 注入列表。
- 增加自动化测试：并发 attach、重复恢复、worker restart 不批量注入、update 恢复限流、context invalidated 后不再重试。

退出条件：R1/R2/R3/R4/R9 自动化测试通过，并完成多窗口人工复现矩阵第一轮。

### Stage 2 — P1：真正的窗口级功能隔离

状态：**待修复**

实施项：

- 将 `tab-feature-runtime.js` 重构为 window authority（计划更名 `window-feature-runtime.js`）。
- `chrome.storage.session` 以 `windowId` 持久化 Work/模型锁状态。
- 所有策略派生、请求重写、Debugger、响应验证、浮动 UI 均从 sender tab -> `windowId` -> window feature state 获取同一份有效状态。
- 处理 `tabs.onAttached/onDetached`、tab 跨窗口移动、`windows.onRemoved`、窗口中新建 ChatGPT tab。
- 保留必要的消息兼容层时，只兼容消息名称，不兼容旧的 tab 级语义。
- 将 `tab-feature-isolation.test.mjs` 替换为 window isolation 回归测试。

退出条件：R5 完成；至少覆盖“两窗口各多标签、状态互不影响、标签跨窗口移动、窗口关闭清理”。

### Stage 3 — P1：总开关单一权威

状态：**待修复**

实施项：

- 删除 `master-runtime-safety.js` 中对 Chrome API 的 monkey patch 路径，改为显式生命周期控制器。
- Master OFF：立即 detach 全部 GPTWork Debugger、停止 native reconnect/account refresh/自动验证/恢复注入、通知所有 content runtime fail-open 并隐藏/停用交互 UI。
- Master ON：只恢复允许的窗口；功能状态与账号窗口额度按各自职责判断。
- 生命周期函数（tab/window close、storage change 等）无论 Master 是否关闭都必须继续执行清理。
- 把“Master enabled”和“某窗口 Work/Model feature enabled”从 `settings.enabled` 的混合语义中拆开。

退出条件：R6/R7 完成；快速连续切换总开关也不会出现残留 Debugger、重复 native port、错误窗口状态。

### Stage 4 — P1：旧授权码体系彻底移除

状态：**待修复**

实施项：

- 对 extension、native bridge、服务端公共 UI/协议边界做仓库级扫描。
- 删除旧产品授权码相关 message type、storage key、activation/clear/validate handler、UI、迁移兼容和用户提示。
- 明确保留的是“账号登录 + 订阅/权益 + 并发窗口额度”，不是旧授权码机制。
- 将 legacy removal 测试改为**禁止列表**：一旦旧标识重新出现即 CI 失败。
- 对历史文档如需保留说明，仅允许出现在明确的 migration/history 文档，不得进入运行时代码和发布 UI。

退出条件：R8 完成，forbidden-token 扫描测试通过。

### Stage 5 — 全量回归、CI、合并与正式发布

状态：**待修复**

人工回归矩阵至少包括：

1. Chrome 1/2/5 个窗口，每窗口 1/5/20 个 ChatGPT 标签页。
2. Master ON/OFF 快速切换。
3. 窗口 A Work ON、窗口 B OFF；模型锁状态分别组合。
4. 将 ChatGPT tab 从 A 拖到 B，再拖回。
5. 在 `chrome://extensions` 直接停用 GPTWork，再启用。
6. 扩展自动更新/手动 reload，所有原有 Chrome 窗口保持响应。
7. 更新过程中正在生成回答、空闲页面、后台页面三种状态。
8. 检查任务管理器：无持续 CPU 飙升、无内存持续上涨；日志无 attach/reconnect/reinject storm。
9. 检查 `chrome.debugger`：关闭/停用/更新后无残留 attach。
10. 全部 GitHub Actions 绿灯。

只有 Stage 1–5 全部完成后才允许：

- 更新 PR #187 描述为真实的 window-level architecture；
- 合并到 `main`；
- 更新正式版本号和 changelog；
- 创建正式 Release。

## 当前状态记录

- [x] Stage 0：建立分阶段修复计划和验收标准
- [ ] Stage 1：停用/更新卡死 + Debugger 生命周期
- [ ] Stage 2：窗口级隔离
- [ ] Stage 3：总开关单一权威
- [ ] Stage 4：授权码体系彻底移除
- [ ] Stage 5：全量回归、CI、合并、正式发布

每个阶段完成时必须在本文件更新状态，不能只在 PR 评论中口头声明完成。
