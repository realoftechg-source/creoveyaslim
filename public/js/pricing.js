document.getElementById('year').textContent = new Date().getFullYear();

async function loadActivationPlans() {
  const grid = document.getElementById('plansGrid');
  try {
    const data = await apiFetch('/api/payments/plans');
    if (!data.plans.length) {
      grid.innerHTML = '<p class="text-muted text-center">No plans are available right now — check back soon.</p>';
      return;
    }
    grid.innerHTML = data.plans.map((p) => `
      <div class="card">
        ${p.badgeText ? `<span class="badge badge-warning" style="margin-bottom:10px;">${p.badgeText}</span>` : ''}
        <h3>${p.name}</h3>
        <div style="font-size:2rem; font-weight:800; color:var(--blue-900); margin-bottom:6px;">$${p.price}</div>
        ${p.tagline ? `<p class="text-muted" style="margin-bottom:6px;">${p.tagline}</p>` : ''}
        <p>${p.credits.toLocaleString()} credits · ≈ ${p.minutes} minutes of live streaming</p>
        ${p.description ? `<p class="text-muted">${p.description}</p>` : ''}
        ${p.features && p.features.length ? `<ul style="margin:12px 0; padding-left:18px; font-size:.9rem; color:var(--text-secondary);">${p.features.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
        <a href="/login.html" class="btn btn-outline btn-block">Choose ${p.name}</a>
      </div>
    `).join('');
  } catch (e) {
    grid.innerHTML = '<p class="text-muted text-center">Could not load plans right now.</p>';
  }
}

async function loadTopupPlans() {
  const grid = document.getElementById('topupPlansGrid');
  const section = document.getElementById('topup-plans');
  try {
    const user = await getSession();
    if (!user || !user.hasActiveAccess || user.isTrialPlan) {
      section.classList.add('hidden');
      return;
    }
    const data = await apiFetch('/api/payments/topup-plans');
    if (!data.plans.length) {
      section.classList.add('hidden');
      return;
    }
    grid.innerHTML = data.plans.map((p) => `
      <div class="card">
        ${p.badgeText ? `<span class="badge badge-warning" style="margin-bottom:10px;">${p.badgeText}</span>` : ''}
        <h3>${p.name}</h3>
        <div style="font-size:1.6rem; font-weight:800; color:var(--blue-900); margin-bottom:6px;">$${p.price}</div>
        ${p.tagline ? `<p class="text-muted" style="margin-bottom:6px; font-size:.88rem;">${p.tagline}</p>` : ''}
        <p style="font-size:.92rem;">${p.credits.toLocaleString()} credits · ≈ ${p.minutes} min</p>
        ${p.description ? `<p class="text-muted" style="font-size:.85rem;">${p.description}</p>` : ''}
        ${p.features && p.features.length ? `<ul style="margin:12px 0; padding-left:18px; font-size:.9rem; color:var(--text-secondary);">${p.features.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
        <a href="/login.html" class="btn btn-outline btn-block">Choose ${p.name}</a>
      </div>
    `).join('');
  } catch (e) {
    grid.innerHTML = '<p class="text-muted text-center">Could not load top-up plans right now.</p>';
  }
}

loadActivationPlans();
loadTopupPlans();


