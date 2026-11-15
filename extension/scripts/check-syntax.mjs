import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceFiles = [
  "background-entry.js",
  "background-local-error-capture.js",
  "runtime-generation.js",
  "extension-page-runtime.js",
  "tab-feature-runtime.js",
  "account-refresh-scheduler.js",
  "content-runtime-recovery.js",
  "content-runtime-lifecycle.js",
  "floating-ui-master-state.js",
  "master-ui-controller.js",
  "model-availability.js",
  "model-availability-runtime.js",
  "background-update.js",
  "settings-migration.js",
  "capability-lease-client.js",
  "private-core-channel.js",
  "private-context-bridge.js",
  "private-context-budget-authority.js",
  "private-request-hook.js",
  "private-request-routing.js",
  "private-response-hook.js",
  "private-response-routing.js",
  "response-stream-activity.js",
  "background.js",
  "runtime-log.js",
  "request-history.js",
  "request-history-options.js",
  "page-model-evidence.js",
  "astra-model-evidence.js",
  "composer-send-compat.js",
  "context-budget.js",
  "chat-length-remaining-indicator.js",
  "chat-length-hard-limit-semantic.js",
  "chat-length-remaining-truth.js",
  "content-local-error-capture.js",
  "content.js",
  "jank-control.js",
  "generation-reload.js",
  "model-status-history.js",
  "model-status-continuity.js",
  "multi-window-lock-sync.js",
  "work-mode-controller.js",
  "popup.js",
  "popup-shell.js",
  "popup-v0513-shell.js",
  "popup-help.js",
  "popup-navigation.js",
  "module-nav.js",
  "update-entry.js",
  "extension-page-error-capture.js",
  "feature-toggle-controller.js",
  "settings-shell.js",
  "settings-local-logs.js",
  "model-availability-options.js",
  "auth-gate.js",
  "account.js",
  "account-client.js",
  "options.js",
  "options-update.js",
  "policy.js",
  "native-status.js",
  "update-manager.js",
  "model-catalog.js",
  "model-catalog-options.js",
  "model-verification-history-options.js",
  "model-auto-lock.js",
  "../license-server/server.mjs",
  "../license-server/client-runtime-logs.mjs",
  "../license-server/site-account.mjs",
  "../license-server/site-releases.mjs",
  "../license-server/public/admin.js",
  "../license-server/public/client-runtime-admin.js",
  "../license-server/public/site.js",
  "../license-server/public/release-surface.js"
];

const failures = [];
for (const file of sourceFiles) {
  if (!existsSync(resolve(extensionRoot, file))) {
    failures.push(`Missing syntax-check target: ${file}`);
    continue;
  }

  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: extensionRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\\n")
      .trim();
    failures.push(`${file}:\\n${detail || `node --check exited with status ${result.status}`}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\\n\\n"));
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${sourceFiles.length} JavaScript files.`);
}
