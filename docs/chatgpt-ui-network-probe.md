# ChatGPT 页面 / 请求模型探针

这个探针是**独立诊断脚本**，不修改 GPTWork 或 ModelPro 的运行逻辑。它用于一次性采集 ChatGPT 改版后的：

- 新聊天页 composer 结构；
- 当前页面模型相关 DOM / aria / data-testid；
- 模型选择器打开后的菜单层级和已选状态；
- 点击模型前后的 DOM 变化；
- `/backend-api/conversation` 与 `/backend-api/f/conversation` 的请求模型 / reasoning 相关字段；
- GPTWork 右下角状态框的可见文本。

为避免把聊天内容写入日志，网络请求只保存 model / default_model / resolved_model / reasoning / thinking / effort 相关字段与顶层字段名，不保存 messages 正文。

## 本地运行一次

1. 使用需要诊断的 GPTWork / ModelPro 环境打开 ChatGPT。
2. 打开一个**全新聊天**，先不要发送消息。
3. 按 `F12` → **Console / 控制台**。
4. 将 `tools/chatgpt-ui-network-probe.js` 的完整内容粘贴并回车。
5. 控制台看到 `GPTWork ChatGPT probe started` 后按下面顺序操作：
   - 保持新聊天页 2~3 秒；
   - 打开一次模型选择器；
   - 选择一个明确模型，例如 GPT-6 Astra；
   - 等 1~2 秒；
   - 发送一句短测试消息，例如 `探针测试`；
   - 等回复完成；
   - 如果当前环境有 Work 开关，再切换一次 Work 后发送第二句短测试消息。
6. 回到 Console，运行：

```js
__GPTWORK_CHATGPT_PROBE__.download()
```

浏览器会下载一个 `gptwork-chatgpt-probe-*.json` 文件。

## 可选标记

在关键动作前后可手工加标记：

```js
__GPTWORK_CHATGPT_PROBE__.mark('before-open-picker')
__GPTWORK_CHATGPT_PROBE__.mark('after-select-astra')
__GPTWORK_CHATGPT_PROBE__.mark('before-send')
```

结束探针并恢复被包装的 `fetch/XHR/history`：

```js
__GPTWORK_CHATGPT_PROBE__.stop()
```

停止后仍可继续执行 `.download()` 导出。

## 期望日志

请把下载得到的 JSON 原样发回。重点会分析：

- `snapshots[].composer / controls / popups / detectedModels`
- `network[].body.relevant`
- 点击模型前后的 `aria-expanded / aria-checked / aria-selected / data-state`
- 新聊天页是否在发送前已存在可识别模型证据
- 请求体原始 `model` 是否比 DOM 页面模型更稳定
- Work 开启后原始模型与最终 transport model 的关系

同一份探针结果可以同时用于改进 GPTWork 和 ModelPro，因为脚本直接观察 ChatGPT 页面和请求，不依赖两者内部实现。
