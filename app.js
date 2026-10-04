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

// --- 1. Deterministic Room Identity ---
function generateRoomCode() {
  const charSet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += charSet.charAt(Math.floor(Math.random() * charSet.length));
  }
  return result;
}

function resolveRoomCode() {
  const hash = window.location.hash.replace('#', '').trim();
  if (hash) {
    return hash.toLowerCase();
  }
  const newCode = generateRoomCode();
  window.history.replaceState(null, '', `#${newCode}`);
  return newCode;
}

let activeRoomCode = resolveRoomCode();
roomCodeDisplay.textContent = `#${activeRoomCode}`;

function getFullShareUrl() {
  const base = window.location.origin + window.location.pathname;
  return `${base}#${activeRoomCode}`;
}

// Local Storage Draft Cache
const cacheKey = `airtext_cache_${activeRoomCode}`;
editor.value = localStorage.getItem(cacheKey) || '';
updateCharCount();

function updateCharCount() {
  chars.textContent = `${editor.value.length} characters`;
}

// Device identifier
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const myDeviceLabel = isMobile ? 'Mobile Phone' : 'Laptop / PC';

// --- 2. Multi-User WebRTC Relay Engine ---
let peer = null;
let connections = new Map(); // Stores all active peer channels
let isRemoteInput = false;
let isHost = false;

const peerConfig = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
};

function connectToRoom(roomCode) {
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }
  connections.clear();
  updateStatus(false, 'Connecting...');
  networkText.textContent = 'Connecting to signaling network...';

  const hostPeerId = `airtext-room-${roomCode}-host`;
  const guestPeerId = `airtext-room-${roomCode}-guest-${Math.random().toString(36).substring(2, 7)}`;

  // 1. Attempt to register as Host
  peer = new Peer(hostPeerId, peerConfig);

  peer.on('open', () => {
    isHost = true;
    updateStatus(false, 'Room ready • Waiting for peers...');
    networkText.textContent = 'Room coordinator ready. Share QR or link!';
    updatePeerCount();
  });

  peer.on('error', (err) => {
    // If Host slot is taken, join as a new guest and link to the Host
    if (err.type === 'unavailable-id') {
      isHost = false;
      peer.destroy();
      peer = new Peer(guestPeerId, peerConfig);

      peer.on('open', () => {
        updateStatus(false, 'Joining room...');
        networkText.textContent = 'Connecting to room host...';
        const conn = peer.connect(hostPeerId, { reliable: true });
        setupConnectionEvents(conn);
      });

      peer.on('error', (clientErr) => {
        console.error('Client peer error:', clientErr);
        updateStatus(false, 'Connection error');
      });
    } else {
      console.warn('Peer error:', err);
    }
  });

  // When new devices join the Host
  peer.on('connection', (conn) => {
    setupConnectionEvents(conn);
  });
}

function setupConnectionEvents(conn) {
  conn.on('open', () => {
    connections.set(conn.peer, conn);
    updatePeerCount();
    conn.send({ type: 'HANDSHAKE', device: myDeviceLabel });

    // Sync current editor state to the newcomer
    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }
  });

  conn.on('data', (data) => {
    if (!data) return;

    if (data.type === 'HANDSHAKE') {
      showToast(`Joined: ${data.device}`);
    } else if (data.type === 'SYNC_TEXT') {
      isRemoteInput = true;
      editor.value = data.text;
      localStorage.setItem(cacheKey, data.text);
      updateCharCount();
      triggerArrivalAnimation();
      isRemoteInput = false;

      // Broadcast relay: If this machine is the Host, forward changes to all other peers
      if (isHost) {
        connections.forEach((peerConn, peerId) => {
          if (peerId !== conn.peer && peerConn.open) {
            peerConn.send(data);
          }
        });
      }
    }
  });

  conn.on('close', () => {
    connections.delete(conn.peer);
    updatePeerCount();
  });

  conn.on('error', () => {
    connections.delete(conn.peer);
    updatePeerCount();
  });
}

function updatePeerCount() {
  const count = connections.size;
  peerLabel.textContent = `${count} device${count === 1 ? '' : 's'} connected`;
  
  if (count > 0) {
    updateStatus(true, 'Direct P2P Synced');
    networkText.textContent = `Direct P2P Active (${count} connected)`;
  } else {
    updateStatus(false, isHost ? 'Waiting for peers...' : 'Disconnected');
    networkText.textContent = isHost ? 'Room open. Waiting for peers...' : 'Reconnecting...';
  }
}

function updateStatus(isLive, label) {
  statusDot.className = 'status-dot' + (isLive ? ' active' : '');
  statusLabel.textContent = label;
}

function triggerArrivalAnimation() {
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 1000);
}

// Clean up socket on window unload
window.addEventListener('beforeunload', () => {
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }
});

// --- 3. Typing Sync with Broadcast ---
let typingTimer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(cacheKey, editor.value);

  if (isRemoteInput || connections.size === 0) return;

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const payload = { type: 'SYNC_TEXT', text: editor.value };
    connections.forEach((conn) => {
      if (conn.open) conn.send(payload);
    });
  }, 90);
});

// --- 4. Room Navigation & Action Buttons ---
resetRoomBtn.addEventListener('click', () => {
  if (confirm('Start a new room? This will disconnect all peers.')) {
    localStorage.removeItem(cacheKey);
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    const freshCode = generateRoomCode();
    window.location.hash = freshCode;
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
  const payload = { type: 'SYNC_TEXT', text: '' };
  connections.forEach((conn) => {
    if (conn.open) conn.send(payload);
  });
});

copyLinkBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(getFullShareUrl());
  showToast('Room link copied!');
});

// --- 5. QR Code Handling ---
qrBtn.addEventListener('click', () => {
  qrCanvas.innerHTML = '';
  const shareUrl = getFullShareUrl();

  if (typeof window.QRCode !== 'undefined') {
    new window.QRCode(qrCanvas, {
      text: shareUrl,
      width: 180,
      height: 180,
      colorDark: '#0a0b0e',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } else {
    const fallbackImg = document.createElement('img');
    fallbackImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}`;
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

// --- 6. Theme Toggle & Toast Notifications ---
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

// Start peer connection with active room
connectToRoom(activeRoomCode);
