use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const INSTALLER_FILE_NAME: &str = "GPTWorkSetup-x64.exe";
#[cfg(windows)]
const UPDATE_HELPER_LOG_NAME: &str = "update-helper.log";
#[cfg(windows)]
const UPDATE_INSTALLER_LOG_NAME: &str = "update-installer.log";
#[cfg(windows)]
const UPDATE_COORDINATOR_SCRIPT_NAME: &str = "update-coordinator.ps1";
#[cfg(windows)]
const UPDATE_COORDINATOR_JOB_NAME: &str = "update-job.json";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUpdateRequest {
    pub installer_path: String,
    pub expected_sha256: String,
    pub target_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUpdateResult {
    pub target_version: String,
    pub installer_path: String,
    pub install_root: String,
    pub current_pid: u32,
    pub signature_status: String,
    pub download_unblocked: bool,
    pub helper_log_path: String,
    pub installer_log_path: String,
    pub coordinator_script_path: String,
    pub coordinator_job_path: String,
    pub launcher_strategy: String,
    pub launcher_process_id: u32,
}

fn normalized_sha256(value: &str) -> Result<String> {
    let trimmed = value.trim();
    let normalized = trimmed
        .strip_prefix("sha256:")
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid SHA-256 digest / SHA-256 校验值无效");
    }
    Ok(normalized)
}

fn validate_target_version(value: &str) -> Result<String> {
    let normalized = value.trim().trim_start_matches(['v', 'V']);
    let parts = normalized.split('.').collect::<Vec<_>>();
    if !(2..=4).contains(&parts.len())
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        bail!("invalid target version / 目标版本号无效");
    }
    Ok(normalized.to_owned())
}

fn validate_installer_path(path: &Path) -> Result<PathBuf> {
    if path.file_name().and_then(|value| value.to_str()) != Some(INSTALLER_FILE_NAME) {
        bail!("unexpected installer filename / 安装器文件名不受信任");
    }
    let canonical = path
        .canonicalize()
        .with_context(|| format!("cannot resolve installer path: {}", path.display()))?;
    if !canonical.is_file() {
        bail!("installer is not a file / 安装器文件不存在");
    }
    Ok(canonical)
}

fn install_root_from_current_exe() -> Result<PathBuf> {
    let executable = std::env::current_exe()
        .context("cannot determine GPTWork executable path / 无法确定 GPTWork 程序路径")?
        .canonicalize()
        .context("cannot resolve GPTWork executable path / 无法解析 GPTWork 程序路径")?;
    let parent = executable
        .parent()
        .context("GPTWork executable has no parent directory")?;
    if parent.file_name().and_then(|value| value.to_str()) == Some("bin") {
        return parent
            .parent()
            .map(Path::to_path_buf)
            .context("GPTWork bin directory has no install root");
    }
    Ok(parent.to_path_buf())
}

#[cfg(windows)]
fn windows_shell_path(path: &Path) -> Result<String> {
    let raw = path
        .to_str()
        .context("Windows update path is not valid UTF-8 / Windows 更新路径不是有效 UTF-8")?;
    let normalized = if let Some(rest) = raw.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = raw.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        raw.to_owned()
    };
    if normalized.contains('"') {
        bail!("Windows update path contains an invalid quote / Windows 更新路径包含非法引号");
    }
    Ok(normalized)
}

#[cfg(windows)]
fn powershell_hash(path: &Path) -> Result<String> {
    use std::process::Command;

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$ErrorActionPreference='Stop'; (Get-FileHash -LiteralPath $env:GPTLOCK_INSTALLER_PATH -Algorithm SHA256).Hash.ToLowerInvariant()",
        ])
        .env("GPTLOCK_INSTALLER_PATH", path)
        .output()
        .context("failed to calculate installer SHA-256 / 无法计算安装器 SHA-256")?;
    if !output.status.success() {
        bail!(
            "installer SHA-256 command failed / 安装器 SHA-256 校验命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    normalized_sha256(String::from_utf8_lossy(&output.stdout).trim())
}

#[cfg(windows)]
fn powershell_signature_status(path: &Path) -> Result<String> {
    use std::process::Command;

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$ErrorActionPreference='Stop'; (Get-AuthenticodeSignature -LiteralPath $env:GPTLOCK_INSTALLER_PATH).Status.ToString()",
        ])
        .env("GPTLOCK_INSTALLER_PATH", path)
        .output()
        .context("failed to inspect installer signature / 无法检查安装器数字签名")?;
    if !output.status.success() {
        bail!(
            "installer signature inspection failed / 安装器数字签名检查失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let status = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok(if status.is_empty() {
        "Unknown".to_owned()
    } else {
        status
    })
}

#[cfg(windows)]
fn unblock_verified_download(path: &Path) -> Result<bool> {
    use std::process::Command;

    // Chrome/Edge attach Mark-of-the-Web (Zone.Identifier) to downloaded EXEs. Launching
    // an unsigned MOTW file from a hidden updater can strand the update behind an
    // interactive Attachment Manager/SmartScreen prompt. We remove MOTW only *after* the
    // file has matched the exact SHA-256 published by the trusted GitHub Release metadata.
    // Manual downloads are never modified by GPTWork.
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$ErrorActionPreference='Stop'; $hadZone = @((Get-Item -LiteralPath $env:GPTLOCK_INSTALLER_PATH -Stream Zone.Identifier -ErrorAction SilentlyContinue)).Count -gt 0; if ($hadZone) { Unblock-File -LiteralPath $env:GPTLOCK_INSTALLER_PATH }; $hasZone = @((Get-Item -LiteralPath $env:GPTLOCK_INSTALLER_PATH -Stream Zone.Identifier -ErrorAction SilentlyContinue)).Count -gt 0; if ($hasZone) { throw 'Zone.Identifier remains after Unblock-File' }; if ($hadZone) { 'removed' } else { 'absent' }",
        ])
        .env("GPTLOCK_INSTALLER_PATH", path)
        .output()
        .context("failed to unblock verified installer / 无法解除已校验安装器的下载阻止")?;
    if !output.status.success() {
        bail!(
            "verified installer unblock failed / 已校验安装器解除下载阻止失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "removed")
}

#[cfg(windows)]
fn windows_installer_arguments(install_root: &Path, installer_log: &Path) -> Result<String> {
    let install_root = windows_shell_path(install_root)?;
    let installer_log = windows_shell_path(installer_log)?;
    Ok(format!(
        "/SUPPRESSMSGBOXES /NORESTART /VERYSILENT /DIR=\"{install_root}\" /LOG=\"{installer_log}\""
    ))
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCoordinatorJob {
    current_pid: u32,
    installer_path: String,
    installer_arguments: String,
    install_root: String,
    core_path: String,
    target_version: String,
    helper_log_path: String,
}

#[cfg(windows)]
fn coordinator_script() -> &'static str {
    r#"param([Parameter(Mandatory=$true)][string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json

function Write-HelperLog([string]$Message) {
  $stamp = (Get-Date).ToString('o')
  Add-Content -LiteralPath $job.helperLogPath -Value ("$stamp $Message") -Encoding UTF8
}

function Get-InstalledCoreProcesses {
  $target = [IO.Path]::GetFullPath([string]$job.corePath)
  return @(Get-Process -Name 'gptwork-core','gptlock-core' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and ([IO.Path]::GetFullPath([string]$_.Path) -ieq $target) } catch { $false }
  })
}

function Stop-InstalledCoreProcesses {
  foreach ($process in @(Get-InstalledCoreProcesses)) {
    try {
      Stop-Process -Id ([int]$process.Id) -Force -ErrorAction Stop
      Write-HelperLog ("stopped_core pid=" + $process.Id)
    } catch {
      Write-HelperLog ("stop_core_failed pid=" + $process.Id + " error=" + $_.Exception.Message)
    }
  }
}

try {
  Write-HelperLog ("coordinator_started target=" + $job.targetVersion + " current_pid=" + $job.currentPid)
  $deadline = (Get-Date).AddSeconds(3)
  while (Get-Process -Id ([int]$job.currentPid) -ErrorAction SilentlyContinue) {
    if ((Get-Date) -ge $deadline) {
      Write-HelperLog 'preparing_native_host_still_running_forcing_shutdown'
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not (Get-Process -Id ([int]$job.currentPid) -ErrorAction SilentlyContinue)) {
    Write-HelperLog 'preparing_native_host_exited'
  }

  Stop-InstalledCoreProcesses
  Start-Sleep -Milliseconds 150
  Stop-InstalledCoreProcesses
  $installer = Start-Process -FilePath ([string]$job.installerPath) -ArgumentList ([string]$job.installerArguments) -WorkingDirectory ([string]$job.installRoot) -WindowStyle Hidden -PassThru
  Write-HelperLog ("installer_started pid=" + $installer.Id)

  # Setup pauses the Native Messaging manifests before replacing binaries and performs
  # its own bounded process shutdown. Do not keep killing gptwork-core while Setup is
  # running: the installer's post-install Repair-GPTWork.ps1 intentionally starts the
  # freshly installed core to verify a real Native Messaging round trip.
  while (-not $installer.HasExited) {
    Start-Sleep -Milliseconds 250
    $installer.Refresh()
  }
  $exitCode = $installer.ExitCode
  Write-HelperLog ("installer_exited code=" + $exitCode)
  if ($exitCode -ne 0) { throw ("Installer exited with code " + $exitCode) }

  Stop-InstalledCoreProcesses
  Start-Sleep -Milliseconds 500
  $versionOutput = (& ([string]$job.corePath) --version 2>&1 | Out-String).Trim()
  Write-HelperLog ("installed_core_version_output=" + $versionOutput)
  if ($versionOutput -notmatch [regex]::Escape([string]$job.targetVersion)) {
    throw ("Installed Core version did not match target " + $job.targetVersion + ": " + $versionOutput)
  }
  Write-HelperLog 'coordinator_completed'
  exit 0
} catch {
  Write-HelperLog ("coordinator_failed error=" + $_.Exception.Message)
  exit 1
}
"#
}

#[cfg(windows)]
fn write_update_coordinator_files(
    install_root: &Path,
    installer: &Path,
    installer_log: &Path,
    helper_log: &Path,
    target_version: &str,
    current_pid: u32,
) -> Result<(PathBuf, PathBuf)> {
    use std::fs;

    let script_path = install_root.join(UPDATE_COORDINATOR_SCRIPT_NAME);
    let job_path = install_root.join(UPDATE_COORDINATOR_JOB_NAME);
    let core_path = install_root.join("bin").join("gptwork-core.exe");
    let job = UpdateCoordinatorJob {
        current_pid,
        installer_path: windows_shell_path(installer)?,
        installer_arguments: windows_installer_arguments(install_root, installer_log)?,
        install_root: windows_shell_path(install_root)?,
        core_path: windows_shell_path(&core_path)?,
        target_version: target_version.to_owned(),
        helper_log_path: windows_shell_path(helper_log)?,
    };
    fs::write(&script_path, coordinator_script()).with_context(|| {
        format!(
            "failed to write update coordinator: {}",
            script_path.display()
        )
    })?;
    fs::write(
        &job_path,
        serde_json::to_vec_pretty(&job).context("serialize update coordinator job")?,
    )
    .with_context(|| {
        format!(
            "failed to write update coordinator job: {}",
            job_path.display()
        )
    })?;
    Ok((script_path, job_path))
}

#[cfg(windows)]
fn windows_coordinator_command_line(script_path: &Path, job_path: &Path) -> Result<String> {
    let script_path = windows_shell_path(script_path)?;
    let job_path = windows_shell_path(job_path)?;
    Ok(format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{script_path}\" -JobPath \"{job_path}\""
    ))
}

#[cfg(windows)]
fn launch_coordinator_via_wmi(
    script_path: &Path,
    job_path: &Path,
    install_root: &Path,
) -> Result<u32> {
    use std::process::Command;

    // The coordinator is created by WMI with CREATE_BREAKAWAY_FROM_JOB, so it survives the
    // Native Messaging host that prepared the update. It waits for that host to exit before
    // starting Setup, then continuously terminates only the installed gptwork-core.exe while
    // Setup is running. This prevents Chrome's automatic Native Messaging reconnects and the
    // update page's probes from re-locking the executable that Setup is trying to replace.
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let command_line = windows_coordinator_command_line(script_path, job_path)?;
    let install_root_text = windows_shell_path(install_root)?;
    let script = format!(
        "$ErrorActionPreference='Stop'; $startupClass=[WMIClass]'\\\\.\\root\\cimv2:Win32_ProcessStartup'; $startup=$startupClass.CreateInstance(); $startup.CreateFlags={CREATE_BREAKAWAY_FROM_JOB}; $startup.ShowWindow=0; $processClass=[WMIClass]'\\\\.\\root\\cimv2:Win32_Process'; $result=$processClass.Create($env:GPTLOCK_UPDATE_COMMAND_LINE,$env:GPTLOCK_INSTALL_ROOT,$startup); if ([int]$result.ReturnValue -ne 0) {{ throw ('Win32_Process.Create failed with code ' + $result.ReturnValue) }}; [Console]::Out.WriteLine([string]$result.ProcessId)"
    );
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .env("GPTLOCK_UPDATE_COMMAND_LINE", command_line)
        .env("GPTLOCK_INSTALL_ROOT", install_root_text)
        .output()
        .context("failed to invoke WMI update coordinator / 无法调用 WMI 更新协调器")?;
    if !output.status.success() {
        bail!(
            "WMI update coordinator failed / WMI 更新协调器失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let process_id = stdout
        .lines()
        .rev()
        .find_map(|line| line.trim().parse::<u32>().ok())
        .context("WMI coordinator did not return PID / WMI 协调器未返回 PID")?;
    Ok(process_id)
}

#[cfg(windows)]
fn write_update_launch_log(
    helper_log_path: &Path,
    installer_log_path: &Path,
    target_version: &str,
) -> Result<()> {
    use std::fs;

    let text = format!(
        "launcher_strategy=wmi_coordinator_breakaway\ntarget_version={target_version}\ninstaller_log={}\n",
        installer_log_path.display()
    );
    fs::write(helper_log_path, text).with_context(|| {
        format!(
            "failed to write update launch log: {} / 无法写入更新启动日志",
            helper_log_path.display()
        )
    })
}

#[cfg(windows)]
fn append_update_launcher_pid(helper_log_path: &Path, launcher_process_id: u32) -> Result<()> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(helper_log_path)
        .with_context(|| {
            format!(
                "failed to open update launch log: {}",
                helper_log_path.display()
            )
        })?;
    writeln!(file, "coordinator_pid={launcher_process_id}")
        .context("failed to append update coordinator PID")
}

pub fn prepare_update(request: PrepareUpdateRequest) -> Result<PrepareUpdateResult> {
    let expected_sha256 = normalized_sha256(&request.expected_sha256)?;
    let target_version = validate_target_version(&request.target_version)?;
    let installer_path = validate_installer_path(Path::new(&request.installer_path))?;
    let install_root = install_root_from_current_exe()?;

    #[cfg(not(windows))]
    {
        let _ = (
            expected_sha256,
            installer_path,
            install_root,
            target_version,
        );
        bail!("one-click installer update is only supported on Windows / 一键安装更新目前仅支持 Windows");
    }

    #[cfg(windows)]
    {
        let actual_sha256 = powershell_hash(&installer_path)?;
        if actual_sha256 != expected_sha256 {
            bail!("installer SHA-256 mismatch / 安装器 SHA-256 校验失败");
        }

        let signature_status = powershell_signature_status(&installer_path)?;
        let download_unblocked = unblock_verified_download(&installer_path)?;
        let pid = std::process::id();
        let helper_log_path = install_root.join(UPDATE_HELPER_LOG_NAME);
        let installer_log_path = install_root.join(UPDATE_INSTALLER_LOG_NAME);
        let (coordinator_script_path, coordinator_job_path) = write_update_coordinator_files(
            &install_root,
            &installer_path,
            &installer_log_path,
            &helper_log_path,
            &target_version,
            pid,
        )?;
        write_update_launch_log(&helper_log_path, &installer_log_path, &target_version)?;
        let launcher_process_id = launch_coordinator_via_wmi(
            &coordinator_script_path,
            &coordinator_job_path,
            &install_root,
        )?;
        append_update_launcher_pid(&helper_log_path, launcher_process_id)?;

        Ok(PrepareUpdateResult {
            target_version,
            installer_path: installer_path.to_string_lossy().into_owned(),
            install_root: install_root.to_string_lossy().into_owned(),
            current_pid: pid,
            signature_status,
            download_unblocked,
            helper_log_path: helper_log_path.to_string_lossy().into_owned(),
            installer_log_path: installer_log_path.to_string_lossy().into_owned(),
            coordinator_script_path: coordinator_script_path.to_string_lossy().into_owned(),
            coordinator_job_path: coordinator_job_path.to_string_lossy().into_owned(),
            launcher_strategy: "wmi_coordinator_breakaway".to_owned(),
            launcher_process_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_sha256() {
        let digest = "A".repeat(64);
        assert_eq!(normalized_sha256(&digest).unwrap(), "a".repeat(64));
        assert!(normalized_sha256("abc").is_err());
    }

    #[test]
    fn validates_target_versions() {
        assert_eq!(validate_target_version("v0.4.0").unwrap(), "0.4.0");
        assert!(validate_target_version("0.4-beta").is_err());
    }

    #[test]
    fn rejects_wrong_installer_filename_before_touching_disk() {
        let error = validate_installer_path(Path::new("evil.exe")).unwrap_err();
        assert!(error.to_string().contains("filename"));
    }

    #[cfg(windows)]
    #[test]
    fn formats_silent_installer_arguments() {
        let install_root = Path::new(r"C:\Users\test\AppData\Local\GPTWork");
        let installer_log = install_root.join(UPDATE_INSTALLER_LOG_NAME);
        let arguments = windows_installer_arguments(install_root, &installer_log).unwrap();
        assert!(arguments.contains("/VERYSILENT"));
        assert!(arguments.contains("/DIR=\"C:\\Users\\test\\AppData\\Local\\GPTWork\""));
        assert!(arguments.contains("update-installer.log"));
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_extended_windows_paths_for_powershell_and_wmi() {
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\D:\AI\GPTWork")).unwrap(),
            r"D:\AI\GPTWork"
        );
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\UNC\server\share\GPTWork")).unwrap(),
            r"\\server\share\GPTWork"
        );
    }

    #[cfg(windows)]
    #[test]
    fn coordinator_waits_for_preparing_host_and_suppresses_core_reconnects() {
        let script = coordinator_script();
        assert!(script.contains("Get-Process -Id ([int]$job.currentPid)"));
        assert!(script.contains("preparing_native_host_still_running_forcing_shutdown"));
        assert!(!script.contains("Timed out waiting for preparing Native Messaging host to exit"));
        assert!(script.contains("Stop-InstalledCoreProcesses"));
        assert!(script.contains("while (-not $installer.HasExited)"));
        assert!(!script.contains("while (-not $installer.HasExited) {\n    Stop-InstalledCoreProcesses"));
        assert!(script.contains("post-install Repair-GPTWork.ps1"));
        assert!(script.contains("Get-Process -Name 'gptwork-core'"));
        assert!(script.contains("installed_core_version_output"));
    }

    #[cfg(windows)]
    #[test]
    fn unblock_verified_download_is_idempotent_without_motw() {
        let directory = tempfile::tempdir().unwrap();
        let installer = directory.path().join(INSTALLER_FILE_NAME);
        std::fs::write(&installer, b"test installer placeholder").unwrap();
        assert!(!unblock_verified_download(&installer).unwrap());
        assert!(!unblock_verified_download(&installer).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn unblock_verified_download_removes_mark_of_the_web() {
        use std::process::Command;

        let directory = tempfile::tempdir().unwrap();
        let installer = directory.path().join(INSTALLER_FILE_NAME);
        std::fs::write(&installer, b"test installer placeholder").unwrap();

        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$ErrorActionPreference='Stop'; Set-Content -LiteralPath $env:GPTLOCK_INSTALLER_PATH -Stream Zone.Identifier -Value \"[ZoneTransfer]`r`nZoneId=3\" -Encoding ASCII",
            ])
            .env("GPTLOCK_INSTALLER_PATH", &installer)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "failed to create Zone.Identifier: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        assert!(unblock_verified_download(&installer).unwrap());
        assert!(!unblock_verified_download(&installer).unwrap());
    }
}
