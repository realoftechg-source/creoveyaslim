// Renders the user-area sidebar + profile menu identically across
// dashboard.html and studio.html, and wires up mobile toggle + logout.

const NAV_ITEMS = [
  { href: '/dashboard', icon: '🏠', label: 'Dashboard' },
  { href: '/studio', icon: '🎬', label: 'Studio' },
  { href: '/dashboard#credits', icon: '💳', label: 'Credits & Billing' },
  { href: '/dashboard#history', icon: '🧾', label: 'Payment History' },
  { href: '/dashboard#profile', icon: '👤', label: 'My Profile' },
];

// Only one item is highlighted: exact page match, and for "#section" links
// the hash must match too (the plain Dashboard item is active only with no hash).
function isNavItemActive(item) {
  const [itemPath, itemHash] = item.href.split('#');
  if (window.location.pathname !== itemPath) return false;
  return (itemHash || '') === (window.location.hash || '').replace('#', '');
}

async function renderUserChrome() {
  const user = await getSession();
  if (!user) { window.location.href = '/login.html'; return null; }
  if (!user.isAdmin && !user.hasActiveAccess) { window.location.href = '/payment'; return null; }

  const path = window.location.pathname;
  document.getElementById('sidebar').innerHTML = `
    <button type="button" class="sidebar-close" id="sidebarCloseBtn" aria-label="Close navigation">×</button>
    <a class="brand" href="/"><img src="/img/logo.svg" class="brand-mark" alt="Creoveya">Creoveya</a>
    ${NAV_ITEMS.map((item) => `
      <a class="sidebar-link ${isNavItemActive(item) ? 'active' : ''}" href="${item.href}">
        <span class="icon">${item.icon}</span>${item.label}
      </a>`).join('')}
    <div class="sidebar-divider"></div>
    <a class="sidebar-link" href="/pages/help.html"><span class="icon">❓</span>Help &amp; Tutorial</a>
    <button type="button" class="sidebar-link" id="logoutSidebarBtn"><span class="icon">🚪</span>Log Out</button>
  `;

  document.getElementById('topbarRight').innerHTML = `
    <div class="profile-menu-wrap">
      <button class="profile-btn" id="profileBtn">
        <span class="profile-avatar" id="profileInitial"></span>
        <span id="profileName" class="text-muted" style="font-size:.9rem;"></span>
      </button>
      <div class="profile-dropdown" id="profileDropdown">
        <a href="/dashboard#credits">💳 Credits: <strong id="creditsQuick"></strong></a>
        <a href="/dashboard">👤 My Account</a>
      </div>
    </div>
  `;
  document.getElementById('topbarRight').classList.add('topbar-right');
  mountThemeToggle(document.getElementById('topbarRight'));
  document.getElementById('creditsQuick').textContent = user.creditsBalance.toLocaleString();

  document.getElementById('logoutSidebarBtn').addEventListener('click', async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
      // Inside the desktop app, sending users to the marketing homepage
      // after logout looks like a website, not a real app — send them
      // straight back to the sign-in screen instead. On the actual
      // website, the homepage is still the right landing spot.
      window.location.href = isDesktopApp() ? '/login.html' : '/';
    } catch (err) {
      console.error('Logout failed:', err);
    }
  });

  initProfileMenu(user);

  document.getElementById('menuToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('sidebarCloseBtn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });

  return user;
}
