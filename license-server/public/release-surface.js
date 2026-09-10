(() => {
  const feed = document.getElementById('releaseFeed');
  if (!feed) return;

  const windowsInstaller = /^GPTWorkSetup-x64\.exe$/i;
  const linuxInstaller = /^GPTWork_\d+(?:\.\d+){1,3}_amd64\.deb$/i;
  const minimumVersion = [0, 5, 48, 0];

  function parseVersion(tag) {
    const match = String(tag || '').trim().match(/^v(\d+(?:\.\d+){1,3})$/i);
    if (!match) return null;
    const parts = match[1].split('.').map(Number);
    while (parts.length < 4) parts.push(0);
    return parts;
  }

  function isPublicVersion(tag) {
    const parts = parseVersion(tag);
    if (!parts) return false;
    for (let index = 0; index < 4; index += 1) {
      if (parts[index] > minimumVersion[index]) return true;
      if (parts[index] < minimumVersion[index]) return false;
    }
    return true;
  }

  function applyReleaseSurfacePolicy() {
    feed.querySelectorAll('.release-card').forEach((card) => {
      if (!isPublicVersion(card.querySelector('.release-tag')?.textContent)) card.remove();
    });

    feed.querySelectorAll('.asset-link').forEach((link) => {
      let name = '';
      try {
        name = decodeURIComponent(new URL(link.href, location.href).pathname.split('/').pop() || '');
      } catch {}
      if (!windowsInstaller.test(name) && !linuxInstaller.test(name)) link.remove();
    });

    feed.querySelectorAll('.asset-row').forEach((row) => {
      if (!row.querySelector('.asset-link')) row.remove();
    });
  }

  new MutationObserver(applyReleaseSurfacePolicy).observe(feed, { childList: true, subtree: true });
  applyReleaseSurfacePolicy();
})();
