export const DISTRIBUTION_CHANNEL = 'standalone';
export const STORE_BROWSER = null;
export const STORE_EXTENSION_ID = '';
export const STORE_LISTING_URL = '';

export function isStoreManagedExtension() {
  return DISTRIBUTION_CHANNEL === 'chrome-store' || DISTRIBUTION_CHANNEL === 'edge-store';
}
