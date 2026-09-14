import './runtime-generation.js';
import './settings-migration.js';
import './private-context-bridge.js';
import './private-request-hook.js';
import './private-response-hook.js';
import './background-local-error-capture.js';
// Work/Model-lock state is owned by the concrete ChatGPT tab. windowId is used only
// for account concurrency quota checks; tabs in the same Chrome window never inherit
// or share one another's feature state.
import './tab-feature-runtime.js';
// background.js is the single lifecycle authority for Native Messaging, alarms,
// debugger attach/detach, badge cleanup, and Master OFF shutdown.
import './background.js';
// Derive higher-model availability from positive trusted network evidence. Only a
// complete account-level model catalog may declare a model unavailable; an unrelated
// chat response can never gray another model.
import './model-availability-runtime.js';
// Recover missing content runtimes only for real install/update lifecycle events. An
// ordinary MV3 service-worker wake must never fan out reinjection across open tabs.
import './content-runtime-recovery.js';
import './background-update.js';
