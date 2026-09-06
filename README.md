# GPTWork

GPTWork 是面向 ChatGPT 官方网页聊天的模型与推理偏好管理工具，支持 Windows / Linux 上的 Chrome、Chromium 和 Edge。

当前正式版本：**0.5.28**。

## 用户可以做什么

- 保存常用模型与推理强度偏好；
- 在 ChatGPT 网页聊天中启用 GPTWork，并获得清晰的当前状态提示；
- 需要时运行自动验证和导出诊断信息；
- 使用 GPTWork 账户管理权益、设备和会话；
- 通过正式发布页获取 Windows、Linux 和扩展安装文件；
- 使用产品内更新能力保持客户端和服务端版本更新。

GPTWork 不使用 OpenAI API，也不会绕过 ChatGPT 套餐、额度、区域、账号或模型可用性限制。实际可使用的模型最终仍由 ChatGPT 平台和用户账户决定。

## 最短使用流程

1. 从正式 Release 或 GPTWork 官网下载对应平台版本；
2. 完成安装并启用浏览器扩展；
3. 登录 GPTWork 账户；
4. 在设置中选择首选模型与推理偏好；
5. 开启 GPTWork 后正常使用 ChatGPT；
6. 只有遇到异常时才使用自动验证、诊断或运行日志。

详细步骤见 [安装说明](docs/INSTALL.md) 和 [使用说明](docs/USAGE.md)。

## 未来兼容路线 / Compatibility roadmap

Windows 版 ChatGPT 桌面客户端支持已经列入正式路线，但**当前尚未实现，也不属于现有稳定版支持范围**。后续开发将从只读探测开始，在取得稳定、可重复的正式请求/响应证据后，再决定 Desktop Adapter 的锁定与验证实现。

完整方案、阶段计划、测试矩阵、回退原则和完成定义见 [Windows ChatGPT 桌面客户端兼容路线](docs/WINDOWS_CHATGPT_DESKTOP_ROADMAP.md)。

## 官网

- 产品首页：https://gptlock.mv3.cn/
- 使用教程：https://gptlock.mv3.cn/guide
- 正式版本：https://gptlock.mv3.cn/releases
- 账户中心：https://gptlock.mv3.cn/account

## 源码与发布边界

本仓库是 GPTWork 的**公开发行仓库**，用于官网、用户界面、安装/打包、发布元数据、兼容性接口和必要的客户端壳层。

GPTWork 正在迁移到 public/private split-source 架构。实现敏感的判断、验证、学习和特权运行逻辑不作为公共源码接口继续演进。当前树中仍存在一部分 v0.5.x 兼容构建所需的旧实现源码，它们已经冻结，只用于迁移期间维持现有安装与发布链路；后续由私有构建产物替代后会从当前公开树删除。

更多边界说明见 [PRIVATE_CORE_BOUNDARY.md](PRIVATE_CORE_BOUNDARY.md)。该文件只说明仓库职责，不公开内部实现方式。

## 开发贡献范围

公开仓库适合修改：

- 官网与账户界面；
- 安装与打包体验；
- 用户文档；
- 公共兼容性合同；
- 非敏感诊断与运维体验。

被冻结的旧核心路径由 CI 默认禁止继续增加实现逻辑。确有兼容性或安全修复需要时，应作为明确的维护例外处理，而不是在公开仓库继续开发新的核心能力。

## English

GPTWork manages model and reasoning preferences for official ChatGPT web chats on Windows and Linux. It provides a browser extension, account/device management, diagnostics, and signed/packaged release workflows without using the OpenAI API or bypassing ChatGPT account limits.

Windows ChatGPT desktop support is on the product roadmap but is not currently implemented or advertised as supported. Future work starts with read-only desktop reconnaissance and evidence validation before any request-locking behavior is considered. See `docs/WINDOWS_CHATGPT_DESKTOP_ROADMAP.md`.

This repository is the public distribution surface. Proprietary implementation-sensitive behavior is moving to a private core and is exposed to public components only through stable compatibility contracts and released artifacts. Legacy v0.5.x core source that remains here is frozen for migration compatibility and is not the location for new proprietary development.
