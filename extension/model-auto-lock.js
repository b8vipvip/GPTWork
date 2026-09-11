(() => {
  // GPTWork v0.5.56+: Work mode is a per-tab feature gate. Model discovery is still
  // stored globally, but the background tab-feature authority derives each tab's
  // effective Work policy from that catalog. A content script must never rewrite the
  // shared policy merely because one tab has Work mode enabled.
  //
  // This compatibility file intentionally remains in the content bundle so existing
  // update/recovery paths keep a stable script list. All active policy derivation now
  // lives in tab-feature-runtime.js.
})();
