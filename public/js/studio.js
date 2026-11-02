let currentUser = null;
let localStream = null;
let realtimeSession = null;
let heartbeatTimer = null;
let clockTimer = null;
let secondsRemaining = 0;
let secondsElapsedThisSession = 0;
let selectedLook = null; // { id, name, prompt } or null = "My Camera" (live prompt box only)
let decartClient = null;
let referenceImageRef = null;
let mirrored = false;
let selectedCameraId = '';
let selectedMicId = '';

const cameraWrap = document.getElementById('cameraWrap');
const localPreview = document.getElementById('localPreview');
const transformedFeed = document.getElementById('transformedFeed');
const placeholder = document.getElementById('cameraPlaceholder');
const liveBadge = document.getElementById('liveBadge');
const timerBadge = document.getElementById('timerBadge');
const goLiveBtn = document.getElementById('goLiveBtn');
const usageBanner = document.getElementById('usageBanner');
const cameraControls = document.getElementById('cameraControls');

async function init() {
  // Defensive by design: a failure anywhere in chrome-rendering or
  // loading saved looks must never be allowed to prevent the core
  // controls (Go Live, Select Face, mic/mirror/fullscreen) from being
  // wired up. A single unrelated bug previously took down the entire
  // page's interactivity this way — see initProfileMenu fix in
  // common.js — so every step here is isolated and bindControls() is
  // guaranteed to run regardless of what else fails.
  try {
    currentUser = await renderUserChrome();
  } catch (err) {
    console.error('[studio] renderUserChrome failed — continuing so core controls still work:', err);
  }
  if (!currentUser) {
    bindControls();
    return;
  }
  secondsRemaining = currentUser.secondsBalance;
  updateUsageBanner();
  try {
    await loadLooks();
  } catch (err) {
    console.error('[studio] loadLooks failed — continuing so core controls still work:', err);
  }
  bindControls();
  refreshDeviceLists();
  // Device labels are blank until permission has been granted at least
  // once — re-populate with real labels the moment that happens, and
  // keep the list current if a camera/mic is plugged or unplugged.
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDeviceLists);
}

// ---------------------------------------------------------------------
// Camera / microphone device selection
// ---------------------------------------------------------------------
async function refreshDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === 'videoinput');
    const mics = devices.filter((d) => d.kind === 'audioinput');

    const cameraSelect = document.getElementById('cameraSelect');
    const micSelect = document.getElementById('micSelect');

    cameraSelect.innerHTML = '<option value="">Default camera</option>' +
      cameras.map((d, i) => `<option value="${d.deviceId}">${d.label || `Camera ${i + 1}`}</option>`).join('');
    micSelect.innerHTML = '<option value="">Default microphone</option>' +
      mics.map((d, i) => `<option value="${d.deviceId}">${d.label || `Microphone ${i + 1}`}</option>`).join('');

    if (selectedCameraId) cameraSelect.value = selectedCameraId;
    if (selectedMicId) micSelect.value = selectedMicId;
  } catch (err) {
    console.error('[studio] Could not list devices:', err);
  }
}

function videoConstraints(extra = {}) {
  return selectedCameraId ? { deviceId: { exact: selectedCameraId }, ...extra } : { ...extra };
}
function audioConstraints() {
  return selectedMicId ? { deviceId: { exact: selectedMicId } } : true;
}

async function requestCameraStream(extraVideo = {}) {
  const attempts = [];
  if (selectedCameraId) attempts.push(videoConstraints(extraVideo));
  attempts.push({ ...extraVideo });
  attempts.push(true);

  let lastError;
  for (const video of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      if (video !== attempts[0]) {
        selectedCameraId = '';
        document.getElementById('cameraSelect').value = '';
      }
      return stream;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function mediaAccessMessage(err) {
  const messages = {
    NotAllowedError: 'Camera or microphone permission was denied. Allow both for Creoveya in your browser site settings, then try again.',
    PermissionDeniedError: 'Camera or microphone permission was denied. Allow both for Creoveya in your browser site settings, then try again.',
    NotFoundError: 'No camera or microphone was found. Connect a device and try again.',
    DevicesNotFoundError: 'No camera or microphone was found. Connect a device and try again.',
    NotReadableError: 'Chrome cannot open the camera. It may be blocked by Windows privacy settings, a camera shutter, a driver issue, or a hidden browser tab. Check Windows camera access and reload Chrome.',
    TrackStartError: 'Chrome cannot open the camera. It may be blocked by Windows privacy settings, a camera shutter, a driver issue, or a hidden browser tab. Check Windows camera access and reload Chrome.',
    OverconstrainedError: 'The selected camera or microphone is no longer available. Choose Default device and try again.',
    ConstraintNotSatisfiedError: 'The selected camera or microphone is no longer available. Choose Default device and try again.',
    SecurityError: 'The browser blocked camera access for this site. Open Creoveya over HTTPS and allow camera and microphone access.',
  };
  return messages[err?.name] || 'Could not access your camera/microphone. Check browser permissions, connected devices, and that you are using HTTPS, then try again.';
}

function updateUsageBanner() {
  if (secondsRemaining <= 0) {
    usageBanner.textContent = "You're out of streaming time. Purchase another credit plan to keep going live.";
    usageBanner.classList.add('show');
    goLiveBtn.disabled = true;
  } else if (secondsRemaining < 60) {
    usageBanner.textContent = `Heads up — you have less than a minute of streaming time left (${secondsRemaining}s).`;
    usageBanner.classList.add('show');
  } else {
    usageBanner.classList.remove('show');
    goLiveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Camera preview (local, pre-stream)
// ---------------------------------------------------------------------
document.getElementById('previewBtn').addEventListener('click', async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    alert('Camera access requires HTTPS (or localhost). Open Creoveya using its HTTPS URL and try again.');
    return;
  }

  try {
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    localStream = await requestCameraStream();
    localPreview.srcObject = localStream;
    localPreview.style.display = 'block';
    placeholder.style.display = 'none';
    cameraControls.classList.remove('hidden');
    // Device labels are empty until permission is granted — refresh now
    // that we have it, so the dropdowns show real camera/mic names.
    refreshDeviceLists();
  } catch (err) {
    console.error('[studio] Could not access camera/microphone:', {
      name: err?.name,
      message: err?.message,
      constraint: err?.constraint,
      secureContext: window.isSecureContext,
      url: window.location.href,
    });

    alert(mediaAccessMessage(err));
  }
});

/** Restarts whatever's currently active (idle preview or a live Decart
 * session) using the newly selected device — so switching cameras/mics
 * mid-session actually takes effect immediately, like real streaming
 * software, rather than only applying next time the page is reloaded. */
async function switchActiveDevice() {
  const wasLive = Boolean(realtimeSession);
  const wasPreviewing = Boolean(localStream) && !wasLive;

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  if (wasLive) {
    await stopLiveStream('device_switch', true);
    await goLive();
  } else if (wasPreviewing) {
    document.getElementById('previewBtn').click();
  }
}

document.getElementById('cameraSelect').addEventListener('change', (e) => {
  selectedCameraId = e.target.value;
  switchActiveDevice();
});
document.getElementById('micSelect').addEventListener('change', (e) => {
  selectedMicId = e.target.value;
  switchActiveDevice();
});

function bindControls() {
  document.getElementById('mirrorBtn').addEventListener('click', () => {
    mirrored = !mirrored;
    cameraWrap.classList.toggle('mirrored', mirrored);
  });

  document.getElementById('micBtn').addEventListener('click', (e) => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.target.style.opacity = track.enabled ? '1' : '.4';
  });

  // Pseudo-fullscreen toggle — deliberately CSS-only, not the native
  // Fullscreen API (see the comment on .pseudo-fullscreen in style.css
  // for why: this keeps the OS taskbar and browser/window chrome
  // visible on desktop, works identically on mobile, and — critically —
  // works reliably inside the Electron desktop app, where the native
  // API was inconsistent.
  const fsBtn = document.getElementById('fullscreenBtn');
  const exitFsBtn = document.getElementById('exitFullscreenBtn');

  function setPseudoFullscreen(on) {
    cameraWrap.classList.toggle('pseudo-fullscreen', on);
    document.body.classList.toggle('pseudo-fullscreen-lock', on);
    fsBtn.textContent = on ? '⤡' : '⤢';
    fsBtn.title = on ? 'Exit fullscreen' : 'Toggle fullscreen';
  }

  fsBtn.addEventListener('click', () => {
    setPseudoFullscreen(!cameraWrap.classList.contains('pseudo-fullscreen'));
  });
  exitFsBtn.addEventListener('click', () => setPseudoFullscreen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cameraWrap.classList.contains('pseudo-fullscreen')) {
      setPseudoFullscreen(false);
    }
  });

  document.getElementById('promptInput').addEventListener('input', () => {
    if (realtimeSession) updatePipelineParameters();
  });

  goLiveBtn.addEventListener('click', () => {
    if (realtimeSession) stopLiveStream('user_stopped');
    else goLive();
  });

  document.getElementById('addLookBtn').addEventListener('click', () => {
    document.getElementById('lookModalBackdrop').classList.add('open');
  });
  document.getElementById('lookModalClose').addEventListener('click', () => {
    document.getElementById('lookModalBackdrop').classList.remove('open');
  });
  document.getElementById('lookForm').addEventListener('submit', submitLook);

  document.getElementById('shareBtn').addEventListener('click', () => {
    const url = `${window.location.origin}/obs`;
    document.getElementById('obsLinkInput').value = url;
    document.getElementById('obsModalBackdrop').classList.add('open');
  });
  document.getElementById('obsModalClose').addEventListener('click', () => {
    document.getElementById('obsModalBackdrop').classList.remove('open');
  });
  document.getElementById('obsCopyBtn').addEventListener('click', async (e) => {
    const input = document.getElementById('obsLinkInput');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy Link'; }, 1500);
    } catch (err) {
      // Clipboard API can be blocked in some contexts — the input is
      // still selected/readonly, so Ctrl+C works as a fallback.
    }
  });
}

// ---------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------
const escLook = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadLooks() {
  const data = await apiFetch('/api/studio/looks');
  const grid = document.getElementById('lookGrid');
  const cards = [{ id: null, name: 'My Camera', builtin: true }, ...data.looks];
  grid.innerHTML = cards.map((look) => `
    <div class="look-card ${selectedLook?.id === look.id ? 'active' : ''}" data-look="${look.id ?? ''}">
      <div class="look-avatar">${look.builtin ? '📷' : `<img src="/api/studio/looks/${look.id}/image" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`}</div>
      <span>${escLook(look.name)}</span>
      ${look.builtin ? '' : `<button type="button" class="look-delete-btn" data-delete-look="${look.id}" aria-label="Delete ${escLook(look.name)}" title="Delete saved face">Delete</button>`}
    </div>
  `).join('');
  grid.querySelectorAll('[data-look]').forEach((el) => {
    el.addEventListener('click', () => selectLook(el.dataset.look || null));
  });
  grid.querySelectorAll('[data-delete-look]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteLook(button.dataset.deleteLook);
    });
  });
}

async function deleteLook(lookId) {
  const look = document.querySelector(`[data-look="${CSS.escape(String(lookId))}"]`);
  const lookName = look?.querySelector('span')?.textContent || 'this saved face';
  if (!window.confirm(`Delete ${lookName}? This cannot be undone.`)) return;

  try {
    await apiFetch(`/api/studio/looks/${lookId}`, { method: 'DELETE' });
    if (selectedLook?.id === Number(lookId)) {
      selectedLook = null;
      referenceImageRef = null;
      if (realtimeSession) await updatePipelineParameters();
    }
    await loadLooks();
  } catch (err) {
    alert(err.message || 'Could not delete this saved face. Please try again.');
  }
}

async function selectLook(lookId) {
  if (!lookId) {
    selectedLook = null;
    referenceImageRef = null;
    document.querySelectorAll('[data-look]').forEach((el) => el.classList.toggle('active', el.dataset.look === ''));
    if (realtimeSession) updatePipelineParameters();
    return;
  }
  try {
    const data = await apiFetch(`/api/studio/looks/${lookId}/select`, { method: 'POST' });
    selectedLook = data.look;
    referenceImageRef = null;
    if (realtimeSession && decartClient) await loadReferenceImage(decartClient);
    document.querySelectorAll('[data-look]').forEach((el) => el.classList.toggle('active', el.dataset.look === String(lookId)));
    if (realtimeSession) updatePipelineParameters();
  } catch (err) {
    if (err.data?.code === 'no_balance') showOutOfBalance();
    else alert(err.message);
  }
}

async function loadReferenceImage(client) {
  referenceImageRef = null;
  if (!selectedLook?.id) return;

  const response = await fetch(`/api/studio/looks/${selectedLook.id}/image`, { credentials: 'include' });
  if (!response.ok) throw new Error('The selected reference image could not be loaded. Please upload it again.');
  const imageBlob = await response.blob();
  const uploaded = await client.files.upload(imageBlob, { ttlSeconds: 86400 });
  referenceImageRef = uploaded.id;
}

let lookSubmitting = false;
async function submitLook(e) {
  e.preventDefault();
  // Guard against double clicks / double Enter: the first submit is the only one.
  if (lookSubmitting) return;
  lookSubmitting = true;
  const submitBtn = document.getElementById('lookSubmitBtn');
  const originalLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  const errEl = document.getElementById('lookError');
  errEl.classList.remove('show');
  const fd = new FormData();
  fd.append('name', document.getElementById('lookName').value);
  fd.append('prompt', document.getElementById('lookPrompt').value);
  fd.append('image', document.getElementById('lookImage').files[0]);
  try {
    await apiFetch('/api/studio/looks', { method: 'POST', body: fd });
    document.getElementById('lookModalBackdrop').classList.remove('open');
    document.getElementById('lookForm').reset();
    await loadLooks();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    lookSubmitting = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel || 'Save Look'; }
  }
}

// ---------------------------------------------------------------------
// Decart realtime connection — ported directly from the working
// Node.js prototype (public/app.js in creoveya_3.zip). The token
// exchange, model selection, getUserMedia constraints, and
// client.realtime.connect/set/disconnect calls are unchanged; what's
// new here is the server-enforced start/heartbeat/stop wrapping it.
// ---------------------------------------------------------------------
async function goLive() {
  if (secondsRemaining <= 0) return showOutOfBalance();

  goLiveBtn.textContent = 'Connecting...';
  goLiveBtn.disabled = true;

  try {
    // 1. Ask our backend for permission to start — this is the
    //    server-side usage gate; it fails with 402 if out of balance.
    await apiFetch('/api/studio/stream/start', { method: 'POST' });

    // 2. Load the Decart SDK and get a short-lived client token from
    //    our server (the permanent API key never reaches the browser).
    const { createDecartClient, models } = await import('https://cdn.jsdelivr.net/npm/@decartai/sdk@0.1.22/+esm');
    const tokenRes = await apiFetch('/api/studio/realtime-token', { method: 'POST' });

    const model = models.realtime('lucy-2.1');

    if (!localStream) {
      localStream = await requestCameraStream({ frameRate: model.fps, width: model.width, height: model.height });
      refreshDeviceLists();
    }

    decartClient = createDecartClient({ apiKey: tokenRes.apiKey });
    await loadReferenceImage(decartClient);
    const initialPrompt = document.getElementById('promptInput').value.trim() || selectedLook?.prompt || 'Transform my live face into the person in the reference image while preserving the live facial expressions and camera motion.';
    realtimeSession = await decartClient.realtime.connect(localStream, {
      model,
      mirror: 'auto',
      initialState: {
        prompt: { text: initialPrompt, enhance: true },
        image: referenceImageRef || undefined,
      },
      onRemoteStream: (stream) => {
        placeholder.style.display = 'none';
        localPreview.style.display = 'none';
        transformedFeed.srcObject = stream;
        transformedFeed.style.display = 'block';
        liveBadge.textContent = 'LIVE';
        liveBadge.style.background = 'var(--danger)';
        goLiveBtn.textContent = '🛑 End Stream';
        goLiveBtn.disabled = false;
      },
    });

    await updatePipelineParameters();
    startHeartbeat();
    startClock();
  } catch (err) {
    console.error('[studio] Could not start stream:', {
      name: err?.name,
      message: err?.message,
      constraint: err?.constraint,
      secureContext: window.isSecureContext,
      url: window.location.href,
    });
    const mediaErrors = ['NotAllowedError', 'PermissionDeniedError', 'NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'OverconstrainedError', 'ConstraintNotSatisfiedError', 'SecurityError'];
    // Camera problems get the camera-specific help; anything else (balance,
    // server, Decart key/credits...) shows its real message instead of a
    // misleading "check your camera".
    alert(mediaErrors.includes(err?.name)
      ? mediaAccessMessage(err)
      : (err?.message ? `Could not start the stream: ${err.message}` : 'Could not start the stream. Please try again.'));
    await stopLiveStream('error').catch(() => {});
  }
}

async function updatePipelineParameters() {
  if (!realtimeSession) return;
  const promptValue = document.getElementById('promptInput').value.trim() || selectedLook?.prompt || (referenceImageRef
    ? 'Transform my live face into the person in the reference image while preserving the live facial expressions and camera motion.'
    : 'Apply a natural, high-fidelity AI transformation.');
  try {
    await realtimeSession.set({ prompt: promptValue, image: referenceImageRef || null, enhance: true });
  } catch (e) {
    console.warn('Pipeline parameter sync warning:', e);
  }
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    try {
      const data = await apiFetch('/api/studio/stream/heartbeat', { method: 'POST' });
      secondsRemaining = data.secondsRemaining;
      updateUsageBanner();
      if (data.exhausted) {
        alert("You've used up your available streaming time. Ending the stream — purchase another plan to continue.");
        await stopLiveStream('exhausted', /*skipServerStop*/ true);
      }
    } catch (err) {
      // If the heartbeat call itself fails (e.g. session expired), stop
      // the stream client-side rather than leaving it silently running.
      console.error('Heartbeat failed:', err);
      await stopLiveStream('heartbeat_error', true).catch(() => {});
    }
  }, 10000);
}

function startClock() {
  secondsElapsedThisSession = 0;
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    secondsElapsedThisSession += 1;
    const m = String(Math.floor(secondsElapsedThisSession / 60)).padStart(2, '0');
    const s = String(secondsElapsedThisSession % 60).padStart(2, '0');
    timerBadge.textContent = `${m}:${s}`;
  }, 1000);
}

async function stopLiveStream(reason, skipServerStop) {
  clearInterval(heartbeatTimer);
  clearInterval(clockTimer);

  if (realtimeSession) {
    try { realtimeSession.disconnect(); } catch (e) {}
    realtimeSession = null;
  }
  decartClient = null;
  referenceImageRef = null;
  if (!skipServerStop) {
    try {
      const data = await apiFetch('/api/studio/stream/stop', { method: 'POST' });
      secondsRemaining = data.secondsRemaining;
    } catch (e) { /* already ended server-side */ }
  }

  transformedFeed.srcObject = null;
  transformedFeed.style.display = 'none';
  if (localStream) { localPreview.style.display = 'block'; } else { placeholder.style.display = 'flex'; }
  liveBadge.textContent = 'IDLE';
  liveBadge.style.background = '';
  goLiveBtn.textContent = '🔴 Go Live';
  goLiveBtn.disabled = false;
  updateUsageBanner();
}

function showOutOfBalance() {
  usageBanner.textContent = "You're out of streaming time. Purchase another credit plan to keep going live.";
  usageBanner.classList.add('show');
  usageBanner.scrollIntoView({ behavior: 'smooth' });
}

init();
