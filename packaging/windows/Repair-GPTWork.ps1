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
    [ValidateSet('All', 'Chrome', 'Edge')]
    [string]$Browser = 'All'
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Split-Path -Parent $scriptDirectory
$binaryPath = Join-Path $installRoot 'bin\gptwork-core.exe'
$manifestDirectory = Join-Path $installRoot 'native-messaging'

foreach ($candidate in @($ChromeStoreExtensionId, $EdgeStoreExtensionId)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -notmatch '^[a-p]{32}$') {
        throw "商店扩展 ID 无效 / Invalid store extension id: $candidate"
    }
}

if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "本地核心不存在 / Local Core not found: $binaryPath"
}

New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null

function Get-AllowedOrigins {
    param([string]$StoreExtensionId = '')

    $ids = New-Object System.Collections.Generic.List[string]
    $ids.Add($ExtensionId)
    if (-not [string]::IsNullOrWhiteSpace($StoreExtensionId) -and $StoreExtensionId -ne $ExtensionId) {
        $ids.Add($StoreExtensionId)
    }
    return @($ids | ForEach-Object { "chrome-extension://$_/" })
}

function Read-ExactBytes {
    param(
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][byte[]]$Buffer,
        [Parameter(Mandatory = $true)][int]$Count
    )

    $offset = 0
    while ($offset -lt $Count) {
        $readTask = $Stream.ReadAsync($Buffer, $offset, $Count - $offset)
        if (-not $readTask.Wait(5000)) {
            throw 'Native Messaging 读取超时 / read timed out.'
        }
        $read = $readTask.Result
        if ($read -le 0) {
            throw '本地核心在返回完整消息前退出 / Local Core exited before returning a complete message.'
        }
        $offset += $read
    }
}

function Test-NativeMessagingRoundTrip {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $binaryPath
    $startInfo.Arguments = "chrome-extension://$ExtensionId/ --parent-window=0"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    try {
        if (-not $process.Start()) {
            throw '无法启动本地核心 / Could not start the Local Core.'
        }
        $started = $true

        $requestBytes = [System.Text.Encoding]::UTF8.GetBytes('{"id":"repair-ping","type":"ping"}')
        $lengthBytes = [System.BitConverter]::GetBytes([uint32]$requestBytes.Length)
        $inputStream = $process.StandardInput.BaseStream
        $inputStream.Write($lengthBytes, 0, $lengthBytes.Length)
        $inputStream.Write($requestBytes, 0, $requestBytes.Length)
        $inputStream.Flush()

        $outputStream = $process.StandardOutput.BaseStream
        $responseLengthBytes = New-Object byte[] 4
        Read-ExactBytes -Stream $outputStream -Buffer $responseLengthBytes -Count 4
        $responseLength = [System.BitConverter]::ToUInt32($responseLengthBytes, 0)
        if ($responseLength -eq 0 -or $responseLength -gt 1048576) {
            throw "Native Messaging 响应长度无效 / Invalid response length: $responseLength"
        }

        $responseBytes = New-Object byte[] ([int]$responseLength)
        Read-ExactBytes -Stream $outputStream -Buffer $responseBytes -Count ([int]$responseLength)
        $responseText = [System.Text.Encoding]::UTF8.GetString($responseBytes)
        $response = $responseText | ConvertFrom-Json
        if (-not $response.ok -or $response.id -ne 'repair-ping' -or $response.data.type -ne 'pong') {
            throw "Native Messaging ping 返回异常 / Unexpected ping response: $responseText"
        }

        $process.StandardInput.Close()
        if (-not $process.WaitForExit(5000)) {
            throw '本地核心未在输入关闭后退出 / Local Core did not exit after input closed.'
        }
        if ($process.ExitCode -ne 0) {
            $standardError = $process.StandardError.ReadToEnd()
            throw "本地核心退出码异常 / Local Core exited with $($process.ExitCode): $standardError"
        }
    }
    finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Repair-NativeManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][string[]]$AllowedOrigins
    )

    $manifestPath = Join-Path $manifestDirectory "$Name.json"
    $manifest = [ordered]@{
        name = 'com.gptlock.core'
        description = 'GPTWork 本地验证核心 / GPTWork Local Verification Core'
        path = $binaryPath
        type = 'stdio'
        allowed_origins = @($AllowedOrigins)
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 4
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8WithoutBom)
    New-Item -Path $RegistryPath -Force | Out-Null
    Set-Item -Path $RegistryPath -Value $manifestPath

    $registeredPath = (Get-Item -LiteralPath $RegistryPath).GetValue('')
    if ($registeredPath -ne $manifestPath) {
        throw "浏览器注册验证失败 / Browser registration check failed: $RegistryPath"
    }
    $savedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $savedOrigins = @($savedManifest.allowed_origins)
    if ($savedManifest.path -ne $binaryPath -or (Compare-Object -ReferenceObject $AllowedOrigins -DifferenceObject $savedOrigins)) {
        throw "Native Messaging 清单验证失败 / Manifest verification failed: $manifestPath"
    }
}

if ($Browser -in @('All', 'Chrome')) {
    Repair-NativeManifest -Name 'chrome' -RegistryPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.gptlock.core' -AllowedOrigins (Get-AllowedOrigins -StoreExtensionId $ChromeStoreExtensionId)
}
if ($Browser -in @('All', 'Edge')) {
    Repair-NativeManifest -Name 'edge' -RegistryPath 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.gptlock.core' -AllowedOrigins (Get-AllowedOrigins -StoreExtensionId $EdgeStoreExtensionId)
}

& $binaryPath doctor | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "本地核心诊断失败 / Local Core doctor failed with exit code $LASTEXITCODE"
}

Test-NativeMessagingRoundTrip

Write-Host 'GPTWork 浏览器连接及 Native Messaging 往返通信已修复并验证 / browser connection and round trip verified.' -ForegroundColor Green
Write-Host '请完全退出所有 Chrome/Edge 进程后重新打开 / Fully exit and restart every Chrome/Edge process.'
