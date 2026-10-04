// --- DOM Elements ---
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
const sendFileBtn = document.getElementById('sendFileBtn');
const fileInput = document.getElementById('fileInput');
const filesDeck = document.getElementById('filesDeck');

// --- 1. Dynamic Room & Direct Target Parser ---
function generateSlug() {
  const charSet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += charSet.charAt(Math.floor(Math.random() * charSet.length));
  }
  return result;
}

const rawHash = window.location.hash.replace('#', '').trim();
let activeRoom = '';
let targetPeerId = '';

if (rawHash.includes(':')) {
  const parts = rawHash.split(':');
  activeRoom = parts[0].toLowerCase();
  targetPeerId = parts[1];
} else if (rawHash) {
  activeRoom = rawHash.toLowerCase();
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

// --- 2. Guaranteed WebRTC Engine with TURN + STUN ---
let peer = null;
let activeConnection = null;
let myPeerId = '';
let isRemoteInput = false;
let pingTimer = null;

// Multi-server STUN + Public TURN relays (Crucial for Cellular vs Wi-Fi NAT punching)
const peerConfig = {
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

  // Generate a collision-free ID for this session
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  myPeerId = `airtext-${activeRoom}-${randomSuffix}`;

  peer = new Peer(myPeerId, peerConfig);

  peer.on('open', (id) => {
    myPeerId = id;

    if (targetPeerId) {
      // Scanned from QR: Connect directly to the specific host peer
      updateStatus(false, 'Connecting...');
      networkText.textContent = 'Pairing directly with host...';
      const conn = peer.connect(targetPeerId, { reliable: true });
      bindDataChannel(conn);
    } else {
      // Room host: Wait for incoming device
      updateStatus(false, 'Waiting');
      networkText.textContent = 'Ready. Scan QR with your 2nd device!';
      peerLabel.textContent = '0 devices connected';
    }
  });

  // Listen for incoming connection from QR-scanned device
  peer.on('connection', (conn) => {
    bindDataChannel(conn);
  });

  peer.on('error', (err) => {
    console.warn('Signaling error:', err);
    networkText.textContent = 'Network notice: ' + (err.type || 'Connection issue');
  });
}

function bindDataChannel(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    updateStatus(true, 'Synced');
    networkText.textContent = 'Direct WebRTC P2P Active';
    peerLabel.textContent = '1 device connected';
    showToast('Device connected!');

    // Push initial draft
    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }

    // Keep-alive ping every 4s to prevent mobile browser sleep
    if (!pingTimer) {
      pingTimer = setInterval(() => {
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
      isRemoteInput = true;
      editor.value = data.text;
      localStorage.setItem(cacheKey, data.text);
      updateCharCount();
      triggerPulse();
      isRemoteInput = false;
    } else if (data.type === 'SYNC_FILE') {
      addFileCard(data.name, data.size, data.data, false);
      showToast(`Received ${data.name}`);
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
  setTimeout(() => flash.classList.remove('show'), 900);
}

// Generate direct pair URL embedding this machine's exact active ID
function getDirectPairUrl() {
  const base = `${window.location.origin}${window.location.pathname}#${activeRoom}`;
  return myPeerId ? `${base}:${myPeerId}` : base;
}

// --- 3. Input Sync ---
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

// --- 4. File Sharing Implementation ---
sendFileBtn.addEventListener('click', () => {
  if (!activeConnection || !activeConnection.open) {
    showToast('Wait until devices are linked before sending files');
    return;
  }
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      type: 'SYNC_FILE',
      name: file.name,
      size: formatFileSize(file.size),
      data: reader.result
    };
    activeConnection.send(payload);
    addFileCard(file.name, payload.size, reader.result, true);
    showToast(`Sent ${file.name}`);
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

function addFileCard(name, size, dataUri, isSelf) {
  const card = document.createElement('div');
  card.className = 'file-item';
  card.innerHTML = `
    <div>
      <span class="file-name">${isSelf ? '📤 ' : '📥 '}${name}</span>
      <span class="file-size">(${size})</span>
    </div>
    <a href="${dataUri}" download="${name}" class="file-download">Download</a>
  `;
  filesDeck.prepend(card);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// --- 5. Controls & Action Buttons ---
resetRoomBtn.addEventListener('click', () => {
  if (confirm('Start a new room? This will disconnect current peers.')) {
    localStorage.removeItem(cacheKey);
    if (pingTimer) clearInterval(pingTimer);
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    const freshSlug = generateSlug();
    window.location.hash = freshSlug;
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
  showToast('Direct pairing link copied!');
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

window.addEventListener('beforeunload', () => {
  if (pingTimer) clearInterval(pingTimer);
  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }
});

// Initialize P2P
initP2P();
