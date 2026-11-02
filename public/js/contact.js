document.getElementById('year').textContent = new Date().getFullYear();

apiFetch('/api/pages/telegram-link').then((data) => {
  const link = document.getElementById('telegramLink');
  if (data.url) link.href = data.url;
}).catch(() => {});

const captcha = initCaptcha(document.getElementById('captchaMount'));

document.getElementById('contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('contactError');
  const successEl = document.getElementById('contactSuccess');
  errorEl.classList.remove('show');
  successEl.classList.remove('show');

  if (!captcha.require()) {
    errorEl.textContent = 'Please tick "I\'m not a robot" first.';
    errorEl.classList.add('show');
    return;
  }
  const submitBtn = document.getElementById('contactSubmit');
  submitBtn.disabled = true;
  try {
    await apiFetch('/api/pages/contact', {
      method: 'POST',
      body: {
        name: document.getElementById('contactName').value,
        message: document.getElementById('contactMessage').value,
        captchaToken: captcha.token(),
        website: document.getElementById('website').value,
      },
    });
    successEl.textContent = 'Thanks — your message has been sent. We\'ll get back to you soon.';
    successEl.classList.add('show');
    e.target.reset();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.add('show');
  } finally {
    captcha.reset();
    submitBtn.disabled = false;
  }
});


