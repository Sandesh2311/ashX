(() => {
  let deferredPrompt = null;

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    await navigator.serviceWorker.register('/static/sw.js');
  }

  function setupInstallButton() {
    const installBtn = document.getElementById('installPwaBtn');
    if (!installBtn) return;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.classList.remove('hidden');
    });

    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add('hidden');
    });
  }

  function askNotificationPermission() {
    const notifBtn = document.getElementById('notifBtn');
    if (!notifBtn || !('Notification' in window)) return;

    notifBtn.addEventListener('click', async () => {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') notifBtn.textContent = 'Notifications On';
    });
  }

  registerSW();
  setupInstallButton();
  askNotificationPermission();
})();
