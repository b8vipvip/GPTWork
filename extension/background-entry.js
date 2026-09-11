import './settings-migration.js';
import './private-context-bridge.js';
import './private-request-hook.js';
import './private-response-hook.js';
import './background-local-error-capture.js';
// Patch ChatGptNetworkMonitor before background.js instantiates it. This keeps Chrome
// Debugger detached during top-level navigation and ignores stale legacy master state
// when both product feature gates are off.
import './network-monitor-safety.js';
// Register GPTLOCK_* runtime message handlers before recovery/update helpers start.
import './background.js';
// Derive optimistic higher-model availability from trusted response metadata and keep
// unavailable models out of the active lock policy without changing ChatGPT traffic.
import './model-availability-runtime.js';
// Re-inject the current content runtime into already-open ChatGPT tabs after an
// extension reload/update. This restores auto verification and the floating status UI.
import './content-runtime-recovery.js';
import './background-update.js';