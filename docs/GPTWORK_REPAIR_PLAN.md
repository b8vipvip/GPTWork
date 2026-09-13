# GPTWork 修复开发计划

> 适用分支：`fix/complete-master-tab-authority`（PR #187）
>
> 原则：P0/P1 修复必须先通过自动化测试与真实 Chrome 生命周期回归；Stage 5 未完成前不合并 `main`、不发布正式版。

## 目标

本轮把运行时控制权收敛成清晰的三层：

1. **全局总开关（Master）**：只负责 GPTWork 整体启用/停用；关闭时所有窗口立即 fail-open、停止网络调试/本地核心/轮询，不再修改 ChatGPT 行为。
2. **窗口级功能状态（Window Feature State）**：Work 模式与模型锁按 Chrome `windowId` 隔离，同一窗口内的 ChatGPT 标签页共享状态，不同窗口互不影响。
3. **账号权益/并发窗口额度（Entitlement/Quota）**：只决定窗口是否允许启用功能，不再与旧产品授权码系统混用。

## 问题与当前收敛状态

| ID | 优先级 | 问题 | 当前状态 | 最终完成标准 |
| --- | --- | --- | --- | --- |
| R1 | P0 | 停用扩展或自动更新后 Chrome 多窗口卡死/崩溃 | **代码与自动化防线已完成，真机回归待 Stage 5**。已取消普通 SW 唤醒的全浏览器恢复注入、串行化全 tab debugger 配置、增加 terminal lifecycle supervisor、Master OFF 后统一停止后台运行时 | 多窗口、多标签页下停用/启用/更新/重载均不假死，无 CPU/内存重试风暴、重复注入、Debugger/Native 残留 |
| R2 | P0 | Debugger attach 并发竞态 | **已实现并通过自动化测试**。同一 tab attach/detach 使用 single-flight，并互相等待进行中的对向操作 | 同一 tab 任意时刻最多一个 attach/detach 生命周期，导航/关闭/Master OFF 清理完整 |
| R3 | P0 | content runtime 恢复策略过于激进 | **已实现并通过自动化测试**。仅 install/update 执行受控恢复；逐 tab 串行、二次探测、Master/URL/loading 再确认 | 普通 SW 唤醒不批量重注入，真正 install/update 才恢复且无并发风暴 |
| R4 | P0 | 旧 runtime terminal invalidation 不完整 | **已实现并通过自动化测试，真机回归待 Stage 5**。上一 generation 会清 Timer/Interval/RAF/Observer/EventListener；同步异常、Promise rejection、callback `runtime.lastError` 的真实 context invalidation 都触发单向 shutdown；`Receiving end does not exist` 保持非 terminal | 上下文失效后旧 runtime 永久停止重连/轮询/阻断/DOM 对齐，不再形成旧 generation 重试风暴 |
| R5 | P1 | Work/模型锁必须按窗口隔离 | **已实现并通过自动化测试**。权威状态按 `windowId` 存储；同窗口共享、跨窗口独立，tab 移动后重新绑定目标窗口，窗口关闭清理 | 两窗口各多标签互不影响，tab 跨窗口移动立即采用目标窗口状态 |
| R6 | P1 | Master 职责不纯、关闭语义不完整 | **已实现并通过自动化测试**。不再 monkey patch Chrome API；Native、alarms、Debugger、badge、content shutdown 均由显式 Master 生命周期控制 | Master OFF 即时停工/fail-open，生命周期清理 listener 永远有效，ON/OFF 全窗口一致 |
| R7 | P1 | Master 与窗口功能状态耦合错误 | **已实现并通过自动化测试**。Master 与 window Work/Model Lock 分离；设置页 Master 只有 `master-ui-controller.js` 一个写入方 | Master=OFF 一票否决；Master=ON 时由各窗口 feature state 决定功能，不再以 tab 功能状态冒充全局关闭 |
| R8 | P1 | 旧授权码/产品 License 体系残留 | **已清理并由 forbidden-token 测试保护**。删除 `native-status.js`、设置迁移、popup/CSS 等真实运行时残留；账号登录/订阅权益/窗口额度保留 | 生产扩展/UI/迁移不再存在旧产品授权码激活、校验、清除、旧 storage/message 逻辑 |
| R9 | P1 | `Unexpected token 'import'` 注入路径 | **已闭环并通过自动化测试**。动态 recovery 列表与 manifest classic content scripts 同源，测试逐文件禁止顶层 `import/export` | `executeScript({files})` 只注入 classic-safe 文件，module 仅通过 module graph 加载 |
| R10 | P1 | CI 必须全绿 | **Extension checks 已在 CI #701 通过**；最终 head 仍需等待全部 Windows/Linux/Native/Private Engine/Store/Boundary 检查完成 | PR 最终 head 的全部必需 GitHub Actions 为绿色 |
| R11 | P2 | 命名/描述可能误导为 tab-level authority | **代码注释与主要回归测试已明确 window authority**。`tab-feature-runtime.js` 文件名及 `GPTWORK_TAB_FEATURE_*` 消息名暂保留为兼容表面，不代表 tab 级存储语义；PR 最终描述在 Stage 5 收尾 | PR 描述、计划、测试语义明确 window-level；兼容命名有明确说明，不再被理解为 tab authority |

## 分阶段实施

### Stage 0 — 基线、问题清单和测试护栏

状态：**完成**

- 本文件作为单一修复清单。
- R1–R11 均有优先级、风险、完成标准和测试入口。
- 建立最终多窗口/多标签/停用/更新回归矩阵。

### Stage 1 — P0：停用/更新卡死与 Debugger 生命周期

状态：**代码与自动化完成；真实 Chrome 生命周期验收待 Stage 5**

已完成：

- `network-monitor.js` attach/detach single-flight。
- `content-runtime-recovery.js` 仅在真实 install/update 进行受控逐 tab 恢复。
- 普通 service worker 唤醒不再全量重注入 content bundle。
- recovery 注入前双探测，并重新检查 Master、URL、tab loading 状态。
- `content-runtime-lifecycle.js` 为 content generation 建立 terminal shutdown，清 Timer/Interval/RAF/MutationObserver/EventListener。
- `sendMessage` 同步 invalidation、Promise 异步 rejection、callback `runtime.lastError` 的 terminal invalidation 都立即 shutdown；普通 `Receiving end does not exist` 不误判为 terminal。
- dynamic injection 与 manifest classic content script 列表绑定，并有 module/classic 防回归测试。
- `background.js` Native/reconnect/account heartbeat/Debugger 全部显式 Master-gated；全 tab debugger 配置串行化；initialize single-flight。

待验收：真实 Chrome 多窗口下 disable/re-enable/update/reload 的 P0 人工矩阵。

### Stage 2 — P1：真正的窗口级功能隔离

状态：**实现与自动化完成**

已完成：

- 权威状态使用 `gptworkWindowFeatureStatesV1`，按 `windowId` 持久化。
- legacy tab session state 一次性迁移到 window state。
- 同窗口 ChatGPT tab 共享 Work/Model Lock；不同窗口相互独立。
- tab attach/update/跨窗口移动后重新解析目标 `windowId`。
- `windows.onRemoved` 清理对应窗口 session 状态。
- Debugger、请求策略、Native verification 使用 sender tab 解析出的 window effective policy。
- 兼容保留 `GPTWORK_TAB_FEATURE_GET/SET` 消息名和 `tab-feature-runtime.js` 文件名，但仅作为协议/文件兼容层，内部 authority 为 window-scoped。

### Stage 3 — P1：总开关单一权威

状态：**实现与自动化完成**

已完成：

- `master-runtime-safety.js` 不再 monkey patch `connectNative`、alarms、window listener 等 Chrome API。
- Master OFF：断开 Native Port、拒绝 pending request、清 reconnect/account alarms、逐 tab detach debugger、清 badge，并通知 content fail-open。
- Native connect/send/reconnect 与 account heartbeat 都有 Master 显式门控。
- 生命周期 listener 在 Master OFF 时仍保留，可继续完成 tab/window 清理。
- `master-ui-controller.js` 为 Master UI 唯一写入方；旧 `options.js -> patchSettings({enabled})` 双写路径已删除。
- Master 与 window feature authority 分离。

### Stage 4 — P1：旧授权码体系彻底移除

状态：**实现与自动化完成**

已完成：

- 清理生产扩展中的旧产品 License UI/message/storage/migration 路径。
- 删除 `native-status.js` 中旧授权 UI/runtime message monkey patch。
- 删除 settings migration 与 popup/CSS 的旧授权残留。
- 保留账号登录、订阅 entitlement、并发窗口额度，不与旧授权码体系混用。
- `product-license-removal` forbidden-token 扫描覆盖生产代码，旧标识重新出现会导致 CI 失败。

### Stage 5 — 全量回归、CI、合并与正式发布

状态：**进行中**

自动化状态：

- Extension checks：已通过 CI #701。
- Private Core Boundary：最新同 head 检查已通过。
- Store Package 与 CI 内 Windows/Linux/Native/Private Engine 构建：等待最终 head 全部完成后确认。

真实 Chrome 人工回归矩阵至少包括：

1. Chrome 1/2/5 个窗口，每窗口 1/5/20 个 ChatGPT 标签页。
2. Master ON/OFF 快速切换。
3. 窗口 A Work ON、窗口 B OFF；模型锁状态分别组合。
4. 将 ChatGPT tab 从 A 拖到 B，再拖回。
5. 在 `chrome://extensions` 直接停用 GPTWork，再启用。
6. 扩展自动更新/手动 reload，所有原有 Chrome 窗口保持响应。
7. 更新过程中正在生成回答、空闲页面、后台页面三种状态。
8. 检查任务管理器：无持续 CPU 飙升、无内存持续上涨；日志无 attach/reconnect/reinject storm。
9. 检查 debugger/native：关闭/停用/更新后无残留 attach、无 Native reconnect storm。
10. PR 最终 head 全部 GitHub Actions 绿灯。

只有 Stage 5 全部完成后才允许：

- 更新 PR #187 最终描述与验收结果；
- 合并到 `main`；
- 更新正式版本号和 changelog；
- 创建正式 Release。

## 当前状态记录

- [x] Stage 0：修复计划和验收标准
- [x] Stage 1：P0 代码修复与自动化护栏
- [ ] Stage 1：真实 Chrome disable/update 多窗口生命周期验收
- [x] Stage 2：windowId 窗口级隔离实现与自动化
- [x] Stage 3：Master 单一权威实现与自动化
- [x] Stage 4：旧授权码体系清理与 forbidden-token 自动化
- [ ] Stage 5：最终全量 CI + 真机回归 + 合并 + 正式发布

最后更新：2026-09-13。每个阶段必须以仓库中的实际实现、自动化结果和验收证据为准，不能只在 PR 评论中口头声明完成。
