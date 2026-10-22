# GPTWork v0.5.242 · 调试工具与 Astra 单次请求实验

打开 GPTWork 插件弹窗，点击 **调试工具**，进入独立工具页。

## 内置工具

**直接使用 `gpt-6-astra-wm` 请求**：选择目标 ChatGPT 标签页，点击“发送单次 Astra 测试请求”。此操作会真实发送固定测试消息“计算 12×13，只输出整数。”到该标签页当前会话，可能消耗账户额度。页面需要已登录 ChatGPT，且 GPTWork 主开关、账户授权和该标签页的功能处于启用状态。

1. 只在这一次请求的正式 `POST /backend-api/conversation` 或 `POST /backend-api/f/conversation` 中尝试将顶层 `model` 改为 `gpt-6-astra-wm`。保留原请求的会话上下文、消息内容、推理强度及其他字段。
2. 使用已有的 CDP Fetch 拦截；**绝不**通过伪造账户授权、Cookie、认证头或绕过 ChatGPT 账户限制来发送。
3. 只有 `Fetch.continueRequest` 成功且转发模型与 `gpt-6-astra-wm` 完全一致时，才记为“已确认转发”。如果请求模型字段缺失、改写失败或目标不一致，调试请求失败关闭，不把普通模型请求冒充 Astra 请求。
4. 自动采集真实 HTTP 状态、流完成/失败事件和允许列出的响应模型元数据。HTTP 200 仅表示传输成功，**不是** Astra 模型证明。
5. 调试结束不会永久改变模型锁定、原生 Picker A 或模型发现策略；仅单次发送拥有临时改写权限。自动等待上限为 180 秒。若流式请求超过这个期限，标记“超时”，而不是错误地宣布模型验证成功。

### 运行时日志

组件：`astra-direct-debug`

- `astra_debug_probe_started`
- `astra_debug_request_forwarded` / `astra_debug_request_rejected`
- `astra_debug_probe_send_attempt` / `astra_debug_probe_dispatch_failed`
- `astra_debug_response_protocol`
- `astra_debug_response_model_evidence`
- `astra_debug_probe_timeout` / `astra_debug_probe_canceled` / `astra_debug_probe_debugger_detached`

按 `tabId`、`requestId`、`fetchRequestId`、`contextKey` 关联；不记录测试提示词正文、历史 ChatGPT 对话正文、Cookie、Authorization、完整响应体；只保存本次固定测试消息产生的新助手回复的最多 300 字片段。调试工具页可导出最近 20 条本地摘要 JSON；完整时间线请使用原有运行时 JSONL。

结果的三个独立维度：`requestAccepted`（是否实际转发该模型）、`requestOutcome`（HTTP/网络流终态）、`modelVerdict`（权威响应字段确认 Astra / 其他模型 / 未验证）。

## 自动追踪工具

`astra-origin-trace` 无需额外启动，参见 [原生 Astra 来源追踪](astra-origin-auto-trace.md)。

## Windows 本地诊断工具

工具页列出仓库 `tools/windows` 下的 5 个原始脚本，支持打开 GitHub 源码查看/下载。Chrome 扩展**不具备**直接运行 PowerShell / BAT 脚本的权限，必须由用户在本地按需执行。

- `Analyze-GPTWork-Jank.ps1`
- `GPTWork-Jank-Diagnostic.ps1`
- `Run-GPTWork-Jank-Analyzer.bat`
- `Run-GPTWork-Jank-Diagnostic.bat`
- `Run-GPTWork-Jank-ETW-Diagnostic.bat`

## 实机验证边界

自动化测试验证的是改写器、状态关联、工具入口及权限边界。是否被真实 ChatGPT 服务端接受、是否产生 Astra 服务模型证据，**必须由用户安装正式版并执行真实请求后从日志判定**；不能由本地单元测试推断。
