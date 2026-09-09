# GPTWork Chrome / Edge 商店分发链

本文件描述 GPTWork 的浏览器商店构建、Native Messaging 身份衔接和 Windows 安装器边界。

## 当前实现

GPTWork 现在具有独立的 `standalone` 与浏览器商店分发通道：

- `standalone`：继续使用 GitHub / GPTWork 官网发布的完整 Windows/Linux 安装包和现有扩展运行时。
- `chrome-store`：生成 Chrome Web Store 专用扩展包。
- `edge-store`：生成 Microsoft Edge Add-ons 专用扩展包。

商店包不会携带 GPTWork 私有 Native Core / Private Engine 源码，也不会携带独立版的扩展自更新后台模块。商店包的扩展本体由 Chrome Web Store / Microsoft Edge Add-ons 更新，GPTWork 不在商店版扩展内部下载并替换扩展本体。

## 构建商店包

在仓库根目录运行：

```bash
node packaging/store/build-store-package.mjs --browser chrome --out dist/store/chrome
node packaging/store/build-store-package.mjs --browser edge --out dist/store/edge
```

在对应商店创建草稿项目并取得正式 Extension ID 后，可以把 ID 写进构建结果：

```bash
node packaging/store/build-store-package.mjs \
  --browser chrome \
  --out dist/store/chrome \
  --extension-id <CHROME_STORE_EXTENSION_ID>

node packaging/store/build-store-package.mjs \
  --browser edge \
  --out dist/store/edge \
  --extension-id <EDGE_STORE_EXTENSION_ID>
```

GitHub Actions 的 `Store Package` 工作流会自动生成两个 ZIP。仓库变量可配置：

- `GPTWORK_CHROME_STORE_EXTENSION_ID`
- `GPTWORK_EDGE_STORE_EXTENSION_ID`

在正式 ID 尚未配置时，工作流仍可以生成用于创建商店草稿项目的首次 ZIP；取得商店 ID 后重新运行即可生成带正式商店链接元数据的包。

## 商店包与独立包的差异

商店构建会：

1. 移除独立版 Manifest 中固定的 `key`；
2. 移除 `downloads` 权限；
3. 使用 `background-entry-store.js`，不加载 `background-update.js`；
4. 设置页改用 `store-update-page.js`，扩展更新入口交给对应浏览器商店；
5. 保留 Native Messaging、本地状态、模型锁定和账户等现有运行能力；
6. 继续执行私有源码泄漏检查。

## Native Messaging 与两个正式商店 ID

Chrome Web Store 和 Microsoft Edge Add-ons 可能产生不同的 Extension ID。Windows Native Messaging 清单现在支持：

- 独立版 GPTWork 扩展 ID；
- Chrome Web Store 正式 ID；
- Edge Add-ons 正式 ID。

Windows Setup 编译时可以传入：

```text
/DChromeStoreExtensionId=<CHROME_STORE_EXTENSION_ID>
/DEdgeStoreExtensionId=<EDGE_STORE_EXTENSION_ID>
```

`Repair-GPTWork.ps1` 同样支持：

```powershell
-ChromeStoreExtensionId <CHROME_STORE_EXTENSION_ID>
-EdgeStoreExtensionId <EDGE_STORE_EXTENSION_ID>
```

这样正式商店扩展与独立版扩展都可以连接同一 GPTWork Native Core，同时不使用通配符 `allowed_origins`。

## Windows 安装器与浏览器安装确认

GPTWork Windows 安装器已经允许用户选择：

- 仅 Chrome；
- 仅 Edge；
- Chrome + Edge。

安装器可以自动部署 GPTWork、本地核心、Native Messaging 配置以及对应浏览器连接，但不会通过企业 `ExtensionInstallForcelist` 或修改浏览器安全设置来绕过普通用户的扩展确认。

Chrome 在 Windows 上的外部安装需要来自 Chrome Web Store，并保留浏览器侧的启用确认。Microsoft Edge 也支持通过官方 Add-ons/update URL 与 Windows 注册表进行外部分发，但机器级注册需要管理员权限。GPTWork 当前普通安装器仍是按用户安装，不为了静默安装扩展而把整套产品改成机器级强制安装。

因此正式商店发布后的目标体验是：安装器选择浏览器并配置 Native Core → 浏览器从官方商店安装/发现 GPTWork 扩展 → 用户仅完成浏览器自身要求的安全确认 → 重启浏览器即可使用。

## 发布前还需要的外部条件

代码侧商店构建链可以在没有账号凭据时完成，但真正提交审核仍需要在两个平台完成外部操作：

- Chrome Web Store Developer Dashboard 创建 GPTWork 草稿项目并取得正式 ID；
- Microsoft Edge Add-ons / Partner Center 创建 GPTWork 草稿项目并取得正式 ID；
- 将两个 ID 配置为 GitHub 仓库变量；
- 上传 CI 生成的对应 ZIP；
- 填写隐私、权限理由、测试说明、商店图片和审核账号；
- 审核通过后再把正式商店 URL 接到 Windows 安装流程与官网。

这些外部平台操作不会在代码中伪造，也不会把未审核的本地扩展冒充为正式商店扩展。
