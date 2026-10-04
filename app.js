// --- DOM Element References ---
const editor = document.getElementById('editor');
const chars = document.getElementById('chars');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const networkText = document.getElementById('networkText');
const flash = document.getElementById('flash');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const peerLabel = document.getElementById('peerLabel');
const clearBtn = document.getElementById('clearBtn');
const copyBtn = document.getElementById('copyBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const resetRoomBtn = document.getElementById('resetRoomBtn');
const joinInput = document.getElementById('joinInput');
const joinBtn = document.getElementById('joinBtn');
const qrBtn = document.getElementById('qrBtn');
const qrModal = document.getElementById('qrModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const qrCanvas = document.getElementById('qrCanvas');
const themeBtn = document.getElementById('themeBtn');
const toast = document.getElementById('toast');

// --- 1. Dynamic Room & Direct Target Parser ---
function generateSlug() {
  const charSet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += charSet.charAt(Math.floor(Math.random() * charSet.length));
  }
  return result;
}

// Format: #roomName or #roomName:targetPeerId
const hashRaw = window.location.hash.replace('#', '').trim();
let activeRoom = '';
let targetPeerToConnect = '';

if (hashRaw.includes(':')) {
  const parts = hashRaw.split(':');
  activeRoom = parts[0].toLowerCase();
  targetPeerToConnect = parts[1];
} else if (hashRaw) {
  activeRoom = hashRaw.toLowerCase();
} else {
  activeRoom = generateSlug();
  window.history.replaceState(null, '', `#${activeRoom}`);
}

roomCodeDisplay.textContent = `#${activeRoom}`;

const cacheKey = `airtext_draft_${activeRoom}`;
editor.value = localStorage.getItem(cacheKey) || '';
updateCharCount();

function updateCharCount() {
  chars.textContent = `${editor.value.length} characters`;
}

const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const myDeviceLabel = isMobile ? 'Mobile Phone' : 'Laptop / PC';

// --- 2. Guaranteed Peer Connection Engine ---
let peer = null;
let activeConnection = null;
let mySessionPeerId = '';
let isRemoteInput = false;
let heartbeatTimer = null;

// Multi-server STUN configuration
const peerConfig = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  }
};

function initP2P() {
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }

  // Generate an ID that avoids cloud server collisions
  const sessionToken = Math.random().toString(36).substring(2, 8);
  mySessionPeerId = `airtext-${activeRoom}-${sessionToken}`;

  peer = new Peer(mySessionPeerId, peerConfig);

  peer.on('open', (id) => {
    mySessionPeerId = id;

    if (targetPeerToConnect) {
      // Scanned from QR: connect directly to the target peer ID
      updateStatus(false, 'Connecting to peer...');
      networkText.textContent = 'Pairing directly with host...';
      const conn = peer.connect(targetPeerToConnect, { reliable: true });
      bindDataChannel(conn);
    } else {
      // Room host: waiting for connection
      updateStatus(false, 'Waiting for device...');
      networkText.textContent = 'Room open. Scan QR on second device.';
      peerLabel.textContent = '0 devices connected';
    }
  });

  peer.on('connection', (conn) => {
    bindDataChannel(conn);
  });

  peer.on('error', (err) => {
    console.warn('Signaling error:', err);
    networkText.textContent = 'Signaling issue. Click Reset Room.';
  });
}

function bindDataChannel(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    updateStatus(true, 'Direct P2P Synced');
    networkText.textContent = 'Direct WebRTC P2P Active';
    peerLabel.textContent = '1 device connected';
    showToast('Device connected!');

    conn.send({ type: 'HANDSHAKE', device: myDeviceLabel });

    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (activeConnection && activeConnection.open) {
          activeConnection.send({ type: 'PING' });
        }
      }, 3500);
    }
  });

  conn.on('data', (data) => {
    if (!data) return;
    if (data.type === 'PING') return;

    if (data.type === 'HANDSHAKE') {
      showToast(`Linked with ${data.device}`);
      peerLabel.textContent = `Linked: ${data.device}`;
    } else if (data.type === 'SYNC_TEXT') {
      isRemoteInput = true;
      editor.value = data.text;
      localStorage.setItem(cacheKey, data.text);
      updateCharCount();
      triggerPulse();
      isRemoteInput = false;
    }
  });

  conn.on('close', () => {
    updateStatus(false, 'Disconnected');
    networkText.textContent = 'Device left. Waiting for scan...';
    peerLabel.textContent = '0 devices connected';
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

// --- 3. URL Generator for Direct Pair ---
function getDirectPairUrl() {
  const base = `${window.location.origin}${window.location.pathname}#${activeRoom}`;
  return mySessionPeerId ? `${base}:${mySessionPeerId}` : base;
}

// --- 4. Input Sync ---
let typingTimer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(cacheKey, editor.value);

  if (isRemoteInput || !activeConnection || !activeConnection.open) return;

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    activeConnection.send({ type: 'SYNC_TEXT', text: editor.value });
  }, 80);
});

// --- 5. Controls & Modals ---
resetRoomBtn.addEventListener('click', () => {
  if (confirm('Start a new room? This will disconnect current peers.')) {
    localStorage.removeItem(cacheKey);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    const fresh = generateSlug();
    window.location.hash = fresh;
    window.location.reload();
  }
});

joinBtn.addEventListener('click', () => {
  const code = joinInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!code) return;
  window.location.hash = code;
  window.location.reload();
});

copyBtn.addEventListener('click', async () => {
  if (!editor.value) return;
  await navigator.clipboard.writeText(editor.value);
  showToast('Copied to clipboard!');
});

clearBtn.addEventListener('click', () => {
  editor.value = '';
  updateCharCount();
  localStorage.removeItem(cacheKey);
  if (activeConnection && activeConnection.open) {
    activeConnection.send({ type: 'SYNC_TEXT', text: '' });
  }
});

copyLinkBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(getDirectPairUrl());
  showToast('Direct room link copied!');
});

// QR Modal Handler with direct pairing URL
qrBtn.addEventListener('click', () => {
  qrCanvas.innerHTML = '';
  const directUrl = getDirectPairUrl();

  if (typeof window.QRCode !== 'undefined') {
    new window.QRCode(qrCanvas, {
      text: directUrl,
      width: 180,
      height: 180,
      colorDark: '#0a0b0e',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } else {
    const fallbackImg = document.createElement('img');
    fallbackImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(directUrl)}`;
    fallbackImg.alt = 'QR Code';
    fallbackImg.style.width = '180px';
    fallbackImg.style.height = '180px';
    qrCanvas.appendChild(fallbackImg);
  }

  qrModal.classList.add('open');
});

closeModalBtn.addEventListener('click', () => {
  qrModal.classList.remove('open');
});

qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) {
    qrModal.classList.remove('open');
  }
});

// --- 6. Theme Toggle & Toast ---
const savedTheme = localStorage.getItem('airtext_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
themeBtn.textContent = savedTheme === 'dark' ? '🌙' : '☀';

themeBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('airtext_theme', next);
  themeBtn.textContent = next === 'dark' ? '🌙' : '☀';
});

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

window.addEventListener('beforeunload', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }
});

// Initialize P2P
initP2P();
