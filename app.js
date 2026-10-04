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

// Reset Room Button: Tears down session, purges cache, forces fresh room
document.getElementById('resetRoomBtn').addEventListener('click', () => {
  if (confirm('Start a new room? This will disconnect all peers in this room.')) {
    localStorage.removeItem('airtext_draft_' + activeRoom);
    if (peer) {
      peer.destroy();
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

// --- 3. Multi-Client WebRTC Mesh Network ---
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const networkText = document.getElementById('networkText');
const peerLabel = document.getElementById('peerLabel');
const flash = document.getElementById('flash');

let peer = null;
let connections = new Map();
let remoteTyping = false;

// Public STUN servers for cross-network NAT traversal
const rtcConfig = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
};

function startPeerMesh() {
  const hostId = `airtext-room-${activeRoom}-host`;
  const myUniqueId = `airtext-room-${activeRoom}-peer-${Math.random().toString(36).substring(2, 7)}`;

  // 1. Try claiming the host coordinator role
  peer = new Peer(hostId, rtcConfig);

  peer.on('open', () => {
    networkText.textContent = 'Room coordinator ready. Share QR or link!';
    updatePeerCountUI();
  });

  peer.on('error', (err) => {
    // If host slot is already occupied, connect as a mesh peer
    if (err.type === 'unavailable-id') {
      peer.destroy();
      peer = new Peer(myUniqueId, rtcConfig);

      peer.on('open', () => {
        networkText.textContent = 'Connecting to room coordinator...';
        const c = peer.connect(hostId, { reliable: true });
        bindDataChannel(c);
      });
    } else {
      console.warn('Peer network status:', err);
    }
  });

  peer.on('connection', (c) => {
    bindDataChannel(c);
  });
}

function bindDataChannel(channel) {
  channel.on('open', () => {
    connections.set(channel.peer, channel);
    updatePeerCountUI();

    // Push existing room draft to the newly joined peer
    if (editor.value) {
      channel.send({ type: 'SYNC_TEXT', text: editor.value });
    }
  });

  channel.on('data', (data) => {
    if (data.type === 'SYNC_TEXT') {
      remoteTyping = true;
      editor.value = data.text;
      localStorage.setItem(cacheKey, data.text);
      updateCharCount();
      triggerPulse();
      remoteTyping = false;

      // Broadcast relay if this device is acting as host
      if (peer && peer.id.endsWith('-host')) {
        connections.forEach((c, id) => {
          if (id !== channel.peer && c.open) {
            c.send(data);
          }
        });
      }
    }
  });

  channel.on('close', () => {
    connections.delete(channel.peer);
    updatePeerCountUI();
  });

  channel.on('error', () => {
    connections.delete(channel.peer);
    updatePeerCountUI();
  });
}

function updatePeerCountUI() {
  const count = connections.size;
  peerLabel.textContent = `${count} device${count === 1 ? '' : 's'} connected`;
  if (count > 0) {
    statusDot.classList.add('active');
    statusLabel.textContent = 'Synced';
    networkText.textContent = `Direct P2P Active (${count} peer${count === 1 ? '' : 's'})`;
  } else {
    statusDot.classList.remove('active');
    statusLabel.textContent = 'Waiting';
    networkText.textContent = 'Waiting for other devices to scan or join...';
  }
}

function triggerPulse() {
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 900);
}

// Ensure socket deregistration on page exit
window.addEventListener('beforeunload', () => {
  if (peer) peer.destroy();
});

// --- 4. Input Sync (Broadcasts to all connected peers) ---
let debounceTimer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(cacheKey, editor.value);

  if (remoteTyping) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const payload = { type: 'SYNC_TEXT', text: editor.value };
    connections.forEach((c) => {
      if (c.open) c.send(payload);
    });
  }, 100);
});

// --- 5. Actions & Modal Logic ---
document.getElementById('copyBtn').addEventListener('click', async () => {
  if (!editor.value) return;
  await navigator.clipboard.writeText(editor.value);
  notify('Prompt copied!');
});

document.getElementById('clearBtn').addEventListener('click', () => {
  editor.value = '';
  updateCharCount();
  localStorage.removeItem(cacheKey);
  const payload = { type: 'SYNC_TEXT', text: '' };
  connections.forEach((c) => {
    if (c.open) c.send(payload);
  });
});

document.getElementById('copyLinkBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(window.location.href);
  notify('Room link copied!');
});

// --- 6. QR Modal Handler ---
const qrModal = document.getElementById('qrModal');
const qrContainer = document.getElementById('qrCanvas');

document.getElementById('qrBtn').addEventListener('click', () => {
  // Clear any existing QR render
  qrContainer.innerHTML = '';

  const shareUrl = window.location.href;

  // Use QRCode.js constructor if loaded, otherwise fallback to SVG image
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrContainer, {
      text: shareUrl,
      width: 180,
      height: 180,
      colorDark: '#0a0b0e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    const fallbackImg = document.createElement('img');
    fallbackImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}`;
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

// Start Mesh Network
startPeerMesh();
