# 架构说明 / Architecture

GPTWork 对外只维护高层组件边界，不公开内部判断、识别、验证、学习或关联算法。

## 公开架构

GPTWork 由三类对用户可见的组件组成：

1. **宿主适配端**：当前由浏览器端提供设置、状态、账户入口和 ChatGPT 网页集成；未来计划增加 Windows ChatGPT Desktop Adapter，使浏览器和桌面客户端共享同一套高层 Policy / Evidence 语义。
2. **本地组件**：提供需要更高可信度或系统权限的本地能力，并通过版本化接口与宿主适配端通信。
3. **GPTWork 服务端**：提供账户、权益、设备、版本、官网和管理能力。

公开组件之间只依赖稳定接口。实现敏感的核心行为在私有实现中开发，以发布构建产物形式交付，不在本仓库文档中描述其内部规则。

### Host Adapter 边界

当前稳定 Host Adapter 是 Chrome / Chromium / Edge 中的 ChatGPT 网页集成。Windows ChatGPT 桌面客户端属于未来兼容路线，尚未实现。

未来 Desktop Adapter 的原则是：复用统一的模型/推理 Policy、请求/响应 Evidence 和 Guard 状态语义，但允许针对不同宿主使用不同的观测和接入方式。桌面路线必须从只读探测开始，先证明存在稳定、可重复的正式请求/响应证据，再进入请求锁定开发；不能仅因为桌面客户端包含网页或浏览器技术就假定现有扩展可以直接复用。

详细路线见 `docs/WINDOWS_CHATGPT_DESKTOP_ROADMAP.md`。

## public/private split

本仓库负责公开发行层：官网、用户界面、安装打包、发布元数据、公共兼容性合同和必要客户端壳层。

新的核心实现不再直接写入公开源码。当前仍保留的 v0.5.x 旧核心源码属于迁移兼容基线，冻结后只允许删除或进行明确批准的兼容/安全维护。

公共壳层与核心之间的兼容接口见 `contracts/core-bridge.schema.json`。该合同只约定消息边界，不定义内部算法。

更多说明见仓库根目录 `PRIVATE_CORE_BOUNDARY.md`。

## English

GPTWork publicly documents only its high-level component boundaries: host adapters, a local component, and GPTWork account/release services. The current stable host adapter targets ChatGPT web in Chrome/Chromium/Edge. Windows ChatGPT desktop support is a planned future adapter and is not yet implemented. Browser and desktop hosts should share high-level policy/evidence semantics while using host-specific integration mechanisms. Desktop development must begin with read-only evidence reconnaissance before any request-locking implementation.

Proprietary detection, decision, verification, learning, and correlation algorithms are private implementation details. The public repository carries distribution/UI code, packaging, public contracts, and legacy migration compatibility only.
