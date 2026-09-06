export function composePaymentSystems(legacy, official) {
  return {
    async handleAdmin(req, res, url) {
      if (await official.handleAdmin(req, res, url)) return true;
      return legacy.handleAdmin(req, res, url);
    },
    async handleSite(req, res, url) {
      if (await official.handleSite(req, res, url)) return true;
      return legacy.handleSite(req, res, url);
    },
    list(enabledOnly = false) {
      return official.enrichList(legacy.list(enabledOnly), enabledOnly);
    },
    async prepareOrder(order, context = {}) {
      const legacyPrepared = await legacy.prepareOrder(order, context);
      return official.prepareOrder(legacyPrepared, context);
    },
    usdtQuote: (...args) => legacy.usdtQuote(...args),
    attachUsdtOrder: (...args) => legacy.attachUsdtOrder(...args),
    orderPaymentDetails: (...args) => legacy.orderPaymentDetails(...args),
    zpayOrderDetails(orderId) {
      return official.orderDetails(orderId) || legacy.zpayOrderDetails(orderId);
    },
    usdtOrderTtlMs: (...args) => legacy.usdtOrderTtlMs(...args),
    runAutoSettlement: (...args) => legacy.runAutoSettlement(...args),
    attachSettlement(handler) {
      legacy.attachSettlement(handler);
      official.attachSettlement(handler);
    },
    close() { legacy.close(); },
    parseUsdtMicros: (...args) => legacy.parseUsdtMicros(...args),
    formatUsdtMicros: (...args) => legacy.formatUsdtMicros(...args),
  };
}
