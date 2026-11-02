document.getElementById('year').textContent = new Date().getFullYear();

// -----------------------------------------------------------------------
// Global live-activity toast — fixed to the bottom-left of the viewport,
// cycling through 40 activity lines.
// -----------------------------------------------------------------------
const CITIES = ['Lagos', 'Manila', 'London', 'Austin', 'Nairobi', 'Toronto', 'Berlin', 'Jakarta', 'Cairo', 'Mumbai', 'São Paulo', 'Accra', 'Dubai', 'Karachi', 'Seoul', 'Nairobi', 'Bristol', 'Ontario', 'Kigali', 'Warsaw'];
const ACTIONS = [
  'started an AI live session', 'switched to the Cyberpunk look', 'went live in 1080p',
  'connected OBS via Browser Source', 'started a teaching session', 'topped up their credits',
  'created a new account', 'uploaded a custom reference face', 'approved a bank transfer payment',
  'went live on the Creator plan', 'shared their stream link', 'joined Creoveya',
  'switched to the Android look', 'hit 20 minutes of live streaming', 'connected a second camera',
  'started streaming from mobile', 'reached 100 viewers', 'upgraded from Starter to Creator',
  'enabled enhance mode', 'saved a new custom look',
];
function buildActivityMessages(count) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const city = CITIES[i % CITIES.length];
    const action = ACTIONS[(i * 7 + 3) % ACTIONS.length];
    messages.push(`Someone in ${city} just ${action}`);
  }
  return messages;
}
const ACTIVITY_MESSAGES = buildActivityMessages(40);

function initLiveActivityToast() {
  let idx = 0;
  let dismissed = false;
  let toastEl = null;

  function showNext() {
    if (dismissed) return;
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'live-activity-toast';
    toastEl.innerHTML = `
      <span class="dot"></span>
      <div><strong>Live Activity</strong><span>${ACTIVITY_MESSAGES[idx % ACTIVITY_MESSAGES.length]}</span></div>
      <button class="close-x" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(toastEl);
    toastEl.querySelector('.close-x').addEventListener('click', () => {
      dismissed = true;
      toastEl.remove();
    });
    idx += 1;
  }

  showNext();
  setInterval(showNext, 4500);
}
initLiveActivityToast();

// -----------------------------------------------------------------------
// Mobile nav toggle (uses inline style so it works regardless of the
// desktop/mobile media-query default for .nav-links)
// -----------------------------------------------------------------------

