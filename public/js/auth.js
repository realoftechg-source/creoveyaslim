// Shared client logic for the sign-in / register / forgot / reset pages:
//   - "I'm not a robot" verification (Cloudflare Turnstile if configured,
//     otherwise the built-in checkbox)
//   - "Continue with Google"
//   - post-login routing
// Depends on common.js (apiFetch, isDesktopApp, getTheme).

const pageLoadedAt = Date.now();
let humanInteractions = 0;
['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'].forEach((evt) => {
  window.addEventListener(evt, (e) => { if (e.isTrusted) humanInteractions += 1; }, { passive: true });
});

let authConfigPromise = null;
function getAuthConfig() {
  if (!authConfigPromise) {
    authConfigPromise = apiFetch('/auth/config').catch(() => ({ captcha: { provider: 'checkbox' }, googleClientId: null }));
  }
  return authConfigPromise;
}

function routeAfterLogin(user) {
  if (user.isAdmin) window.location.href = '/admin_dashboard';
  else if (user.hasActiveAccess) window.location.href = '/dashboard';
  else window.location.href = '/payment';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.async = true; el.defer = true;
    el.onload = resolve; el.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
}

/**
 * Renders the "I'm not a robot" control inside `mount` and returns a handle:
 *   captcha.token()   -> current token or null
 *   captcha.require() -> true if verified; otherwise flags the box and returns false
 *   captcha.reset()   -> call after every submit (tokens are single use)
 */
function initCaptcha(mount) {
  const state = { token: null, widgetId: null, provider: 'checkbox' };
  const api = {
    token: () => state.token,
    require() {
      if (state.token) return true;
      const box = mount.querySelector('.captcha-box');
      if (box) { box.classList.add('invalid'); setTimeout(() => box.classList.remove('invalid'), 1600); }
      return false;
    },
    reset() {
      state.token = null;
      if (state.provider === 'turnstile' && window.turnstile && state.widgetId != null) {
        try { window.turnstile.reset(state.widgetId); } catch (e) { /* ignore */ }
      } else {
        renderCheckbox();
      }
    },
  };

  function renderCheckbox() {
    mount.innerHTML = `
      <div class="captcha-box" role="checkbox" aria-checked="false" tabindex="0">
        <span class="captcha-check"></span>
        <span class="captcha-text">I'm not a robot</span>
        <span class="captcha-brand">Creoveya<br>Shield</span>
      </div>`;
    const box = mount.querySelector('.captcha-box');
    const verify = async () => {
      if (box.classList.contains('working') || box.classList.contains('done')) return;
      box.classList.add('working');
      // A person needs a moment to reach the box; scripts don't.
      const wait = Math.max(0, 1000 - (Date.now() - pageLoadedAt));
      await new Promise((r) => setTimeout(r, wait + 350));
      try {
        const data = await apiFetch('/auth/captcha', {
          method: 'POST',
          body: { elapsedMs: Date.now() - pageLoadedAt, interactions: humanInteractions },
        });
        state.token = data.token;
        box.classList.remove('working'); box.classList.add('done');
        box.setAttribute('aria-checked', 'true');
        box.querySelector('.captcha-check').textContent = '✓';
      } catch (err) {
        box.classList.remove('working'); box.classList.add('invalid');
        setTimeout(() => box.classList.remove('invalid'), 1600);
      }
    };
    box.addEventListener('click', verify);
    box.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); verify(); } });
  }

  getAuthConfig().then(async (cfg) => {
    state.provider = cfg.captcha.provider;
    if (cfg.captcha.provider === 'turnstile') {
      mount.className = (mount.className + ' turnstile-wrap').trim();
      try {
        await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
        state.widgetId = window.turnstile.render(mount, {
          sitekey: cfg.captcha.siteKey,
          theme: (typeof getTheme === 'function' && getTheme() === 'dark') ? 'dark' : 'light',
          callback: (t) => { state.token = t; },
          'expired-callback': () => { state.token = null; },
          'error-callback': () => { state.token = null; },
        });
      } catch (e) {
        state.provider = 'checkbox';
        mount.className = mount.className.replace('turnstile-wrap', '').trim();
        renderCheckbox();
      }
    } else {
      renderCheckbox();
    }
  });
  return api;
}

/** Shows a "Continue with Google" button in `mount` when Google login is configured. */
async function initGoogleLogin(mount, dividerEl, onCredential) {
  const cfg = await getAuthConfig();
  // Google's pop-up flow can't complete inside the Electron desktop app.
  if (!cfg.googleClientId || (typeof isDesktopApp === 'function' && isDesktopApp())) return;
  try {
    await loadScript('https://accounts.google.com/gsi/client');
    window.google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: (resp) => onCredential(resp.credential),
      ux_mode: 'popup',
    });
    window.google.accounts.id.renderButton(mount, {
      type: 'standard', theme: getTheme() === 'dark' ? 'filled_black' : 'outline', size: 'large',
      text: 'continue_with', shape: 'pill', logo_alignment: 'center', width: Math.min(360, mount.clientWidth || 360),
    });
    mount.classList.remove('hidden');
    if (dividerEl) dividerEl.classList.remove('hidden');
  } catch (e) {
    console.warn('[auth] Google sign-in unavailable:', e.message);
  }
}

function showAuthError(el, message) {
  el.textContent = message;
  el.classList.add('show');
}
