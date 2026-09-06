# Windows ChatGPT 桌面客户端兼容路线 / Windows ChatGPT Desktop Compatibility Roadmap

> 状态 / Status: **规划中，尚未实现 / Planned, not implemented**
>
> 本文只定义未来版本的兼容目标、研究顺序、架构边界和发布门槛。当前 GPTWork 正式能力仍以浏览器中的 `chatgpt.com` 为主；不得把本文视为桌面客户端已受支持的声明。

## 1. 目标 / Goal

未来为 Windows 版 ChatGPT 桌面客户端新增 GPTWork 支持，使用户可以在浏览器版和桌面客户端之间复用同一套模型、推理强度和验证策略，而不需要理解不同宿主环境的实现差异。

目标形态：

```text
                     +----------------------+
                     |   GPTWork Policy     |
                     | model / reasoning    |
                     +----------+-----------+
                                |
                  +-------------+-------------+
                  |                           |
        +---------v----------+      +---------v----------+
        | Browser Adapter    |      | Desktop Adapter    |
        | Chrome / Edge      |      | ChatGPT Windows    |
        +---------+----------+      +---------+----------+
                  |                           |
                  +-------------+-------------+
                                |
                     +----------v-----------+
                     | Evidence / Native    |
                     | Core / diagnostics   |
                     +----------------------+
```

浏览器 Adapter 与未来 Desktop Adapter 必须共享高层 Policy 和证据语义，但可以使用不同的宿主接入方式。

## 2. 当前支持边界 / Current Support Boundary

当前正式版 GPTWork 依赖浏览器扩展环境，包括内容脚本、浏览器调试接口、扩展存储与 Native Messaging。该架构适用于 Chrome / Chromium / Edge 中的 `https://chatgpt.com/*`。

当前状态：

| 场景 | 状态 |
| --- | --- |
| Chrome / Chromium 打开 chatgpt.com | 已支持 |
| Edge 打开 chatgpt.com | 已支持 |
| Windows ChatGPT 桌面客户端主 Chat UI | 尚未支持 |
| Windows ChatGPT 桌面客户端 Work UI | 尚未支持 |
| Windows ChatGPT 桌面客户端 Codex UI | 尚未支持 |
| ChatGPT 桌面客户端内置浏览器中的普通网页 | 需要专项验证 |

在 Desktop Adapter 正式发布前，UI、官网和文档不得把 Windows ChatGPT 桌面客户端标记为“已支持”。

## 3. 核心设计原则 / Design Principles

1. **先观测，后干预**：第一阶段只研究、记录和验证，不修改桌面客户端请求。
2. **不猜 transport ID**：模型显示名、公开模型名和桌面客户端真实传输标识必须通过可重复证据建立映射，不凭命名规律硬编码。
3. **请求证据与响应证据分离**：页面/客户端选择只能作为辅助证据；“已确认模型”必须来自可信的正式请求或响应证据链。
4. **失败开放 / fail-open**：桌面 Adapter 掉线、调试能力失效、证据缺失或客户端升级后，不应永久锁死 ChatGPT 的正常发送能力。
5. **不使用全局网络劫持作为首选方案**：优先寻找桌面应用自身可稳定利用的调试、WebView、浏览器运行时或本地 IPC 接口。全局 HTTPS MITM、系统级代理、DLL 注入等高侵入方案不作为默认路线。
6. **不绕过 OpenAI 账户限制**：GPTWork 只管理和验证用户当前账户已经具备的能力，不创造模型权限、额度或区域资格。
7. **public/private 边界不回退**：公开仓库只记录高层兼容合同、UI、打包、诊断与非敏感适配边界；实现敏感的检测、关联和验证算法继续遵守 private core 边界。

## 4. 计划阶段 / Development Phases

### A0 — Desktop Recon / 只读探测

目标：确认 Windows ChatGPT 桌面客户端是否存在可稳定利用的官方或宿主级观测面。

必须完成的研究项：

- 进程结构与子进程生命周期；
- Chat、Work、Codex 是否共用同一网络/渲染运行时；
- 是否存在 WebView2、Chromium、CDP 或其他可观测调试入口；
- 正式聊天请求的端点、生命周期和流式响应形态；
- 请求中是否存在模型、推理强度、conversation/thread 等稳定字段；
- 响应中是否存在可用于确认实际模型的稳定元数据；
- 登录、更新、重启、多窗口情况下端点和进程是否稳定；
- ChatGPT 客户端更新后可观测接口是否容易漂移。

A0 只允许记录证据和诊断数据，不修改请求，不阻断发送。

**A0 通过条件**：至少找到一条无需全局 MITM、无需 DLL 注入、可重复获取正式聊天请求/响应证据的稳定路径。

**A0 停止条件**：如果只能通过高侵入、易破坏或不可维护的方式获得证据，则暂停 Desktop Adapter，不强行实现。

### A1 — Read-only Desktop Evidence Adapter / 只读证据适配器

在 A0 通过后建立最小 Desktop Adapter，只输出标准化证据，不做模型改写。

建议对外标准化事件：

```text
host = chatgpt_windows
surface = chat | work | codex
request_model = <canonical or unknown>
request_transport_model = <raw value or unknown>
request_reasoning = <value or unknown>
response_model = <canonical or unknown>
response_transport_model = <raw value or unknown>
evidence_source = <source>
correlation_id = <turn/request correlation>
```

该阶段必须验证：

- 同一轮请求与响应能可靠关联；
- 多会话、多窗口不会串证据；
- 客户端重启后状态可以恢复；
- 不会影响 ChatGPT 正常发送与流式显示。

### A2 — Shared Host Adapter Contract / 统一宿主适配合同

将浏览器版和桌面版统一到高层 Host Adapter 接口，而不是在 Policy Engine 中加入大量 `if desktop` 分支。

目标抽象：

```text
HostAdapter
  - detectHost()
  - observeSelection()
  - observeFormalRequest()
  - observeFormalResponse()
  - alignSelectionBestEffort()
  - lockFormalRequest()
  - health()
```

公开合同只定义字段、状态和错误语义，不公开内部检测算法。

### A3 — Best-effort Desktop Alignment / 桌面端尽力对齐

在只读证据稳定后，才允许尝试把桌面 UI 的当前模型/推理选择对齐到 GPTWork Policy。

要求：

- 失败只告警，不阻断正常聊天；
- 不通过脆弱坐标点击等方式作为唯一实现；
- 对 Chat、Work、Codex 分别验证；
- 模型不存在或账号尚未开放时必须明确显示“不可用”，不能伪装成已锁定。

### A4 — Formal Request Locking / 正式请求锁定

只有在 A1/A3 已稳定、请求结构足够可控后才实现真正的请求层锁定。

必须满足：

- 只作用于明确识别的正式聊天请求；
- 不干扰登录、同步、附件、语音、更新等非聊天流量；
- 只改写已知、已验证、当前账户可用的字段；
- transport 标识必须来自真实观测映射；
- Adapter 离线或请求结构未知时 fail-open；
- 严格模式的阻断必须是“当前请求级别”，旧证据不能污染后续会话。

### A5 — Response Verification & Release Candidate / 响应确认与候选发布

完成桌面端的双层确认：

1. Request locked / 正式请求已锁；
2. Response confirmed / 响应已确认。

桌面 UI 应与浏览器版共享统一状态语义：

```text
目标模型 / Target
请求模型 / Request
响应模型 / Response
证据状态 / Evidence state
Adapter 状态 / Adapter health
```

仅当响应证据满足可信度要求时显示“已确认”。

## 5. 测试矩阵 / Test Matrix

正式宣布支持前至少覆盖：

- Windows 10 与 Windows 11；
- ChatGPT 桌面客户端当前正式版及至少一次升级后的版本；
- Chat / Work / Codex 三种 surface；
- 单窗口、多窗口、多会话并发；
- GPT-6 Astra / GPT-5.6 Sol 等已授权模型；
- 账号未开放目标模型；
- 推理强度切换；
- 客户端重启、GPTWork 重启、Native Core 重启；
- 网络断开与恢复；
- Adapter 中途失联；
- 响应证据缺失；
- 客户端更新导致协议漂移；
- GPTWork 总开关关闭后必须立即停止干预；
- 卸载/禁用 GPTWork 后不得留下残余发送阻断。

## 6. 安全与回退 / Safety & Rollback

Desktop Adapter 必须具备独立 kill switch，并支持服务端或本地版本策略快速禁用某个不兼容的桌面客户端版本。

任何出现以下情况的版本不得进入正式发布：

- 无法可靠区分正式聊天请求与其他流量；
- 证据可能跨会话串联；
- 关闭 GPTWork 后仍存在残留干预；
- 客户端升级后会导致持续阻断；
- 必须依赖系统全局代理或证书注入才能正常运行；
- 不能提供明确 fail-open 路径。

## 7. 发布策略 / Release Strategy

桌面支持不得直接混入现有稳定版后自动启用。建议采用：

1. `A0 research`：开发者内部探测；
2. `desktop-evidence experimental`：只读证据实验版；
3. `desktop-adapter beta`：默认关闭，用户显式开启；
4. `desktop-adapter stable`：测试矩阵通过后再默认提供；
5. 旧浏览器 Adapter 始终保留独立开关和独立健康状态。

具体版本号在实际开发时再确定，本文不预定 `v0.5.x` 或 `v0.6.x`。

## 8. 完成定义 / Definition of Done

只有同时满足以下条件，GPTWork 才可以对外声明“支持 Windows ChatGPT 桌面客户端”：

- Desktop Adapter 能稳定识别 ChatGPT Windows 宿主；
- 能稳定关联正式请求和对应响应；
- 能锁定已授权目标模型/推理参数，或明确说明不可锁原因；
- 能取得足够可信的响应模型证据；
- Chat / Work / Codex 的已支持范围在 UI 中明确区分；
- 总开关关闭、Adapter 掉线、GPTWork 卸载都不会残留阻断；
- 通过 Windows 安装、升级、回滚和多窗口回归测试；
- 更新文档、诊断导出、状态 UI 和发布说明；
- CI 与发布边界检查全绿。

## 9. 当前结论 / Current Decision

现在先把 Windows ChatGPT Desktop 作为**正式路线但未排期实现**保存到仓库。

下一次开始该功能时，从 **A0 — Desktop Recon** 开始，不直接写请求改写代码。A0 的结果决定后续是进入 Desktop Adapter 开发，还是因可维护性/安全性不足而暂停。

---

## English Summary

Windows ChatGPT desktop support is a planned future GPTWork capability, not a currently supported feature. Development must start with a read-only A0 reconnaissance phase. GPTWork should reuse one high-level policy/evidence model across Browser Adapter and Desktop Adapter, but the desktop integration may use a different host mechanism. No production request locking is allowed until reliable, turn-scoped request/response evidence exists. The implementation must fail open, avoid global MITM/DLL injection as the default approach, preserve the public/private split, and pass a Windows-specific regression and rollback matrix before the product claims desktop support.
