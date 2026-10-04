// --- 1. Deterministic Room Management & Reset ---
function generateSlug() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let slug = '';
  for (let i = 0; i < 6; i++) {
    slug += chars[Math.floor(Math.random() * chars.length)];
  }
  return slug;
}

let activeRoom = window.location.hash.replace('#', '').trim().toLowerCase();
if (!activeRoom) {
  activeRoom = generateSlug();
  window.history.replaceState(null, '', '#' + activeRoom);
}

document.getElementById('roomCodeDisplay').textContent = '#' + activeRoom;

// Reset Room Button: Cleans memory, tears down WebRTC, forces fresh room
document.getElementById('resetRoomBtn').addEventListener('click', () => {
  if (confirm('Start a new room? This will disconnect all devices.')) {
    localStorage.removeItem('airtext_draft_' + activeRoom);
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    const freshSlug = generateSlug();
    window.location.hash = freshSlug;
    window.location.reload();
  }
});

// Custom Room Set
document.getElementById('joinBtn').addEventListener('click', () => {
  const code = document.getElementById('joinInput').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!code) return;
  window.location.hash = code;
  window.location.reload();
});

// --- 2. Cache Draft ---
const editor = document.getElementById('editor');
const chars = document.getElementById('chars');
const cacheKey = 'airtext_draft_' + activeRoom;
editor.value = localStorage.getItem(cacheKey) || '';
updateCharCount();

function updateCharCount() {
  chars.textContent = `${editor.value.length} characters`;
}

// --- 3. The Earlier Proven Bidirectional WebRTC Engine ---
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const networkText = document.getElementById('networkText');
const peerLabel = document.getElementById('peerLabel');
const flash = document.getElementById('flash');

let peer = null;
let activeConnection = null;
let isRemoteInput = false;

// Fixed room peer roles matching the earlier working code
const hostId = `airtext-h-${activeRoom}`;
const clientId = `airtext-c-${activeRoom}`;

// Fallback Google STUN servers
const rtcConfig = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
};

function initP2P() {
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }

  // Device 1 registers as host
  peer = new Peer(hostId, rtcConfig);

  peer.on('open', () => {
    updateStatus(false, 'Standby • Waiting for other device...');
    networkText.textContent = 'Room open. Scan QR on second device.';
  });

  peer.on('error', (err) => {
    // If host ID exists, Device 2 registers as client and connects immediately
    if (err.type === 'unavailable-id') {
      peer.destroy();
      peer = new Peer(clientId, rtcConfig);

      peer.on('open', () => {
        updateStatus(false, 'Connecting to host...');
        networkText.textContent = 'Connecting...';
        const conn = peer.connect(hostId, { reliable: true });
        bindChannel(conn);
      });

      peer.on('error', (e) => {
        console.warn('Client peer error:', e);
      });
    } else {
      console.warn('Peer error:', err);
    }
  });

  // When Device 1 receives incoming connection from Device 2
  peer.on('connection', (conn) => {
    bindChannel(conn);
  });
}

function bindChannel(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    updateStatus(true, 'Direct P2P Synced');
    networkText.textContent = 'Direct P2P Synced';
    peerLabel.textContent = '1 device connected';

    // Push initial text on connection
    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }
  });

  conn.on('data', (data) => {
    if (!data) return;

    if (data.type === 'SYNC_TEXT') {
      isRemoteInput = true;
      editor.value = data.text;
      localStorage.setItem(cacheKey, data.text);
      updateCharCount();
      triggerPulse();
      isRemoteInput = false;
    }
  });

  conn.on('close', () => {
    updateStatus(false, 'Peer disconnected');
    peerLabel.textContent = '0 devices connected';
    networkText.textContent = 'Device left. Waiting...';
    activeConnection = null;
  });

  conn.on('error', () => {
    updateStatus(false, 'Connection error');
    peerLabel.textContent = '0 devices connected';
    activeConnection = null;
  });
}

function updateStatus(isLive, label) {
  statusDot.className = 'status-dot' + (isLive ? ' active' : '');
  statusLabel.textContent = label;
}

function triggerPulse() {
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 1000);
}

// Ensure socket is released when closing browser tab
window.addEventListener('beforeunload', () => {
  if (peer) peer.destroy();
});

// --- 4. Input Sync ---
let typingTimer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(cacheKey, editor.value);

  if (isRemoteInput || !activeConnection) return;

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (activeConnection.open) {
      activeConnection.send({ type: 'SYNC_TEXT', text: editor.value });
    }
  }, 100);
});

// --- 5. Actions & Buttons ---
document.getElementById('copyBtn').addEventListener('click', async () => {
  if (!editor.value) return;
  await navigator.clipboard.writeText(editor.value);
  notify('Prompt copied!');
});

document.getElementById('clearBtn').addEventListener('click', () => {
  editor.value = '';
  updateCharCount();
  localStorage.removeItem(cacheKey);
  if (activeConnection && activeConnection.open) {
    activeConnection.send({ type: 'SYNC_TEXT', text: '' });
  }
});

document.getElementById('copyLinkBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(window.location.href);
  notify('Room link copied!');
});

// --- 6. QR Modal Handler ---
const qrModal = document.getElementById('qrModal');
const qrContainer = document.getElementById('qrCanvas');

document.getElementById('qrBtn').addEventListener('click', () => {
  qrContainer.innerHTML = '';
  const currentUrl = window.location.href;

  if (typeof QRCode !== 'undefined') {
    new QRCode(qrContainer, {
      text: currentUrl,
      width: 180,
      height: 180,
      colorDark: '#0a0b0e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    const fallbackImg = document.createElement('img');
    fallbackImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(currentUrl)}`;
    fallbackImg.alt = 'QR Code';
    fallbackImg.style.width = '180px';
    fallbackImg.style.height = '180px';
    qrContainer.appendChild(fallbackImg);
  }

  qrModal.classList.add('open');
});

document.getElementById('closeModalBtn').addEventListener('click', () => {
  qrModal.classList.remove('open');
});

qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) {
    qrModal.classList.remove('open');
  }
});

// --- 7. Theme Switcher & Toast ---
const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  themeBtn.textContent = isDark ? '☀' : '🌙';
});

function notify(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// Start P2P Engine
initP2P();
