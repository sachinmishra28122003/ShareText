// --- Elements ---
const editor = document.getElementById('editor');
const editorCard = document.getElementById('editorCard');
const charCount = document.getElementById('charCount');
const roomDisplay = document.getElementById('roomDisplay');
const currentRoomCode = document.getElementById('currentRoomCode');
const syncPing = document.getElementById('syncPing');
const statusBeacon = document.getElementById('beacon');
const statusLabel = document.getElementById('statusLabel');
const connectedDevice = document.getElementById('connectedDevice');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const copyLabel = document.getElementById('copyLabel');
const clearBtn = document.getElementById('clearBtn');
const sendFileBtn = document.getElementById('sendFileBtn');
const fileInput = document.getElementById('fileInput');
const filesDeck = document.getElementById('filesDeck');
const qrBtn = document.getElementById('qrBtn');
const qrModal = document.getElementById('qrModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const roomLinkText = document.getElementById('roomLinkText');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const toast = document.getElementById('toast');
const manualRoomInput = document.getElementById('manualRoomInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const newRoomBtn = document.getElementById('newRoomBtn');

// --- 1. Unique Room Identity ---
function generateRoomCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function resolveRoomCode() {
  const hash = window.location.hash.replace('#', '').trim();
  if (hash) {
    return hash.toLowerCase();
  }
  const newCode = generateRoomCode();
  // Use replaceState to ensure GitHub Pages doesn't lose hash
  window.history.replaceState(null, '', `#${newCode}`);
  return newCode;
}

let activeRoomCode = resolveRoomCode();
currentRoomCode.textContent = activeRoomCode;
roomDisplay.textContent = `Room: #${activeRoomCode}`;

function getFullShareUrl() {
  const base = window.location.origin + window.location.pathname;
  return `${base}#${activeRoomCode}`;
}

roomLinkText.textContent = getFullShareUrl();

// Regenerate QR Code for current exact room URL
let qrCodeInstance = null;
function refreshQR() {
  const container = document.getElementById('qrcode');
  container.innerHTML = '';
  qrCodeInstance = new QRCode(container, {
    text: getFullShareUrl(),
    width: 170,
    height: 170,
    colorDark: '#0a0a0c',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}
refreshQR();

// --- Local Storage Cache ---
const getCacheKey = () => `airtext_cache_${activeRoomCode}`;
editor.value = localStorage.getItem(getCacheKey()) || '';
updateCharCount();

function updateCharCount() {
  charCount.textContent = `${editor.value.length} characters`;
}

// Device tag
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const myDeviceLabel = isMobile ? 'Mobile Phone' : 'Laptop / PC';

// --- 2. WebRTC Peer Connection with Public STUN Servers ---
let peer = null;
let activeConnection = null;
let isRemoteInput = false;

// Google Public STUN servers allow mobile data <-> home Wi-Fi NAT punching
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
    peer.destroy();
  }
  updateStatus(false, 'Connecting to server...');

  const hostPeerId = `airtext-room-${roomCode}-host`;
  const guestPeerId = `airtext-room-${roomCode}-guest-${Math.random().toString(36).substring(2, 6)}`;

  // Attempt to initialize as the Room Host
  peer = new Peer(hostPeerId, peerConfig);

  peer.on('open', () => {
    updateStatus(false, 'Room ready • Waiting for mobile...');
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      // Host already exists! This device is the guest/client.
      peer.destroy();
      peer = new Peer(guestPeerId, peerConfig);

      peer.on('open', () => {
        updateStatus(false, 'Pairing with laptop...');
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

  peer.on('connection', (conn) => {
    setupConnectionEvents(conn);
  });
}

function setupConnectionEvents(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    updateStatus(true, 'Direct P2P Synced');
    conn.send({ type: 'HANDSHAKE', device: myDeviceLabel });

    // Sync any existing draft
    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }
  });

  conn.on('data', (data) => {
    if (data.type === 'HANDSHAKE') {
      connectedDevice.textContent = `Linked: ${data.device}`;
      showToast(`Connected to ${data.device}`);
    } else if (data.type === 'SYNC_TEXT') {
      isRemoteInput = true;
      editor.value = data.text;
      localStorage.setItem(getCacheKey(), data.text);
      updateCharCount();
      triggerArrivalAnimation();
      isRemoteInput = false;
    } else if (data.type === 'SYNC_FILE') {
      renderIncomingFile(data);
      showToast(`Received ${data.name}`);
    }
  });

  conn.on('close', () => {
    updateStatus(false, 'Peer disconnected');
    connectedDevice.textContent = 'Standby';
    activeConnection = null;
  });
}

function updateStatus(isLive, label) {
  statusBeacon.className = 'status-beacon' + (isLive ? ' live' : '');
  statusLabel.textContent = label;
}

function triggerArrivalAnimation() {
  editorCard.classList.remove('receiving-pulse');
  void editorCard.offsetWidth;
  editorCard.classList.add('receiving-pulse');

  syncPing.classList.add('show');
  setTimeout(() => syncPing.classList.remove('show'), 1500);
}

// --- 3. Typing Sync with Debounce ---
let typingTimer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(getCacheKey(), editor.value);

  if (isRemoteInput || !activeConnection) return;

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    activeConnection.send({ type: 'SYNC_TEXT', text: editor.value });
  }, 100);
});

// --- 4. File Sharing ---
sendFileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (!activeConnection) {
    showToast('Wait until devices are linked before sending files');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      type: 'SYNC_FILE',
      name: file.name,
      size: formatSize(file.size),
      data: reader.result
    };
    activeConnection.send(payload);
    renderIncomingFile(payload, true);
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

function renderIncomingFile({ name, size, data }, isSelf = false) {
  const card = document.createElement('div');
  card.className = 'incoming-card';
  card.innerHTML = `
    <div>
      <div class="file-title">${isSelf ? '📤 Sent: ' : '📥 Received: '}${name}</div>
      <div class="file-size-tag">${size}</div>
    </div>
    <a href="${data}" download="${name}" class="download-link">Download</a>
  `;
  filesDeck.prepend(card);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// --- 5. Manual Room Switch & Actions ---
joinRoomBtn.addEventListener('click', () => {
  const inputCode = manualRoomInput.value.trim().toLowerCase();
  if (!inputCode) return;
  window.location.hash = inputCode;
  window.location.reload();
});

newRoomBtn.addEventListener('click', () => {
  window.location.hash = generateRoomCode();
  window.location.reload();
});

copyPromptBtn.addEventListener('click', async () => {
  if (!editor.value) return;
  await navigator.clipboard.writeText(editor.value);
  copyLabel.textContent = 'Copied!';
  setTimeout(() => (copyLabel.textContent = 'Copy Prompt'), 1500);
});

clearBtn.addEventListener('click', () => {
  editor.value = '';
  updateCharCount();
  localStorage.removeItem(getCacheKey());
  if (activeConnection) {
    activeConnection.send({ type: 'SYNC_TEXT', text: '' });
  }
});

copyUrlBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(getFullShareUrl());
  showToast('Room link copied!');
});

qrBtn.addEventListener('click', () => {
  refreshQR();
  roomLinkText.textContent = getFullShareUrl();
  qrModal.classList.add('open');
});

closeModalBtn.addEventListener('click', () => qrModal.classList.remove('open'));
qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.classList.remove('open');
});

// Theme handling
const savedTheme = localStorage.getItem('airtext_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeSvg(savedTheme);

themeToggleBtn.addEventListener('click', () => {
  const curr = document.documentElement.getAttribute('data-theme');
  const target = curr === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', target);
  localStorage.setItem('airtext_theme', target);
  updateThemeSvg(target);
});

function updateThemeSvg(theme) {
  themeIcon.innerHTML = theme === 'dark'
    ? '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>'
    : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// Start peer connection with active room
connectToRoom(activeRoomCode);
