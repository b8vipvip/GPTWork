# Windows 代码签名 / Windows Code Signing

GPTWork 的 Windows 一键更新会先验证 GitHub Release 元数据中公布的 SHA-256，再由本地 Core 启动安装器。浏览器下载的 EXE 会附带 Mark-of-the-Web（`Zone.Identifier`）；从 v0.5.6 起，一键更新仅在 SHA-256 完全匹配后移除该下载标记，以避免已经由 GPTWork 自身验证的后台更新被 Attachment Manager / SmartScreen 的交互提示阻塞。

手工从浏览器下载并双击 `GPTWorkSetup-x64.exe` 时，Windows 是否显示“未知发布者”或“Windows 已保护你的电脑”主要取决于 Authenticode 签名和 Microsoft SmartScreen 声誉。SHA-256 校验不能替代发布者签名，也不应通过修改下载标记、关闭 SmartScreen 或引导用户绕过安全功能来解决公开下载的信任问题。

## 公开发行的推荐方案

公开分发的每一个 Windows EXE（安装器以及安装器内的可执行文件）都应使用同一受 Windows 信任的发布者身份进行 Authenticode SHA-256 签名并加 RFC3161 时间戳。可使用受信任 CA 签发的 OV/EV Code Signing 证书；如果部署条件允许，也可以使用 Microsoft Artifact Signing（原 Trusted Signing）等托管签名服务。

有效签名会让 Windows 显示可验证的发布者，并允许发布者声誉跨版本积累，但不能保证一个新应用或新证书在第一次下载时立即没有 SmartScreen 提示。Microsoft 目前不再让 EV 证书自动绕过 SmartScreen；若必须最大程度避免下载/运行警告，Microsoft Store 分发是更可靠的路径。

签名发布时必须保持以下原则：

- 所有正式版本使用稳定、连续的同一发布者身份；不要频繁更换证书主体。
- 安装器、`gptwork-core.exe` 和 `gptwork-engine.exe` 均签名；不要只签最外层 Setup。
- 签名完成后不要再改写、重新打包或二次修改 EXE，否则签名可能失效。
- Release 页面、下载域名、安装器元数据和证书发布者名称保持长期一致。
- 自签名证书仅适合开发/内部测试，不能替代公开受信任的 Authenticode 证书。

## 本地验证

发布前以及从正式下载地址重新下载后，都应验证“用户实际拿到的那一份”二进制：

```powershell
Get-AuthenticodeSignature .\GPTWorkSetup-x64.exe | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

正式发布应看到 `Status : Valid`。同时建议使用 Windows SDK 的 SignTool 做第二次校验：

```powershell
signtool verify /pa /all /v .\GPTWorkSetup-x64.exe
```

## 首次引导升级 / Bootstrap Upgrade

`v0.5.5` 及更早版本的本地 Core 本身不具备“SHA-256 校验后解除 Mark-of-the-Web”的能力，因此旧 Core 无法通过发布一个新版本来被追溯修复。也就是说，从 `v0.5.5`（或更早）第一次跨到 `v0.5.6+` 时，如果 Windows 对未签名安装器触发 SmartScreen，必须完成一次人工确认/安装；或者使用公开受信任的 Authenticode 签名安装包。

从 `v0.5.6` Core 起，安全一键更新基线已经建立：安装器先匹配 GitHub Release 的精确 SHA-256，再移除该已验证下载文件的 `Zone.Identifier`，之后才启动静默安装。扩展也会检查本地 Core 版本；低于 `0.5.6` 时不会再错误触发旧的一键更新链路，而是引导到发布页完成一次性 bootstrap。

## GitHub Actions Secrets

当前 Release 工作流已支持 PFX/P12 Authenticode 签名。为正式 Windows 发布配置以下仓库 Secrets：

- `GPTLOCK_CODESIGN_PFX_BASE64`：代码签名 PFX/P12 文件的 Base64 内容。
- `GPTLOCK_CODESIGN_PFX_PASSWORD`：PFX 密码。
- `GPTLOCK_CODESIGN_TIMESTAMP_URL`：可选 RFC3161 时间戳地址；为空时使用 `http://timestamp.digicert.com`。

当 `GPTLOCK_CODESIGN_PFX_BASE64` 未配置时，Release 仍会正常构建，但 Windows Setup 会保持未签名状态并在日志中给出警告。因此，准备面向普通用户正式推广之前，应先完成受信任证书/签名服务配置，并用上面的命令验证从正式下载域名重新下载的 EXE。

当证书配置存在时，Release 会：

1. 构建 `gptwork-core.exe`；
2. 对 `gptwork-core.exe` 执行 SHA-256 Authenticode 签名并校验 `Get-AuthenticodeSignature` 为 `Valid`；
3. 对私有引擎 `gptwork-engine.exe`（存在时）执行相同签名；
4. 使用已签名的内部二进制构建 Inno Setup；
5. 对 `GPTWorkSetup-x64.exe` 再次签名并验证；
6. 删除 Runner 上的临时 PFX 文件；
7. 仅在上述步骤全部成功后上传该工作流产出的正式安装器。

不要把 PFX 文件、密码或 Base64 内容提交到仓库。若改用 Microsoft Artifact Signing，应将签名凭据保存在 GitHub Actions Secrets/OIDC 配置中，并继续保持“先签内部 EXE，再构建并签外层 Setup，最后验证实际发布文件”的顺序。
