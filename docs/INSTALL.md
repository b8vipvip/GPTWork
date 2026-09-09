# 安装 GPTWork / Installation

GPTWork 支持 Windows 与 Linux，推荐始终从 GPTWork 官网或 GitHub 正式 Release 获取安装文件。官网正式版本列表只展示用户实际需要安装的系统安装包；扩展 ZIP、校验文件和内部组件包不作为普通用户的独立下载入口。

## Windows

1. 下载最新 `GPTWorkSetup-x64.exe`；
2. 运行安装程序完成安装；安装器已经包含与该版本配套的 GPTWork 浏览器扩展文件，因此普通用户不需要再单独下载 `GPTWork-extension-*.zip`；
3. 按安装提示在 Chrome / Edge 中启用安装器部署到 GPTWork 安装目录的浏览器扩展；当前安装器会部署扩展文件并注册 Native Messaging，但不会绕过浏览器安全确认静默启用扩展；
4. 完全重启 Chrome / Edge；
5. 打开 GPTWork，确认状态正常后登录账户并完成设置。

如果升级后出现旧界面、组件离线或版本不一致，优先重新运行最新安装器或使用产品内修复/更新入口。

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

Download GPTWork only from the official product site or GitHub Releases. The Windows Setup already bundles the matching browser-extension files, so ordinary users do not need a separate extension ZIP. The installer deploys those files and registers Native Messaging, but the browser may still require the user to enable/confirm the extension. Restart the browser completely, then sign in and configure GPTWork.
