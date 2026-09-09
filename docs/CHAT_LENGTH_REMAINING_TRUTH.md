# 聊天长度剩余可信显示 / Truthful Chat-Length Remaining Display

GPTWork 的“聊天长度剩余”必须优先服从 ChatGPT 页面实际状态，而不能把模型理论上下文窗口或被虚拟化后的局部 DOM 当作真实线程剩余额度。

规则：

1. 当前页面出现 ChatGPT 自身的“已达到此对话长度上限”系统提示时，立即显示 **0%**。
2. 硬上限提示允许由 `p`、`div`、`span` 或语义状态节点承载，但必须位于普通对话 turn 之外；用户/助手引用同一句话不得触发。
3. 如果无法取得完整 conversation tree、只能使用 `dom-fallback`，显示 **未知**，不再输出类似 96.8% 的伪精确百分比。
4. 只有取得完整活动分支或可信实测上界时，现有剩余百分比估算才继续显示。
5. GPTWork 自己的警告/Toast 不能作为 ChatGPT 硬上限证据。

The remaining-chat indicator must prefer the live ChatGPT product state over theoretical model context windows or partial virtualized DOM measurements. A visible ChatGPT hard-limit notice forces 0%; partial DOM-only measurements are rendered as unknown rather than a precise percentage.
