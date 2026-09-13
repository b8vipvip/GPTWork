import './settings-migration.js';
import './private-context-bridge.js';
import './private-request-hook.js';
import './private-response-hook.js';
import './background-local-error-capture.js';
// Install the explicit GPTWork master lifecycle before background.js can open Native
// Messaging or recurring runtime activity.
import './master-runtime-safety.js';
// Own Work/Model-lock state by Chrome windowId. Tabs in the same ChatGPT window share
// state; moving a tab adopts the destination window's state. Historical tab-oriented
// message names remain only as a compatibility protocol for extension pages.
import './tab-feature-runtime.js';
// Register GPTLOCK_* runtime message handlers before recovery/update helpers start.
import './background.js';
// Derive optimistic higher-model availability from trusted response metadata and keep
// unavailable models out of the active lock policy without changing ChatGPT traffic.
import './model-availability-runtime.js';
// Recover missing content runtimes only for real install/update lifecycle events. An
// ordinary MV3 service-worker wake must never fan out reinjection across open tabs.
import './content-runtime-recovery.js';
import './background-update.js';
