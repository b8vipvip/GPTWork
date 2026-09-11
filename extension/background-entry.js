import './settings-migration.js';
import './private-context-bridge.js';
import './private-request-hook.js';
import './private-response-hook.js';
// Register GPTLOCK_* runtime message handlers before background-update starts its
// immediate client-control long poll. Otherwise a service-worker cold start can ask
// for GPTLOCK_ACCOUNT_REFRESH before any receiver exists and log a false channel error.
import './background.js';
import './background-update.js';
