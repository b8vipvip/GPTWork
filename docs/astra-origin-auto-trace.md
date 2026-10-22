# GPTWork Astra 原生模型来源自动追踪（v0.5.241）

此工具在 GPTWork Master 开启、当前 ChatGPT 标签页功能启用时自动运行。它**只观察**，不会点击原生模型菜单、修改页面模型或改写 ChatGPT 的会话详情响应。

## 自动采集的两种状态

- `scene=astra`：页面原生输入框显示 `gpt-6-astra`。
- `scene=non_astra`：页面原生输入框显示另一个具体模型。
- `scene=unknown`：页面还没完成渲染，或当前模型证据不足；不能把它算作非 Astra。

首次观察到 Astra 时，客户端会把**当前会话 ID**加入本地监测清单（最多 24 个，30 天有效）。此后刷新同一个会话会在页面加载阶段尽早启用 CDP Network；用户无需复现新窗口。当前前台的其他聊天也会自动捕获对照数据。切换到后台的普通非 Astra 聊天会停止额外的 Network 采集，以限制浏览器开销。Astra 会话仍保持自动监测。

## 日志事件（组件 `astra-origin-trace`）

| 事件 | 说明 |
| --- | --- |
| `astra_origin_navigation_started` | 刷新/加载开始，记录上一页面模型 |
| `astra_origin_document_lifecycle` | document_start、DOMContentLoaded、pageshow、load 及页面时钟 |
| `astra_origin_model_snapshot` | 首次模型、Astra/非 Astra/未知转换、Picker A 选择状态、输入框控件证据 |
| `astra_origin_conversation_watch_saved` | Astra 会话已加入本地自动追踪 |
| `astra_origin_capture_arm_result` | CDP 是否启用及失败状态 |
| `astra_origin_conversation_hydration` | GET 会话详情请求、HTTP 状态、耗时及允许列出的模型元数据 |
| `astra_origin_conversation_request` | 实际请求模型与当时页面模型 |
| `astra_origin_conversation_protocol` | POST HTTP 响应状态、MIME、流完成/失败、请求 ID |
| `astra_origin_served_model_evidence` | 真实响应元数据中是否有可用模型字段 |

与已有的 `request_lock_checked`、`formal_conversation_request_detected`、`conversation_response_metadata_observed` 一起按 `tabId`、`contextKey`、`requestId` 对齐。

**解释边界**：会话详情里的 `default_model_slug` 或最后一个消息的 `model_slug` 只能证明历史/恢复状态，不能独立证明最新请求最终使用了哪个推理模型。只有实际响应中的权威模型元数据才可用于已服务模型验证。

## 隐私和性能

- 仅解析允许列出的模型标识符；不记录对话正文、提示词、Cookies、Authorization、响应原始头或原始 SSE 内容。
- 会话详情的 JSON 只在内存中读取并立即丢弃；响应超过 2 MiB 不解析，模型字段长度也有限制。
- 不在所有后台 ChatGPT 标签页长期开启完整 Network 采集；仅当前前台会话和已观察到 Astra 的会话自动启用。
- 只记录事件变化而非每次 DOM Mutation；不会改变原有模型锁定或模型发现的决策权限。

## 实机验证

1. 更新到 v0.5.241 并确认 Master 已启用。
2. 打开已知能原生显示 Astra 的聊天，等待 `astra_origin_model_snapshot` 中 `scene=astra` 与 `astra_origin_conversation_watch_saved`。
3. 刷新相同聊天，确认 `astra_origin_navigation_started`、`astra_origin_document_lifecycle`、`astra_origin_conversation_hydration` 和最终 `astra_origin_model_snapshot` 的顺序。
4. 在另一个普通聊天中观察 `scene=non_astra`，对比模型来源、会话详情字段和响应协议。
5. 发送一条简短请求后导出运行时 JSONL，核对 `astra_origin_conversation_request`、`astra_origin_conversation_protocol`、`astra_origin_served_model_evidence`。

**注意**：CDP 可能在浏览器导航时短暂断开；如果初次刷新太快导致 GET 会话详情漏采，日志会显示页面生命周期但没有对应 GET 事件。下次刷新会再次自动尝试；不要把缺失网络事件当成不存在该请求。
