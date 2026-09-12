import './settings-migration.js';
import './private-context-bridge.js';
import './private-request-hook.js';
import './private-response-hook.js';
import './background-local-error-capture.js';
// Install the explicit GPTWork master lifecycle before background.js can open Native
// Messaging or recurring runtime activity.
import './master-runtime-safety.js';
// Own Work/Model-lock state per ChatGPT tab. This module also reserves its private
// message types before the legacy background catch-all receiver is registered.
import './tab-feature-runtime.js';
// Register GPTLOCK_* runtime message handlers before recovery/update helpers start.
import './background.js';
// Derive optimistic higher-model availability from trusted response metadata and keep
// unavailable models out of the active lock policy without changing ChatGPT traffic.
import './model-availability-runtime.js';
// Re-inject the current content runtime into already-open ChatGPT tabs after an
// extension reload/update. This restores auto verification and the floating status UI.
import './content-runtime-recovery.js';
import './background-update.js';
