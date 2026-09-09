# 安装 GPTWork / Installation

GPTWork 支持 Windows 与 Linux，推荐始终从 GPTWork 官网或 GitHub 正式 Release 获取安装文件。官网正式版本列表只展示用户实际需要安装的系统安装包；扩展 ZIP、校验文件和内部组件包不作为普通用户的独立下载入口。

## Windows

1. 下载最新 `GPTWorkSetup-x64.exe`；
2. 运行安装程序。安装器已经包含与该版本配套的 GPTWork 浏览器扩展文件，普通用户不需要再单独下载 `GPTWork-extension-*.zip`；
3. 在“选择浏览器扩展”页面选择 `仅 Chrome`、`仅 Edge` 或 `Chrome + Edge`（默认）；
4. 安装器自动部署 GPTWork、本地核心和扩展文件，并只为所选浏览器注册 Native Messaging 连接；
5. 如果 Chrome / Edge 显示扩展安装或启用安全确认，请在浏览器自己的界面完成一次确认，然后完全重启所选浏览器；
6. 打开 GPTWork，确认状态正常后登录账户并完成设置。

升级时可以重新选择浏览器目标。例如从“Chrome + Edge”改为“仅 Chrome”后，安装器会清理 GPTWork 在 Edge 中的 Native Messaging 注册，不再把未选择的浏览器当作安装目标。

如果升级后出现旧界面、组件离线或版本不一致，优先重新运行最新安装器或使用产品内修复/更新入口。

## 为什么普通 Windows 不能由安装器直接静默启用扩展

Chrome / Edge 对普通终端用户保留浏览器侧的扩展安装/启用确认。GPTWork 安装器可以让用户先选择目标浏览器、自动部署扩展文件并完成 Native Messaging 注册，但不会通过企业强制安装策略或修改浏览器安全设置来绕过浏览器自己的确认界面。

Chrome Web Store / Microsoft Edge Add-ons 正式版本发布后，可以把安装器进一步接到浏览器官方商店分发链，减少用户手工定位扩展的步骤；普通用户最终是否需要一次浏览器确认仍由 Chrome / Edge 的安全策略决定。组织管理设备可以使用浏览器官方企业策略自动安装扩展，但该模式不作为 GPTWork 普通用户安装器的默认行为。

## Linux

1. 下载与你的平台对应的正式 `.deb`；
2. 使用系统包管理器安装；
3. 按安装提示启用浏览器扩展；
4. 完全重启浏览器；
5. 登录 GPTWork 并完成设置。

## 浏览器

当前面向 Chrome、Chromium 与 Edge。若浏览器提示扩展需要启用或重新加载，请完成浏览器要求的用户确认后完全退出并重新打开浏览器。GPTWork 不通过企业强制安装策略绕过普通用户的浏览器扩展安装确认。

## 下载来源

- 官网版本页：`https://gptlock.mv3.cn/releases`
- GitHub Releases：`https://github.com/b8vipvip/GPTWork/releases`

不要从无法确认来源的第三方站点下载 GPTWork 安装包。

## 校验

正式发布仍会在 GitHub Release 中提供 SHA-256 校验信息，但官网普通下载列表不再单独展示校验文件。对下载来源有疑问时，可以在 GitHub 正式 Release 中比对文件校验值。

## English

Download GPTWork only from the official product site or GitHub Releases. The Windows Setup bundles the matching browser-extension files. During setup, choose Chrome only, Edge only, or both (default). Setup deploys GPTWork and registers Native Messaging only for the selected browser targets. Chrome or Edge may still require one browser-owned install/enable confirmation; GPTWork does not bypass that security confirmation with enterprise force-install policy on ordinary consumer devices. Restart the selected browser completely, then sign in and configure GPTWork.
