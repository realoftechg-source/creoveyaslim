let currentSection = 'overview';
let cache = { users: [], plans: [], topupPlans: [], methods: [], payments: [] };

const SECTIONS = {
  overview: { title: 'Overview', subtitle: 'Platform activity at a glance.' },
  users: { title: 'Users', subtitle: 'Manage every account on the platform.' },
  payments: { title: 'Payment Approvals', subtitle: 'Review and approve/reject submitted payments.' },
  activity: { title: 'Activity History', subtitle: 'See all user actions, logins, and transactions.' },
  images: { title: 'User Images', subtitle: 'View all face transformation images uploaded by users.' },
  plans: { title: 'Activation Plans', subtitle: 'Create and manage the activation plans shown on the payment page.' },
  topups: { title: 'Credit Top-Up', subtitle: 'Create and manage top-up plans — only visible to users who already have an active account.' },
  broadcast: { title: 'Broadcast Message', subtitle: 'Send an email message to all users at once.' },
  methods: { title: 'Payment Methods', subtitle: 'Manage bank accounts (up to 3) and crypto wallets (up to 4).' },
  settings: { title: 'Platform Settings', subtitle: 'Decart API key, Telegram support username, and global credit rate.' },
  myaccount: { title: 'My Login', subtitle: 'Change the username, email, and password used to sign in to this admin account.' },
};

async function init() {
  const user = await getSession();
  if (!user) return window.location.href = '/login.html';
  if (!user.isAdmin) return window.location.href = '/';

  document.querySelectorAll('[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => switchSection(btn.dataset.section));
  });
  document.getElementById('adminLogout').addEventListener('click', async () => {
    await apiFetch('/auth/logout', { method: 'POST' });
    window.location.href = isDesktopApp() ? '/login.html' : '/';
  });
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });

  switchSection('overview');
}

function switchSection(section) {
  currentSection = section;
  document.querySelectorAll('[data-section]').forEach((btn) => btn.classList.toggle('active', btn.dataset.section === section));
  document.getElementById('sectionTitle').textContent = SECTIONS[section].title;
  document.getElementById('sectionSubtitle').textContent = SECTIONS[section].subtitle;
  document.getElementById('sidebar').classList.remove('open');
  renderSection(section);
}

function renderSection(section) {
  const map = { overview: renderOverview, users: renderUsers, payments: renderPayments, activity: renderActivity, images: renderImages, plans: renderPlans, topups: renderTopupPlans, broadcast: renderBroadcast, methods: renderMethods, settings: renderSettings, myaccount: renderMyAccount };
  map[section]();
}

function closeModal() { document.getElementById('modalBackdrop').classList.remove('open'); }
function openModal(html) {
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalBackdrop').classList.add('open');
}

// ===========================================================================
// OVERVIEW
// ===========================================================================
async function renderOverview() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/overview');
  content.innerHTML = `
    <div class="grid grid-4 mb-16">
      <div class="stat-card"><div class="label">Total Users</div><div class="value">${data.totalUsers}</div></div>
      <div class="stat-card"><div class="label">Active (Paid) Users</div><div class="value">${data.activeUsers}</div></div>
      <div class="stat-card"><div class="label">Pending Payments</div><div class="value">${data.pendingPayments}</div></div>
      <div class="stat-card"><div class="label">Live Right Now</div><div class="value">${data.liveNow}</div></div>
    </div>
    <div class="card">
      <div class="flex justify-between items-center mb-16">
        <h3 style="margin:0;">Recent Payment Submissions</h3>
        <button class="btn btn-outline btn-sm" onclick="switchSection('payments')">Review all →</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${data.recentSubmissions.length ? data.recentSubmissions.map((s) => `
              <tr>
                <td>${s.username}</td><td>${s.plan_name || '—'}</td><td>$${s.amount}</td>
                <td>${paymentBadge(s.status)}</td><td>${new Date(s.created_at).toLocaleString()}</td>
              </tr>`).join('') : '<tr><td colspan="5" class="text-muted">No submissions yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

function paymentBadge(status) {
  if (status === 'approved') return '<span class="badge badge-success">Approved</span>';
  if (status === 'rejected') return '<span class="badge badge-danger">Rejected</span>';
  return '<span class="badge badge-warning">Pending</span>';
}

// ===========================================================================
// USERS
// ===========================================================================
async function renderUsers() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/users');
  cache.users = data.users;

  content.innerHTML = `
    <div class="flex justify-between items-center mb-16" style="flex-wrap:wrap; gap:12px;">
      <input type="text" id="userSearch" placeholder="Search by username…" style="max-width:280px;">
      <button class="btn btn-primary btn-sm" id="createUserBtn">+ Create User</button>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Username</th><th>Credits</th><th>Time Left</th><th>Status</th><th>Access</th><th>Joined</th><th></th></tr></thead>
          <tbody id="usersBody"></tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('createUserBtn').addEventListener('click', openCreateUserModal);
  document.getElementById('userSearch').addEventListener('input', (e) => renderUsersTable(e.target.value));
  renderUsersTable('');
}

function renderUsersTable(filter) {
  const body = document.getElementById('usersBody');
  const rows = cache.users.filter((u) => u.username.toLowerCase().includes(filter.toLowerCase()));
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="text-muted">No users found.</td></tr>'; return; }
  body.innerHTML = rows.map((u) => `
    <tr>
      <td><strong>${u.username}</strong><br><span class="text-muted" style="font-size:.78rem;">${u.email || '—'}</span>${u.isAdmin ? ' <span class="badge badge-neutral">Admin</span>' : ''}</td>
      <td>${u.creditsBalance.toLocaleString()}</td>
      <td>${formatMinutes(u.secondsBalance)}</td>
      <td>${u.isSuspended ? '<span class="badge badge-danger">Suspended</span>' : '<span class="badge badge-success">Active</span>'}</td>
      <td>${u.hasActiveAccess ? '<span class="badge badge-success">Granted</span>' : '<span class="badge badge-warning">Pending</span>'}</td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
      <td class="flex gap-8">
        <button class="btn btn-outline btn-sm" onclick="openUserDetailsModal(${u.id})">Details</button>
        ${!u.isAdmin ? `
          <button class="btn btn-outline btn-sm" onclick="openAddCreditsModal(${u.id})">+ Credits</button>
          <button class="btn btn-outline btn-sm" onclick="toggleSuspend(${u.id})">${u.isSuspended ? 'Unsuspend' : 'Suspend'}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Delete</button>
        ` : ''}
      </td>
    </tr>
  `).join('');
}

function openCreateUserModal() {
  openModal(`
    <div class="modal-header"><h3>Create User</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="error-banner" id="modalError"></div>
    <form id="createUserForm">
      <div class="form-group"><label>Username</label><input type="text" id="cuUsername" required></div>
      <div class="form-group"><label>Email (optional)</label><input type="email" id="cuEmail"></div>
      <div class="form-group"><label>Password</label><input type="password" id="cuPassword" minlength="8" required></div>
      <div class="grid grid-2">
        <div class="form-group"><label>Starting Credits</label><input type="number" id="cuCredits" value="0"></div>
        <div class="form-group"><label>Starting Minutes</label><input type="number" id="cuMinutes" value="0"></div>
      </div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="cuGrantAccess" style="width:auto;"><label for="cuGrantAccess" style="margin:0;">Grant dashboard access immediately</label>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Create User</button>
    </form>
  `);
  document.getElementById('createUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: {
          username: document.getElementById('cuUsername').value,
          email: document.getElementById('cuEmail').value,
          password: document.getElementById('cuPassword').value,
          credits: document.getElementById('cuCredits').value,
          minutes: document.getElementById('cuMinutes').value,
          grantAccess: document.getElementById('cuGrantAccess').checked,
        },
      });
      closeModal();
      renderUsers();
    } catch (err) {
      const el = document.getElementById('modalError');
      el.textContent = err.message; el.classList.add('show');
    }
  });
}

function openAddCreditsModal(userId) {
  const user = cache.users.find((u) => u.id === userId);
  openModal(`
    <div class="modal-header"><h3>Add Top-Up Credits — ${user.username}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <p class="text-muted">Current: ${user.creditsBalance.toLocaleString()} credits · ${formatMinutes(user.secondsBalance)} remaining.</p>
    <form id="addCreditsForm">
      <div class="grid grid-2">
        <div class="form-group"><label>Add Credits</label><input type="number" id="addCredits" value="0"></div>
        <div class="form-group"><label>Add Minutes</label><input type="number" id="addMinutes" value="0"></div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Add Top-Up</button>
    </form>
  `);
  document.getElementById('addCreditsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch(`/api/admin/users/${userId}/credits`, {
      method: 'POST',
      body: { addCredits: document.getElementById('addCredits').value, addMinutes: document.getElementById('addMinutes').value },
    });
    closeModal();
    renderUsers();
  });
}

async function toggleSuspend(userId) {
  await apiFetch(`/api/admin/users/${userId}/suspend`, { method: 'POST' });
  renderUsers();
}
async function deleteUser(userId) {
  if (!confirm('Delete this user permanently? This cannot be undone.')) return;
  await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
  renderUsers();
}

// ===========================================================================
// PAYMENTS
// ===========================================================================
async function renderPayments() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/payments');
  cache.payments = data.submissions;

  content.innerHTML = `
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Receipt</th><th>Status</th><th>Date</th><th></th></tr></thead>
          <tbody>
            ${cache.payments.length ? cache.payments.map((s) => `
              <tr>
                <td>${s.username}</td>
                <td>${s.plan_name || '—'}<br><span class="text-muted" style="font-size:.78rem;">${s.plan_credits ?? '?'} credits · ${s.plan_minutes ?? '?'} min</span></td>
                <td>$${s.amount}</td>
                <td><a href="/api/admin/payments/${s.id}/receipt" target="_blank" class="btn btn-outline btn-sm">View</a></td>
                <td>${paymentBadge(s.status)}</td>
                <td>${new Date(s.created_at).toLocaleString()}</td>
                <td class="flex gap-8">
                  ${s.status === 'pending' ? `
                    <button class="btn btn-primary btn-sm" onclick="approvePayment(${s.id})">Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="rejectPayment(${s.id})">Reject</button>
                  ` : ''}
                </td>
              </tr>`).join('') : '<tr><td colspan="7" class="text-muted">No payment submissions yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function approvePayment(id) {
  if (!confirm('Approve this payment? Credits will be added to the user\'s account immediately.')) return;
  await apiFetch(`/api/admin/payments/${id}/approve`, { method: 'POST' });
  renderPayments();
}
async function rejectPayment(id) {
  const note = prompt('Optional note for the rejection:') || '';
  await apiFetch(`/api/admin/payments/${id}/reject`, { method: 'POST', body: { note } });
  renderPayments();
}

function openUserDetailsModal(userId) {
  // Looked up from the already-fetched list rather than passed inline —
  // embedding a full JSON object into an onclick="..." HTML attribute is
  // unsafe: any double quote inside it (which JSON.stringify produces
  // for every key/string value) prematurely closes the attribute and
  // corrupts the handler, which is exactly why this button previously
  // did nothing when clicked.
  const user = cache.users.find((u) => u.id === userId);
  if (!user) return;
  openModal(`
    <div class="modal-header"><h3>${user.username} — Full Account Details</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; font-size:.95rem;">
      <div><label style="font-weight:600; color:var(--text-muted);">Username</label><p style="margin:4px 0;">${user.username}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Email</label><p style="margin:4px 0;">${user.email || '—'}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">User ID</label><p style="margin:4px 0;">${user.id}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Status</label><p style="margin:4px 0;">${user.isSuspended ? '<span class="badge badge-danger">Suspended</span>' : '<span class="badge badge-success">Active</span>'}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Credits Balance</label><p style="margin:4px 0;">${user.creditsBalance.toLocaleString()}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Time Remaining</label><p style="margin:4px 0;">${formatMinutes(user.secondsBalance)}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Dashboard Access</label><p style="margin:4px 0;">${user.hasActiveAccess ? '<span class="badge badge-success">Granted</span>' : '<span class="badge badge-warning">Pending</span>'}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Trial Plan</label><p style="margin:4px 0;">${user.isTrialPlan ? 'Yes' : 'No'}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Account Role</label><p style="margin:4px 0;">${user.isAdmin ? '<span class="badge badge-neutral">Admin</span>' : 'User'}</p></div>
      <div><label style="font-weight:600; color:var(--text-muted);">Member Since</label><p style="margin:4px 0;">${new Date(user.createdAt).toLocaleString()}</p></div>
    </div>
    ${!user.isAdmin ? `<button class="btn btn-outline btn-block mt-16" onclick="openEditUserModal(${user.id})">✎ Edit Profile</button>` : ''}
  `);
}

/** Lets an admin edit another user's username, email, and optionally
 * force-set a new password — separate from the read-only details view
 * above, and from the admin's own self-service login change
 * (renderMyAccount), which requires the current password since that
 * one is a self-edit rather than an admin action. */
function openEditUserModal(userId) {
  const user = cache.users.find((u) => u.id === userId);
  if (!user) return;
  openModal(`
    <div class="modal-header"><h3>Edit ${user.username}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="error-banner" id="editUserError"></div>
    <form id="editUserForm">
      <div class="form-group"><label>Username</label><input type="text" id="euUsername" value="${user.username}" required></div>
      <div class="form-group"><label>Email</label><input type="email" id="euEmail" value="${user.email || ''}"></div>
      <div class="form-group"><label>Set New Password (leave blank to keep current)</label><input type="password" id="euPassword" minlength="8" placeholder="At least 8 characters"></div>
      <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
    </form>
  `);
  document.getElementById('editUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('editUserError');
    errEl.classList.remove('show');
    try {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        body: {
          username: document.getElementById('euUsername').value,
          email: document.getElementById('euEmail').value,
          newPassword: document.getElementById('euPassword').value,
        },
      });
      closeModal();
      renderUsers();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    }
  });
}



// ===========================================================================
// BROADCAST MESSAGE
// ===========================================================================
async function renderBroadcast() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = `
    <div class="card" style="max-width:600px;">
      <h3>Send Email to All Users</h3>
      <p class="text-muted">This will send an email to every user on the platform. Use carefully!</p>
      <div class="error-banner" id="broadcastError"></div>
      <div class="success-banner" id="broadcastSuccess"></div>
      <form id="broadcastForm">
        <div class="form-group">
          <label>Email Subject</label>
          <input type="text" id="bSubject" placeholder="e.g. Important Platform Update" required>
        </div>
        <div class="form-group">
          <label>Email Message</label>
          <textarea id="bMessage" placeholder="Your message here..." required style="min-height:200px;"></textarea>
        </div>
        <div class="form-group" style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="bConfirm" style="width:auto;" required>
          <label for="bConfirm" style="margin:0;">I confirm sending this to all users</label>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Send Broadcast</button>
      </form>
    </div>
  `;
  document.getElementById('broadcastForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('broadcastError');
    const okEl = document.getElementById('broadcastSuccess');
    errEl.classList.remove('show');
    okEl.classList.remove('show');
    
    if (!confirm('This will send an email to ALL users. Are you absolutely sure?')) return;
    
    try {
      await apiFetch('/api/admin/broadcast', {
        method: 'POST',
        body: { subject: document.getElementById('bSubject').value, message: document.getElementById('bMessage').value },
      });
      okEl.textContent = 'Broadcast sent successfully to all users!';
      okEl.classList.add('show');
      document.getElementById('broadcastForm').reset();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    }
  });
}

// ===========================================================================
// ACTIVITY HISTORY
// ===========================================================================
async function renderActivity() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/activity?limit=500');
  const activity = data.activity || [];

  content.innerHTML = `
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Action</th><th>Details</th><th>Date</th></tr></thead>
          <tbody>
            ${activity.length ? activity.map((a) => {
              let details = '';
              if (a.details && typeof a.details === 'string') {
                try {
                  const d = JSON.parse(a.details);
                  details = Object.entries(d).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(' | ');
                } catch (e) {
                  details = a.details;
                }
              }
              return `<tr>
                <td><strong>${a.username}</strong></td>
                <td><span class="badge badge-neutral">${a.action}</span></td>
                <td class="text-muted" style="font-size:.85rem; max-width:300px; word-break:break-word;">${details || '—'}</td>
                <td>${new Date(a.created_at).toLocaleString()}</td>
              </tr>`;
            }).join('') : '<tr><td colspan="4" class="text-muted">No activity yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ===========================================================================
// USER IMAGES GALLERY
// ===========================================================================
async function renderImages() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/images');
  const images = data.images || [];

  if (!images.length) {
    content.innerHTML = '<p class="text-muted">No images uploaded yet.</p>';
    return;
  }

  content.innerHTML = `
    <div class="card">
      <p class="text-muted mb-16">Showing ${images.length} uploaded face transformation images.</p>
      <div class="grid grid-4" id="imagesGrid"></div>
    </div>`;

  const grid = document.getElementById('imagesGrid');
  grid.innerHTML = images.map((img) => `
    <div class="card" style="cursor:pointer;" onclick="openImagePreview('${img.image_path}', '${img.username}', '${img.name}')">
      <img src="/uploads/looks/${img.image_path}" alt="${img.name}" style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:4px; margin-bottom:8px;">
      <p style="margin:0; font-size:.85rem;"><strong>${img.name}</strong></p>
      <p style="margin:0; font-size:.78rem; color:var(--text-muted);">By ${img.username}</p>
      <p style="margin:0; font-size:.78rem; color:var(--text-muted);">${new Date(img.created_at).toLocaleDateString()}</p>
    </div>
  `).join('');
}

function openImagePreview(imagePath, username, name) {
  openModal(`
    <div class="modal-header"><h3>${name} — by ${username}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <img src="/uploads/looks/${imagePath}" alt="${name}" style="width:100%; max-height:70vh; object-fit:contain; border-radius:4px;">
  `);
}


async function renderPlans() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/plans');
  cache.plans = data.plans;

  content.innerHTML = `
    <div class="flex justify-between items-center mb-16">
      <p class="text-muted" style="margin:0;">No limit on the number of plans — create as many as you need.</p>
      <button class="btn btn-primary btn-sm" onclick="openPlanModal()">+ Create Plan</button>
    </div>
    <div class="grid grid-3" id="plansContainer"></div>`;

  document.getElementById('plansContainer').innerHTML = cache.plans.map((p) => `
    <div class="card">
      <div class="flex justify-between items-start mb-8">
        <h3 style="margin-bottom:4px;">${p.name}</h3>
        <div class="flex gap-4" style="flex-wrap:wrap; justify-content:flex-end;">
          ${p.is_featured ? '<span class="badge badge-success">Featured</span>' : ''}
          ${p.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Hidden</span>'}
        </div>
      </div>
      ${p.badge_text ? `<span class="badge badge-warning">${p.badge_text}</span>` : ''}
      <div style="font-size:1.6rem; font-weight:800; color:var(--blue-900); margin:8px 0;">$${p.price}</div>
      <p style="margin:4px 0; color:var(--text-muted); font-size:.9rem;">${p.tagline || ''}</p>
      <p>${p.credits.toLocaleString()} credits · ${p.minutes} min</p>
      ${p.is_trial ? '<span class="badge badge-warning">Trial</span>' : '<span class="badge badge-neutral">Full Access</span>'}
      ${p.description ? `<p class="text-muted" style="margin-top:8px; margin-bottom:8px;">${p.description}</p>` : ''}
      ${p.features && p.features.length ? `<ul style="margin:8px 0; padding-left:16px; font-size:.85rem; color:var(--text-muted);">${p.features.map(f => `<li>${f}</li>`).join('')}</ul>` : ''}
      <div class="flex gap-8 mt-16">
        <button class="btn btn-outline btn-sm" onclick="openPlanModal(${p.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deletePlan(${p.id})">Delete</button>
      </div>
    </div>
  `).join('') || '<p class="text-muted">No plans yet — create your first one.</p>';
}

function openPlanModal(planId) {
  // Looked up by id from the cached list rather than embedded as raw
  // JSON in the onclick attribute — a plan description or feature
  // containing a quote character would otherwise corrupt the handler.
  const plan = planId != null ? cache.plans.find((x) => x.id === planId) : null;
  const p = plan || { name: '', price: '', credits: '', minutes: '', description: '', badge_text: '', tagline: '', features: '', sort_order: 0, is_active: 1, is_featured: 0, is_trial: 0, allow_top_up: 1 };
  openModal(`
    <div class="modal-header"><h3>${plan ? 'Edit' : 'Create'} Plan</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <form id="planForm">
      <div class="form-group"><label>Name</label><input type="text" id="pName" value="${p.name}" required></div>
      <div class="grid grid-2">
        <div class="form-group"><label>Price (USD)</label><input type="number" step="0.01" id="pPrice" value="${p.price}" required></div>
        <div class="form-group"><label>Sort Order</label><input type="number" id="pSort" value="${p.sort_order ?? 0}"></div>
      </div>
      <div class="grid grid-2">
        <div class="form-group"><label>Credits</label><input type="number" id="pCredits" value="${p.credits}" required></div>
        <div class="form-group"><label>Minutes</label><input type="number" step="0.1" id="pMinutes" value="${p.minutes}" required></div>
      </div>
      <div class="form-group"><label>Description (optional)</label><textarea id="pDesc" placeholder="Short description shown on the plan card">${p.description || ''}</textarea></div>
      <div class="form-group"><label>Badge Text (optional)</label><input type="text" id="pBadge" value="${p.badge_text || ''}" placeholder="e.g. Most Popular"></div>
      <div class="form-group"><label>Tagline (optional)</label><input type="text" id="pTagline" value="${p.tagline || ''}" placeholder="e.g. Best value for creators"></div>
      <div class="form-group"><label>Features (one per line, optional)</label><textarea id="pFeatures" placeholder="Access to all AI engines&#10;Full dashboard&#10;Priority support">${Array.isArray(p.features) ? p.features.join('\n') : (p.features || '')}</textarea></div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="pActive" ${p.is_active ? 'checked' : ''} style="width:auto;"><label for="pActive" style="margin:0;">Visible on payment page</label>
      </div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="pFeatured" ${p.is_featured ? 'checked' : ''} style="width:auto;"><label for="pFeatured" style="margin:0;">Highlight as featured plan</label>
      </div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="pTrial" ${p.is_trial ? 'checked' : ''} style="width:auto;"><label for="pTrial" style="margin:0;">Mark as trial plan</label>
      </div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="pTopUp" ${p.allow_top_up === undefined || p.allow_top_up ? 'checked' : ''} style="width:auto;"><label for="pTopUp" style="margin:0;">Allow top-up purchase</label>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${plan ? 'Save Changes' : 'Create Plan'}</button>
    </form>
  `);
  document.getElementById('planForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const featuresText = document.getElementById('pFeatures').value.split('\n').filter(f => f.trim());
    const body = {
      name: document.getElementById('pName').value,
      price: document.getElementById('pPrice').value,
      credits: document.getElementById('pCredits').value,
      minutes: document.getElementById('pMinutes').value,
      description: document.getElementById('pDesc').value,
      badgeText: document.getElementById('pBadge').value,
      tagline: document.getElementById('pTagline').value,
      features: featuresText,
      sortOrder: document.getElementById('pSort').value,
      isActive: document.getElementById('pActive').checked,
      isFeatured: document.getElementById('pFeatured').checked,
      isTrial: document.getElementById('pTrial').checked,
      allowTopUp: document.getElementById('pTopUp').checked,
    };
    if (plan) await apiFetch(`/api/admin/plans/${plan.id}`, { method: 'PUT', body });
    else await apiFetch('/api/admin/plans', { method: 'POST', body });
    closeModal();
    renderPlans();
  });
}

async function deletePlan(id) {
  if (!confirm('Delete this plan? It will no longer appear on the payment page.')) return;
  await apiFetch(`/api/admin/plans/${id}`, { method: 'DELETE' });
  renderPlans();
}

// ===========================================================================
// CREDIT TOP-UP PLANS
// Top-up plans are only ever shown to users who already have an active
// account (see payment-topup.html) — they're separate from the
// activation plans above, which is why they live in their own table
// (topup_plans) and their own admin section here.
// ===========================================================================
async function renderTopupPlans() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/topup-plans');
  cache.topupPlans = data.plans;

  content.innerHTML = `
    <div class="flex justify-between items-center mb-16">
      <p class="text-muted" style="margin:0;">These only appear to users who already have an active account — no limit on how many you create.</p>
      <button class="btn btn-primary btn-sm" onclick="openTopupPlanModal()">+ Create Top-Up Plan</button>
    </div>
    <div class="grid grid-3" id="topupPlansContainer"></div>`;

  document.getElementById('topupPlansContainer').innerHTML = cache.topupPlans.map((p) => `
    <div class="card">
      <div class="flex justify-between items-start mb-8">
        <h3 style="margin-bottom:4px;">${p.name}</h3>
        <div class="flex gap-4" style="flex-wrap:wrap; justify-content:flex-end;">
          ${p.is_featured ? '<span class="badge badge-success">Featured</span>' : ''}
          ${p.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Hidden</span>'}
        </div>
      </div>
      ${p.badge_text ? `<span class="badge badge-warning">${p.badge_text}</span>` : ''}
      <div style="font-size:1.6rem; font-weight:800; color:var(--blue-900); margin:8px 0;">$${p.price}</div>
      <p style="margin:4px 0; color:var(--text-muted); font-size:.9rem;">${p.tagline || ''}</p>
      <p>${p.credits.toLocaleString()} credits · ${p.minutes} min</p>
      ${p.description ? `<p class="text-muted" style="margin-top:8px; margin-bottom:8px;">${p.description}</p>` : ''}
      ${p.features && p.features.length ? `<ul style="margin:8px 0; padding-left:16px; font-size:.85rem; color:var(--text-muted);">${p.features.map(f => `<li>${f}</li>`).join('')}</ul>` : ''}
      <div class="flex gap-8 mt-16">
        <button class="btn btn-outline btn-sm" onclick="openTopupPlanModal(${p.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTopupPlan(${p.id})">Delete</button>
      </div>
    </div>
  `).join('') || '<p class="text-muted">No top-up plans yet — create your first one so users can buy more credits after they\'re already active.</p>';
}

function openTopupPlanModal(planId) {
  const plan = planId != null ? cache.topupPlans.find((x) => x.id === planId) : null;
  const p = plan || { name: '', price: '', credits: '', minutes: '', description: '', badge_text: '', tagline: '', features: '', sort_order: 0, is_active: 1, is_featured: 0 };
  openModal(`
    <div class="modal-header"><h3>${plan ? 'Edit' : 'Create'} Top-Up Plan</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <form id="topupPlanForm">
      <div class="form-group"><label>Name</label><input type="text" id="tName" value="${p.name}" required></div>
      <div class="grid grid-2">
        <div class="form-group"><label>Price (USD)</label><input type="number" step="0.01" id="tPrice" value="${p.price}" required></div>
        <div class="form-group"><label>Sort Order</label><input type="number" id="tSort" value="${p.sort_order ?? 0}"></div>
      </div>
      <div class="grid grid-2">
        <div class="form-group"><label>Credits</label><input type="number" id="tCredits" value="${p.credits}" required></div>
        <div class="form-group"><label>Minutes</label><input type="number" step="0.1" id="tMinutes" value="${p.minutes}" required></div>
      </div>
      <div class="form-group"><label>Description (optional)</label><textarea id="tDesc" placeholder="Short description shown on the plan card">${p.description || ''}</textarea></div>
      <div class="form-group"><label>Badge Text (optional)</label><input type="text" id="tBadge" value="${p.badge_text || ''}" placeholder="e.g. Best Value"></div>
      <div class="form-group"><label>Tagline (optional)</label><input type="text" id="tTagline" value="${p.tagline || ''}" placeholder="e.g. Quick top-up for a short session"></div>
      <div class="form-group"><label>Features (one per line, optional)</label><textarea id="tFeatures" placeholder="Instant activation&#10;No expiry">${Array.isArray(p.features) ? p.features.join('\n') : (p.features || '')}</textarea></div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="tActive" ${p.is_active ? 'checked' : ''} style="width:auto;"><label for="tActive" style="margin:0;">Visible on the top-up page</label>
      </div>
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="tFeatured" ${p.is_featured ? 'checked' : ''} style="width:auto;"><label for="tFeatured" style="margin:0;">Highlight as featured plan</label>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${plan ? 'Save Changes' : 'Create Top-Up Plan'}</button>
    </form>
  `);
  document.getElementById('topupPlanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const featuresText = document.getElementById('tFeatures').value.split('\n').filter(f => f.trim());
    const body = {
      name: document.getElementById('tName').value,
      price: document.getElementById('tPrice').value,
      credits: document.getElementById('tCredits').value,
      minutes: document.getElementById('tMinutes').value,
      description: document.getElementById('tDesc').value,
      badgeText: document.getElementById('tBadge').value,
      tagline: document.getElementById('tTagline').value,
      features: featuresText,
      sortOrder: document.getElementById('tSort').value,
      isActive: document.getElementById('tActive').checked,
      isFeatured: document.getElementById('tFeatured').checked,
    };
    try {
      if (plan) await apiFetch(`/api/admin/topup-plans/${plan.id}`, { method: 'PUT', body });
      else await apiFetch('/api/admin/topup-plans', { method: 'POST', body });
      closeModal();
      renderTopupPlans();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function deleteTopupPlan(id) {
  if (!confirm('Delete this top-up plan? It will no longer appear on the top-up page.')) return;
  await apiFetch(`/api/admin/topup-plans/${id}`, { method: 'DELETE' });
  renderTopupPlans();
}

// ===========================================================================
// PAYMENT METHODS
// ===========================================================================
async function renderMethods() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/payment-methods');
  cache.methods = data.methods;
  const banks = cache.methods.filter((m) => m.method_type === 'bank');
  const cryptos = cache.methods.filter((m) => m.method_type === 'crypto');

  content.innerHTML = `
    <div class="card mb-24">
      <div class="flex justify-between items-center mb-16">
        <h3 style="margin:0;">Bank Accounts (${banks.length}/3)</h3>
        <button class="btn btn-primary btn-sm" ${banks.length >= 3 ? 'disabled' : ''} onclick="openMethodModal('bank')">+ Add Bank Account</button>
      </div>
      <div id="banksContainer" class="grid grid-3"></div>
    </div>
    <div class="card">
      <div class="flex justify-between items-center mb-16">
        <h3 style="margin:0;">Cryptocurrency Methods (${cryptos.length}/4)</h3>
        <button class="btn btn-primary btn-sm" ${cryptos.length >= 4 ? 'disabled' : ''} onclick="openMethodModal('crypto')">+ Add Crypto Method</button>
      </div>
      <div id="cryptosContainer" class="grid grid-3"></div>
    </div>`;

  document.getElementById('banksContainer').innerHTML = banks.map(methodCard).join('') || '<p class="text-muted">No bank accounts configured yet.</p>';
  document.getElementById('cryptosContainer').innerHTML = cryptos.map(methodCard).join('') || '<p class="text-muted">No crypto methods configured yet.</p>';
}

function methodCard(m) {
  const details = m.method_type === 'bank'
    ? `${m.bank_name}<br>${m.account_name}<br>${m.account_number}`
    : `${m.crypto_currency}<br><code style="word-break:break-all; font-size:.78rem;">${m.wallet_address}</code>`;
  return `
    <div class="card">
      <div class="flex justify-between items-start">
        <strong>${m.label || (m.method_type === 'bank' ? m.bank_name : m.crypto_currency)}</strong>
        ${m.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Hidden</span>'}
      </div>
      <p class="mt-8" style="font-size:.88rem;">${details}</p>
      <div class="flex gap-8">
        <button class="btn btn-outline btn-sm" onclick="openMethodModal('${m.method_type}', ${m.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMethod(${m.id})">Delete</button>
      </div>
    </div>`;
}

function openMethodModal(type, methodId) {
  const method = methodId != null ? cache.methods.find((x) => x.id === methodId) : null;
  const m = method || {};
  const bankFields = `
    <div class="form-group"><label>Bank Name</label><input type="text" id="mBankName" value="${m.bank_name || ''}"></div>
    <div class="form-group"><label>Account Name</label><input type="text" id="mAccountName" value="${m.account_name || ''}"></div>
    <div class="form-group"><label>Account Number</label><input type="text" id="mAccountNumber" value="${m.account_number || ''}"></div>
    <div class="form-group"><label>Routing / SWIFT (optional)</label><input type="text" id="mRoutingSwift" value="${m.routing_swift || ''}"></div>`;
  const cryptoFields = `
    <div class="form-group"><label>Currency</label>
      <select id="mCryptoCurrency">
        ${['BTC', 'USDT', 'Ethereum', 'Solana'].map((c) => `<option value="${c}" ${m.crypto_currency === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </div>
    <div class="form-group"><label>Wallet Address</label><input type="text" id="mWalletAddress" value="${m.wallet_address || ''}"></div>
    <div class="form-group"><label>Network Note (optional)</label><input type="text" id="mNetworkNote" value="${m.network_note || ''}" placeholder="e.g. USDT (TRC20) only"></div>`;

  openModal(`
    <div class="modal-header"><h3>${method ? 'Edit' : 'Add'} ${type === 'bank' ? 'Bank Account' : 'Crypto Method'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <form id="methodForm">
      <div class="form-group"><label>Display Label (optional)</label><input type="text" id="mLabel" value="${m.label || ''}"></div>
      ${type === 'bank' ? bankFields : cryptoFields}
      <div class="form-group" style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="mActive" ${m.is_active !== 0 ? 'checked' : ''} style="width:auto;"><label for="mActive" style="margin:0;">Visible to users</label>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${method ? 'Save Changes' : 'Add Method'}</button>
    </form>
  `);

  document.getElementById('methodForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      methodType: type,
      label: document.getElementById('mLabel').value,
      isActive: document.getElementById('mActive').checked,
      ...(type === 'bank' ? {
        bankName: document.getElementById('mBankName').value,
        accountName: document.getElementById('mAccountName').value,
        accountNumber: document.getElementById('mAccountNumber').value,
        routingSwift: document.getElementById('mRoutingSwift').value,
      } : {
        cryptoCurrency: document.getElementById('mCryptoCurrency').value,
        walletAddress: document.getElementById('mWalletAddress').value,
        networkNote: document.getElementById('mNetworkNote').value,
      }),
    };
    try {
      if (method) await apiFetch(`/api/admin/payment-methods/${method.id}`, { method: 'PUT', body });
      else await apiFetch('/api/admin/payment-methods', { method: 'POST', body });
      closeModal();
      renderMethods();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function deleteMethod(id) {
  if (!confirm('Delete this payment method?')) return;
  await apiFetch(`/api/admin/payment-methods/${id}`, { method: 'DELETE' });
  renderMethods();
}

// ===========================================================================
// PLATFORM SETTINGS (Decart key, Telegram username, credit rate)
// ===========================================================================
async function renderSettings() {
  const content = document.getElementById('sectionContent');
  content.innerHTML = '<p class="text-muted">Loading…</p>';
  const data = await apiFetch('/api/admin/settings');
  const s = data.settings;

  content.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Decart AI Engine</h3>
        <p class="text-muted">The API key used to generate realtime streaming tokens for every user's Studio session. Leave blank to keep using the current key.</p>
        <form id="decartForm">
          <div class="form-group"><label>Decart API Key</label><input type="password" id="decartKey" placeholder="${s.decart_api_key_masked || 'Not set — using .env fallback'}"></div>
          <button type="submit" class="btn btn-primary">Save Key</button>
        </form>
      </div>
      <div class="card">
        <h3>Support Contact</h3>
        <p class="text-muted">The Telegram username that receives Contact Us submissions from the homepage.</p>
        <form id="telegramForm">
          <div class="form-group"><label>Telegram Username</label><input type="text" id="telegramUsername" value="${s.support_telegram_username || ''}" placeholder="e.g. creoveya_support"></div>
          <button type="submit" class="btn btn-primary">Save Username</button>
        </form>
      </div>
      <div class="card">
        <h3>Global Credit Rate</h3>
        <p class="text-muted">The single conversion rate used everywhere credits are deducted for live streaming time, so the numbers on plans, the dashboard, and actual usage always stay consistent.</p>
        <form id="rateForm">
          <div class="form-group"><label>Credits per minute of streaming</label><input type="number" step="0.1" id="creditsPerMinute" value="${s.credits_per_minute}"></div>
          <button type="submit" class="btn btn-primary">Save Rate</button>
        </form>
      </div>
      <div class="card">
        <h3>Site Name</h3>
        <form id="siteNameForm">
          <div class="form-group"><label>Site Name</label><input type="text" id="siteName" value="${s.site_name}"></div>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
      </div>
    </div>`;

  document.getElementById('decartForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/admin/settings', { method: 'POST', body: { decartApiKey: document.getElementById('decartKey').value } });
    alert('Decart API key updated.');
    renderSettings();
  });
  document.getElementById('telegramForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/admin/settings', { method: 'POST', body: { supportTelegramUsername: document.getElementById('telegramUsername').value } });
    alert('Telegram username updated.');
  });
  document.getElementById('rateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/admin/settings', { method: 'POST', body: { creditsPerMinute: document.getElementById('creditsPerMinute').value } });
    alert('Credit rate updated.');
  });
  document.getElementById('siteNameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/admin/settings', { method: 'POST', body: { siteName: document.getElementById('siteName').value } });
    alert('Site name updated.');
  });
}

async function renderMyAccount() {
  const content = document.getElementById('sectionContent');
  const me = await apiFetch('/api/me');
  const u = me.user;

  content.innerHTML = `
    <div class="card" style="max-width: 480px;">
      <h3>Change Your Login</h3>
      <p class="text-muted">Confirm your current password to change your username, email, or password.</p>
      <div class="error-banner" id="myAccountError"></div>
      <div class="success-banner" id="myAccountSuccess"></div>
      <form id="myAccountForm">
        <div class="form-group"><label>Username</label><input type="text" id="maUsername" value="${u.username}" required></div>
        <div class="form-group"><label>Email</label><input type="email" id="maEmail" value="${u.email || ''}"></div>
        <div class="form-group"><label>New Password (leave blank to keep current)</label><input type="password" id="maNewPassword" minlength="8" placeholder="At least 8 characters"></div>
        <div class="form-group"><label>Current Password (required to save)</label><input type="password" id="maCurrentPassword" required></div>
        <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
      </form>
    </div>`;

  document.getElementById('myAccountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('myAccountError');
    const okEl = document.getElementById('myAccountSuccess');
    errEl.classList.remove('show');
    okEl.classList.remove('show');
    try {
      await apiFetch('/api/admin/my-account', {
        method: 'POST',
        body: {
          currentPassword: document.getElementById('maCurrentPassword').value,
          newUsername: document.getElementById('maUsername').value,
          newEmail: document.getElementById('maEmail').value,
          newPassword: document.getElementById('maNewPassword').value,
        },
      });
      okEl.textContent = 'Your login details have been updated.';
      okEl.classList.add('show');
      document.getElementById('maCurrentPassword').value = '';
      document.getElementById('maNewPassword').value = '';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    }
  });
}

init();
