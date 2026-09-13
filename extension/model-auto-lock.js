(() => {
  // GPTWork v0.5.56+: Work mode is a window-scoped feature gate. Model discovery is
  // still stored globally, but the background window-feature authority derives each
  // Chrome window's effective Work policy from that catalog. A content script must
  // never rewrite the shared policy merely because one window has Work mode enabled.
  //
  // This compatibility file intentionally remains in the content bundle so existing
  // update/recovery paths keep a stable classic-script list. All active policy
  // derivation now lives in tab-feature-runtime.js, whose tab-oriented message names
  // are retained only for backward compatibility while state is keyed by windowId.
})();
