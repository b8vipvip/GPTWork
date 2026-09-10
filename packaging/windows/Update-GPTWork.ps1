[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$repository = 'b8vipvip/GPTWork'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Split-Path -Parent $scriptDirectory
$headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'GPTWork-Updater'
}
$temporaryDirectory = Join-Path $env:TEMP ("GPTWork-Update-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Windows PowerShell may already be using the system TLS defaults.
}

function Invoke-GptWorkDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile
    )

    $lastWebError = $null
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            if (Test-Path -LiteralPath $OutFile) {
                Remove-Item -LiteralPath $OutFile -Force
            }
            Invoke-WebRequest -Uri $Uri -Headers $headers -OutFile $OutFile -UseBasicParsing -TimeoutSec 90
            if (Test-Path -LiteralPath $OutFile) {
                return
            }
        } catch {
            $lastWebError = $_.Exception.Message
            if ($attempt -lt 4) {
                $delay = [Math]::Min(8, [Math]::Pow(2, $attempt))
                Write-Warning "GitHub 下载失败，第 $attempt/4 次；${delay}s 后重试 / GitHub download attempt $attempt/4 failed; retrying in ${delay}s: $lastWebError"
                Start-Sleep -Seconds $delay
            }
        }
    }

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -eq $curl) {
        throw "PowerShell 多次下载失败且系统没有 curl.exe / PowerShell downloads failed and curl.exe is unavailable: $lastWebError"
    }

    Write-Warning "PowerShell 下载链路仍不稳定，改用 curl.exe 多重重试 / Falling back to curl.exe with retries: $lastWebError"
    if (Test-Path -LiteralPath $OutFile) {
        Remove-Item -LiteralPath $OutFile -Force
    }
    & $curl.Source --location --fail --retry 6 --retry-delay 2 --retry-connrefused --retry-max-time 180 --connect-timeout 15 --max-time 300 --speed-time 30 --speed-limit 1024 --output $OutFile $Uri
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutFile)) {
        throw "curl.exe 下载失败 / curl.exe download failed (exit $LASTEXITCODE)."
    }
}

try {
    Write-Host '正在检查 GPTWork 更新 / Checking for GPTWork updates…'
    $releaseJsonPath = Join-Path $temporaryDirectory 'release.json'
    Invoke-GptWorkDownload -Uri "https://api.github.com/repos/$repository/releases/latest" -OutFile $releaseJsonPath
    $release = Get-Content -LiteralPath $releaseJsonPath -Raw | ConvertFrom-Json

    $installerAsset = $release.assets | Where-Object { $_.name -eq 'GPTWorkSetup-x64.exe' } | Select-Object -First 1
    if ($null -eq $installerAsset) {
        throw '最新版本缺少 Windows 安装器 / Latest release is missing the Windows installer.'
    }

    $digest = [string]$installerAsset.digest
    if ($digest -notmatch '^sha256:([0-9a-fA-F]{64})$') {
        throw '最新版本安装器缺少 GitHub SHA-256 摘要 / Latest installer is missing its GitHub SHA-256 digest.'
    }
    $expected = $Matches[1].ToLowerInvariant()

    $downloadUrl = [string]$installerAsset.browser_download_url
    if ($downloadUrl -notmatch '^https://github\.com/b8vipvip/GPTWork/releases/download/v\d+(?:\.\d+){1,3}/GPTWorkSetup-x64\.exe$') {
        throw '安装器下载地址不受信任 / Installer download URL is not trusted.'
    }

    $installerPath = Join-Path $temporaryDirectory $installerAsset.name
    Write-Host "正在下载 $($installerAsset.name)，网络失败会自动重试 / Downloading $($installerAsset.name) with automatic retries…"
    Invoke-GptWorkDownload -Uri $downloadUrl -OutFile $installerPath

    $actual = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        throw 'SHA-256 校验失败，已停止更新 / SHA-256 verification failed; update aborted.'
    }

    Write-Host "正在安装 $($release.tag_name) / Installing $($release.tag_name)…"
    $arguments = @('/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$installRoot`"")
    if ($Silent) { $arguments += '/VERYSILENT' }
    $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "安装器返回错误 / Installer failed with exit code $($process.ExitCode)."
    }
    Write-Host '更新完成；请完全重启浏览器 / Update complete; fully restart the browser.' -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
