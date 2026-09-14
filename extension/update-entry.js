import './options-update.js';

const params = new URLSearchParams(window.location.search);
if (params.get('check') === '1') {
  params.delete('check');
  const nextQuery = params.toString();
  const cleanUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', cleanUrl);
  window.requestAnimationFrame(() => {
    document.getElementById('checkUpdateNow')?.click();
  });
}
