import { markRuntimeGeneration } from './runtime-generation.js';
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
// Derive optimistic higher-model availability from trusted response metadata and keep
// unavailable models out of the active lock policy without changing ChatGPT traffic.
import './model-availability-runtime.js';
// Recover missing content runtimes only for real install/update lifecycle events. An
// ordinary MV3 service-worker wake must never fan out reinjection across open tabs.
import './content-runtime-recovery.js';
import './background-update.js';

// Persist only after the complete worker module graph has loaded successfully. Newly
// opened extension pages compare this marker with their own bundle generation and force
// one extension reload if an installer replaced files under a still-running old worker.
void markRuntimeGeneration();
