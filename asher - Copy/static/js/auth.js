(() => {
  const form = document.querySelector('.auth-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    const password = form.querySelector('input[name="password"]');
    if (password && password.value.length < 6) {
      e.preventDefault();
      alert('Password must be at least 6 characters.');
    }
  });
})();
