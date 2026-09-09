[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = 'bhchcpeodphgjfjoookncemnamdbfcof',

    [Parameter(Mandatory = $false)]
    [string]$ChromeStoreExtensionId = '',

    [Parameter(Mandatory = $false)]
    [string]$EdgeStoreExtensionId = '',

    [Parameter(Mandatory = $false)]
    [string]$BinaryPath = '',

    [Parameter(Mandatory = $false)]
    [string]$InstallRoot = '',

    [Parameter(Mandatory = $false)]
    [ValidateSet('All', 'Chrome', 'Edge')]
    [string]$Browser = 'All'
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path (Join-Path $scriptDirectory '..\..')).Path

foreach ($candidate in @($ChromeStoreExtensionId, $EdgeStoreExtensionId)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -notmatch '^[a-p]{32}$') {
        throw "商店扩展 ID 无效 / Invalid store extension id: $candidate"
    }
}

if ([string]::IsNullOrWhiteSpace($BinaryPath)) {
    $BinaryPath = Join-Path $repositoryRoot 'native-core\target\release\gptwork-core.exe'
}
if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
    throw "找不到二进制文件 / Binary not found: $BinaryPath`n请先运行 / Build first: cargo build --release --manifest-path native-core/Cargo.toml"
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'GPTWork'
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

$installDirectory = Join-Path $InstallRoot 'bin'
$manifestDirectory = Join-Path $InstallRoot 'native-messaging'
$extensionDirectory = Join-Path $InstallRoot 'extension'
$toolsDirectory = Join-Path $InstallRoot 'tools'
$extensionSource = Join-Path $repositoryRoot 'extension'
$installedBinary = Join-Path $installDirectory 'gptwork-core.exe'
New-Item -ItemType Directory -Force -Path $installDirectory, $manifestDirectory, $extensionDirectory, $toolsDirectory | Out-Null

function Copy-FileIfDifferent {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $sourcePath = (Resolve-Path -LiteralPath $Source).Path
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    if (-not $sourcePath.Equals($destinationPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    }
}

function Get-AllowedOrigins {
    param([string]$StoreExtensionId = '')

    $ids = New-Object System.Collections.Generic.List[string]
    $ids.Add($ExtensionId)
    if (-not [string]::IsNullOrWhiteSpace($StoreExtensionId) -and $StoreExtensionId -ne $ExtensionId) {
        $ids.Add($StoreExtensionId)
    }
    return @($ids | ForEach-Object { "chrome-extension://$_/" })
}

Copy-FileIfDifferent -Source $BinaryPath -Destination $installedBinary
$runtimeFiles = Get-ChildItem -LiteralPath $extensionSource -File | Where-Object {
    $_.Name -eq 'manifest.json' -or $_.Extension -in @('.js', '.css', '.html')
}
foreach ($file in $runtimeFiles) {
    Copy-FileIfDifferent -Source $file.FullName -Destination (Join-Path $extensionDirectory $file.Name)
}
$installedRepair = Join-Path $toolsDirectory 'Repair-GPTWork.ps1'
Copy-FileIfDifferent -Source (Join-Path $scriptDirectory 'Repair-GPTWork.ps1') -Destination $installedRepair
Copy-FileIfDifferent -Source (Join-Path $scriptDirectory 'Update-GPTWork.ps1') -Destination (Join-Path $toolsDirectory 'Update-GPTWork.ps1')

function Install-NativeManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][string[]]$AllowedOrigins
    )

    $manifestPath = Join-Path $manifestDirectory "$Name.json"
    $manifest = [ordered]@{
        name = 'com.gptlock.core'
        description = 'GPTWork 本地验证核心 / GPTWork Local Verification Core'
        path = $installedBinary
        type = 'stdio'
        allowed_origins = @($AllowedOrigins)
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 4
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8WithoutBom)
    New-Item -Path $RegistryPath -Force | Out-Null
    Set-Item -Path $RegistryPath -Value $manifestPath
}

if ($Browser -in @('All', 'Chrome')) {
    Install-NativeManifest -Name 'chrome' -RegistryPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.gptlock.core' -AllowedOrigins (Get-AllowedOrigins -StoreExtensionId $ChromeStoreExtensionId)
}
if ($Browser -in @('All', 'Edge')) {
    Install-NativeManifest -Name 'edge' -RegistryPath 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.gptlock.core' -AllowedOrigins (Get-AllowedOrigins -StoreExtensionId $EdgeStoreExtensionId)
}

& $installedRepair -ExtensionId $ExtensionId -ChromeStoreExtensionId $ChromeStoreExtensionId -EdgeStoreExtensionId $EdgeStoreExtensionId -Browser $Browser
if ($LASTEXITCODE -ne 0) {
    throw "Native Messaging 安装后验证失败 / post-install verification failed with exit code $LASTEXITCODE"
}

Write-Host 'GPTWork Windows Native Messaging 安装完成 / installation completed.' -ForegroundColor Green
Write-Host '请完全退出并重新启动 Chrome/Edge / Fully restart Chrome or Edge.'
Write-Host "扩展目录 / Extension directory: $extensionDirectory"
Write-Host "安装根目录 / Install root: $InstallRoot"
Write-Host "修复命令 / Repair command: powershell -NoProfile -ExecutionPolicy Bypass -File `"$installedRepair`""
Write-Host '本机 API 可按需启动 / Start the optional local API with:'
Write-Host "  `"$installedBinary`" serve"
