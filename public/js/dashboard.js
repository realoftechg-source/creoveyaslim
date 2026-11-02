async function init() {
  let user;
  try {
    user = await renderUserChrome();
  } catch (err) {
    console.error('[dashboard] renderUserChrome failed:', err);
    document.getElementById('sidebar').innerHTML = '';
    document.querySelector('.app-content').innerHTML = '<div class="error-banner show">Something went wrong loading your dashboard. Please refresh the page.</div>';
    return;
  }
  if (!user) return;

  document.getElementById('welcomeName').textContent = `, ${user.username}`;
  document.getElementById('statCredits').textContent = user.creditsBalance.toLocaleString();
  document.getElementById('statMinutes').textContent = formatMinutes(user.secondsBalance);
  document.getElementById('statStatus').innerHTML = user.isSuspended
    ? '<span class="badge badge-danger">Suspended</span>'
    : '<span class="badge badge-success">Active</span>';

  if (user.secondsBalance > 0 && user.secondsBalance < 90) {
    document.getElementById('lowBalanceCard').classList.remove('hidden');
  }
  if (user.secondsBalance <= 0) {
    const card = document.getElementById('lowBalanceCard');
    card.classList.remove('hidden');
    card.querySelector('p').innerHTML = "You've used up all your streaming time. <a href=\"/payment-topup.html\">Purchase another credit plan</a> to keep using the AI studio.";
  }

  try {
    const looksData = await apiFetch('/api/studio/looks');
    document.getElementById('statLooks').textContent = looksData.looks.length;
  } catch (e) { /* ignore */ }

  try {
    const subs = await apiFetch('/api/payments/my-submissions');
    const body = document.getElementById('historyBody');
    if (!subs.submissions.length) {
      body.innerHTML = '<tr><td colspan="4" class="text-muted">No payments yet.</td></tr>';
    } else {
      body.innerHTML = subs.submissions.map((s) => `
        <tr>
          <td>${s.plan_name || '—'}</td>
          <td>$${s.amount}</td>
          <td>${statusBadge(s.status)}</td>
          <td>${new Date(s.created_at).toLocaleDateString()}</td>
        </tr>
      `).join('');
    }
  } catch (e) {
    document.getElementById('historyBody').innerHTML = '<tr><td colspan="4" class="text-muted">Could not load payment history.</td></tr>';
  }

  initProfileForm(user);
}

function initProfileForm(user) {
  document.getElementById('profUsername').value = user.username;
  document.getElementById('profEmail').value = user.email || '';

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('profileError');
    const okEl = document.getElementById('profileSuccess');
    errEl.classList.remove('show');
    okEl.classList.remove('show');
    try {
      await apiFetch('/api/me/update', {
        method: 'POST',
        body: {
          currentPassword: document.getElementById('profCurrentPassword').value,
          newUsername: document.getElementById('profUsername').value,
          newEmail: document.getElementById('profEmail').value,
          newPassword: document.getElementById('profNewPassword').value,
        },
      });
      okEl.textContent = 'Your profile has been updated.';
      okEl.classList.add('show');
      document.getElementById('profCurrentPassword').value = '';
      document.getElementById('profNewPassword').value = '';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    }
  });
}

function statusBadge(status) {
  if (status === 'approved') return '<span class="badge badge-success">Approved</span>';
  if (status === 'rejected') return '<span class="badge badge-danger">Rejected</span>';
  return '<span class="badge badge-warning">Pending</span>';
}

init();
