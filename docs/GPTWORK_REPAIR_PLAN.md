# GPTWork 修复开发计划

> 适用分支：`fix/complete-master-tab-authority`（PR #187）
>
> 原则：P0/P1 修复必须先通过自动化测试与真实 Chrome 生命周期回归；Stage 5 未完成前不合并 `main`、不发布正式版。

## 最终架构边界

最终实现不允许通过不断叠加条件来“修住”同一个状态。每个 concern 只有一个写入/决策 owner，其余模块只能消费结果：

1. **全局总开关（Master）**：`gptworkEnabledLocal` 是唯一持久化事实；`master-ui-controller.js` 是扩展页面唯一 Master UI writer；`background.js` 是 Native/alarms/Debugger/badge/Master-OFF cleanup 的唯一后台生命周期 authority。
2. **标签页功能状态（Tab Feature State）**：`tab-feature-runtime.js` 独占 `tabId -> {workModeEnabled, modelLockEnabled}` 的读写与 `GPTWORK_TAB_FEATURE_GET/SET`。两个 ChatGPT 标签页即使位于同一个 Chrome 窗口也互不共享；移动标签页时该标签页保留自己的状态。
3. **账号权益与并发窗口额度（Entitlement/Window Quota）**：只负责回答“当前账号/当前窗口是否允许启用”，不拥有 Master 或 Work/Model 状态。窗口额度继续按 Chrome `windowId` 计数，但功能状态绝不按 `windowId` 保存。
4. **后台请求执行（Enforcement）**：`background.js`/network monitor 只消费 Master、目标 tab feature state、账号可用性和策略，不反向写 Work/Model 开关。
5. **更新代际一致性（Runtime Generation）**：`runtime-generation.js` + `extension-page-runtime.js` 只处理“新页面文件 + 旧 Service Worker”协议错代；它不拥有任何业务开关。发现代际不一致时只执行一次 `chrome.runtime.reload()`，禁止用重试/兼容分支叠加旧新协议。

## 问题与当前收敛状态

| ID | 优先级 | 问题 | 当前状态 | 最终完成标准 |
| --- | --- | --- | --- | --- |
| R1 | P0 | 停用扩展或自动更新后 Chrome 多窗口卡死/崩溃 | **代码与自动化防线已完成，真机回归待 Stage 5**。取消普通 SW 唤醒的全浏览器恢复注入、串行化 debugger 配置、增加 terminal lifecycle supervisor、Master OFF 统一停止后台运行时 | disable/re-enable/update/reload 均不假死，无 CPU/内存重试风暴、重复注入、Debugger/Native 残留 |
| R2 | P0 | Debugger attach 并发竞态 | **已实现并有自动化护栏**。同一 tab attach/detach single-flight | 同一 tab 任意时刻最多一个 attach/detach 生命周期，导航/关闭/Master OFF 清理完整 |
| R3 | P0 | content runtime 恢复策略过于激进 | **已实现并有自动化护栏**。仅真实 install/update 受控恢复；逐 tab 串行、二次探测 | 普通 SW 唤醒不批量重注入，真正 install/update 才恢复且无并发风暴 |
| R4 | P0 | 旧 runtime terminal invalidation 不完整 | **已实现并有自动化护栏，真机待验收**。同步异常、Promise rejection、callback `runtime.lastError` 的真实 context invalidation 都触发 terminal shutdown | 失效 generation 永久停止重连/轮询/阻断/DOM 对齐 |
| R5 | P1 | Work/模型锁应按 ChatGPT 标签页独立，而非按窗口共享 | **已改为真正 per-tab authority，自动化已通过**。状态使用 `gptworkTabFeatureStatesV2` 按 `tabId` 保存；临时 window state 仅做一次迁移源 | 同一 Chrome 窗口 tab A/B 可保持相反状态；关闭 tab 清理；跨窗口移动时该 tab 保留原状态且不影响目标窗口其他 tab |
| R6 | P1 | Master 职责不纯、关闭语义不完整 | **已实现并有自动化护栏**。删除重复 Master runtime cleanup；`background.js` 单点负责 Native/alarms/Debugger/badge/Master OFF | Master OFF 即时停工/fail-open，ON/OFF 全局一致，无重复 cleanup authority |
| R7 | P1 | Master 与功能状态耦合/双写 | **已实现并有自动化护栏**。Master 与 per-tab Work/Model 分离；设置页/Popup 使用同一 Master UI controller | Master=OFF 一票否决但不销毁各 tab feature 选择；ON 后恢复各 tab 自身选择 |
| R8 | P1 | 旧授权码/产品 License 体系残留 | **已清理并由 forbidden-token 测试保护** | 生产扩展/UI/迁移不再存在旧产品授权码激活/校验/清除逻辑 |
| R9 | P1 | `Unexpected token 'import'` 注入路径 | **已闭环并有自动化护栏** | 动态注入只使用 manifest 中 classic-safe content scripts |
| R10 | P1 | CI 必须全绿 | **当前 head `f08ae6b1` 全绿**：CI #754、Store Package #208、Private Core Boundary #398 均 success | PR 最终 head 的 CI / Store Package / Private Core Boundary 全部 success |
| R11 | P1 | 安装器原地替换扩展文件后，新 Popup/Settings 与旧 MV3 Worker 协议错代 | **已加入单一 generation barrier，自动化已通过，真机待验收**。新扩展页面在发送 Master/feature 命令前比较 worker generation，不一致只触发一次 extension reload | 原地升级保持 Chrome 打开时，不再出现 `Unsupported extension message: GPTWORK_MASTER_SET` / `GPTWORK_TAB_FEATURE_SET`；无 reload storm |

## 分阶段实施

### Stage 0 — 基线、问题清单和测试护栏

状态：**完成**

- 本文件作为单一修复清单。
- 明确 owner 边界，禁止两个模块同时拥有同一业务状态的部分写入权。
- 建立最终多窗口/多标签/停用/更新回归矩阵。

### Stage 1 — P0：停用/更新卡死与 Debugger 生命周期

状态：**代码与自动化完成；真实 Chrome 生命周期验收待 Stage 5**

已完成：

- `network-monitor.js` attach/detach single-flight。
- `content-runtime-recovery.js` 仅在真实 install/update 进行受控逐 tab 恢复；普通 SW 唤醒不再全量重注入。
- recovery 注入前双探测，并重新检查 Master、URL、tab loading 状态。
- `content-runtime-lifecycle.js` 建立 terminal shutdown，清 Timer/Interval/RAF/MutationObserver/EventListener。
- true context invalidation 在同步、Promise、callback 三条 sendMessage 路径都终止旧 generation；普通 `Receiving end does not exist` 不误判为 terminal。
- `background.js` Native/reconnect/account heartbeat/Debugger 显式 Master-gated；全 tab debugger 配置串行；initialize single-flight。
- 删除重复 `master-runtime-safety.js` cleanup authority。

### Stage 2 — P1：真正的标签页级功能隔离

状态：**实现与自动化完成；真实 Chrome 待验收**

已完成：

- 权威状态使用 `gptworkTabFeatureStatesV2`，按具体 ChatGPT `tabId` 持久化到 `chrome.storage.session`。
- 历史 `gptworkTabFeatureStatesV1` 与本轮曾引入的 `gptworkWindowFeatureStatesV1` 都只作为一次性迁移源；迁移后删除旧 session key。
- 同窗口多个 ChatGPT tab 不共享 Work/Model Lock；每个 tab 独立 GET/SET。
- tab 关闭/离开 ChatGPT 时删除该 tab feature state。
- tab 跨窗口移动保持自身 feature state，只更新用于账号并发额度判断的 window identity。
- Debugger、请求策略、Native verification 始终按目标 sender tab 消费 effective policy。

### Stage 3 — P1：总开关与后台生命周期单一权威

状态：**实现与自动化完成**

- `master-ui-controller.js` 是 Popup/Settings 唯一 Master writer；`options.js` 不再写/重绘旧 `settings.enabled`。
- `gptworkEnabledLocal` 为 Master canonical storage。
- `background.js` 是 Native Messaging、reconnect/account alarms、Debugger、badge、Master-OFF shutdown 的唯一后台生命周期 owner。
- Master OFF 永远允许，不依赖账号/Native；关闭时 fail-open，但保留各 tab Work/Model 选择。
- `tab-feature-runtime.js` 只处理 GPTWORK Master/feature control protocol；`background.js` 对这些消息显式 `return false`，不形成第二个 switch owner。

### Stage 4 — P1：旧授权码体系彻底移除

状态：**实现与自动化完成**

- 清理生产扩展中的旧 License UI/message/storage/migration。
- 保留账号登录、订阅 entitlement、并发窗口额度；不与旧授权码体系混用。
- forbidden-token 测试防止旧协议重新进入生产代码。

### Stage 5 — 真机回归、最终 CI、合并与正式发布

状态：**进行中；当前 head 自动化全绿**

本阶段已通过实机发现并修复：

- Windows 原地更新时 Native Core 被 Chromium 重新拉起导致替换竞态。
- 登录后 startup hydration 覆盖新 session / stale UI 错误要求再次登录。
- Master/Work/Model 开关卡住与 Settings/Popup Master 不一致。
- 原地替换扩展文件时新页面命令打到旧 Service Worker，出现 `Unsupported extension message`；现由单一 runtime generation barrier 处理。
- 产品语义纠正：Work/Model 必须 per-tab，不得按 window 共享。

真实 Chrome 人工回归矩阵：

1. 保持 Chrome 打开，覆盖安装最新 PR artifact；首次打开 Popup/Settings 最多允许发生一次受控 extension reload，之后不得再出现 Unsupported message/reload storm。
2. Popup 与 Settings Master 完全一致；快速 OFF/ON 多次仍一致。
3. 同一 Chrome 窗口打开 tab A / tab B：A Work ON、B OFF；再反向组合；Model Lock 同样验证。
4. 将 tab A 拖到另一个 Chrome 窗口：A 保留自己的 Work/Model 状态，目标窗口其他 tab 不改变。
5. Master OFF 后所有 tab 立即 fail-open/停止运行；Master ON 后各 tab 恢复各自之前的 feature 选择。
6. Chrome 1/2/5 个窗口，每窗口 1/5/20 个 ChatGPT tab，验证无跨 tab 污染。
7. `chrome://extensions` 直接停用 GPTWork，再启用；所有原窗口保持响应。
8. 自动更新/手动 reload，覆盖正在生成回答、空闲、后台 tab 三种状态。
9. 任务管理器无持续 CPU 飙升/内存增长；日志无 attach/reconnect/reinject/reload storm。
10. 关闭/停用/更新后无 Debugger/Native 残留。
11. PR 最终 head 的 CI、Store Package、Private Core Boundary 全绿。

只有 Stage 5 全部完成后才允许：

- 更新最终版本号/changelog；
- 合并 PR #187 到 `main`；
- 创建正式 Release。

## 当前状态记录

- [x] Stage 0：修复计划、owner 边界、验收标准
- [x] Stage 1：P0 代码修复与自动化护栏
- [ ] Stage 1：真实 Chrome disable/update 多窗口生命周期验收
- [x] Stage 2：per-tab 功能隔离实现与自动化
- [x] Stage 3：Master / background lifecycle 单一权威
- [x] Stage 4：旧 License 清理与 forbidden-token 自动化
- [x] Stage 5：当前 head `f08ae6b1` 全量 CI / Store / Boundary 全绿
- [ ] Stage 5：真机回归
- [ ] Stage 5：合并 + 正式发布

最后更新：2026-09-13。任何后续修复若引入第二个 Master writer、第二个 Work/Model state writer、第二个 background lifecycle cleanup owner，或通过多个互相兜底的条件分支共同决定同一终态，都视为架构回归，必须由测试阻止。
