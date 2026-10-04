// --- 1. Deterministic Room Management & Peer Resolution ---
function generateSlug() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let slug = '';
  for (let i = 0; i < 6; i++) slug += chars[Math.floor(Math.random() * chars.length)];
  return slug;
}

// Parse Room & Target Peer from URL hash (e.g. #fwdctk or #fwdctk:targetPeerId)
const rawHash = window.location.hash.replace('#', '').trim();
let activeRoom = '';
let targetPeerToConnect = '';

if (rawHash.includes(':')) {
  const parts = rawHash.split(':');
  activeRoom = parts[0].toLowerCase();
  targetPeerToConnect = parts[1];
} else if (rawHash) {
  activeRoom = rawHash.toLowerCase();
} else {
  activeRoom = generateSlug();
  window.history.replaceState(null, '', '#' + activeRoom);
}

document.getElementById('roomCodeDisplay').textContent = '#' + activeRoom;

// Reset Room Button
document.getElementById('resetRoomBtn').addEventListener('click', () => {
  if (confirm('Start a new room? This will disconnect all devices.')) {
    localStorage.removeItem('airtext_draft_' + activeRoom);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    const fresh = generateSlug();
    window.location.hash = fresh;
    window.location.reload();
  }
});

// Custom Room Input
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

// --- 3. Robust WebRTC Engine with TURN + STUN ---
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const networkText = document.getElementById('networkText');
const peerLabel = document.getElementById('peerLabel');
const flash = document.getElementById('flash');

let peer = null;
let activeConnection = null;
let remoteTyping = false;
let heartbeatTimer = null;
let myCurrentPeerId = '';

// Google STUN + OpenRelay TURN for mobile cellular-to-Wi-Fi traversal
const rtcConfig = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelay',
        credential: 'openrelay'
      }
    ]
  }
};

function initP2P() {
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }

  // Create a clean, unique peer ID for this session
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  
  // If user scanned a QR code with target peer, register as guest and connect directly
  if (targetPeerToConnect) {
    myCurrentPeerId = `airtext-${activeRoom}-g-${randomSuffix}`;
    peer = new Peer(myCurrentPeerId, rtcConfig);

    peer.on('open', () => {
      networkText.textContent = 'Pairing with room host...';
      statusLabel.textContent = 'Connecting...';
      const conn = peer.connect(targetPeerToConnect, { reliable: true });
      setupDataChannel(conn);
    });

    peer.on('error', (err) => {
      console.warn('Peer error:', err);
      networkText.textContent = 'Host offline. Scan fresh QR code.';
    });
  } else {
    // Primary room creator: claim deterministic host ID or unique slot
    const hostId = `airtext-${activeRoom}-h`;
    peer = new Peer(hostId, rtcConfig);

    peer.on('open', (id) => {
      myCurrentPeerId = id;
      networkText.textContent = 'Ready. Scan QR with your phone/iPad.';
      statusLabel.textContent = 'Waiting';
    });

    peer.on('error', (err) => {
      // If host ID is currently occupied, take a unique guest ID and connect to it
      if (err.type === 'unavailable-id') {
        peer.destroy();
        myCurrentPeerId = `airtext-${activeRoom}-g-${randomSuffix}`;
        peer = new Peer(myCurrentPeerId, rtcConfig);

        peer.on('open', (id) => {
          myCurrentPeerId = id;
          networkText.textContent = 'Joining room host...';
          const conn = peer.connect(hostId, { reliable: true });
          setupDataChannel(conn);
        });
      }
    });
  }

  // Handle incoming connections from scanning devices
  peer.on('connection', (conn) => {
    setupDataChannel(conn);
  });
}

function setupDataChannel(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    statusDot.classList.add('active');
    statusLabel.textContent = 'Synced';
    networkText.textContent = 'Direct WebRTC P2P Active';
    peerLabel.textContent = '1 device connected';
    notify('Device connected!');

    // Push local draft to connected peer
    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }

    // Keep-alive ping to prevent mobile browser sleeping WebRTC
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (activeConnection && activeConnection.open) {
          activeConnection.send({ type: 'PING' });
        }
      }, 4000);
    }
  });

  conn.on('data', (data) => {
    if (!data) return;

    if (data.type === 'PING') return;

    if (data.type === 'SYNC_TEXT') {
      remoteTyping = true;
      editor.value = data.text;
      localStorage.setItem(cacheKey, data.text);
      updateCharCount();
      triggerPulse();
      remoteTyping = false;
    }
  });

  conn.on('close', () => {
    statusDot.classList.remove('active');
    statusLabel.textContent = 'Standby';
    peerLabel.textContent = '0 devices connected';
    networkText.textContent = 'Device disconnected. Waiting...';
    activeConnection = null;
  });

  conn.on('error', (err) => {
    console.warn('Channel error:', err);
    statusDot.classList.remove('active');
    peerLabel.textContent = '0 devices connected';
    activeConnection = null;
  });
}

function triggerPulse() {
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 900);
}

// Ensure clean socket disconnect
window.addEventListener('beforeunload', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (peer) peer.destroy();
});

// --- 4. Input Sync ---
let debounceTimer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(cacheKey, editor.value);

  if (remoteTyping || !activeConnection || !activeConnection.open) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    activeConnection.send({ type: 'SYNC_TEXT', text: editor.value });
  }, 80);
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

// Generates direct share URL with active peer ID embedded
function getDirectShareUrl() {
  const base = `${window.location.origin}${window.location.pathname}#${activeRoom}`;
  return myCurrentPeerId ? `${base}:${myCurrentPeerId}` : base;
}

document.getElementById('copyLinkBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(getDirectShareUrl());
  notify('Direct room link copied!');
});

// --- 6. QR Modal Handler ---
const qrModal = document.getElementById('qrModal');
const qrContainer = document.getElementById('qrCanvas');

document.getElementById('qrBtn').addEventListener('click', () => {
  qrContainer.innerHTML = '';
  const directUrl = getDirectShareUrl();

  if (typeof QRCode !== 'undefined') {
    new QRCode(qrContainer, {
      text: directUrl,
      width: 180,
      height: 180,
      colorDark: '#0a0b0e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    const fallbackImg = document.createElement('img');
    fallbackImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(directUrl)}`;
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

// Start
initP2P();
