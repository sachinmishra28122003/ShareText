// --- DOM References ---
const editor = document.getElementById('editor');
const charCount = document.getElementById('charCount');
const currentRoomText = document.getElementById('currentRoomText');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const customRoomInput = document.getElementById('customRoomInput');
const joinCustomBtn = document.getElementById('joinCustomBtn');
const networkState = document.getElementById('networkState');
const flashIndicator = document.getElementById('flashIndicator');
const statusCircle = document.getElementById('statusCircle');
const statusLabel = document.getElementById('statusLabel');
const peerDevice = document.getElementById('peerDevice');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const clearBtn = document.getElementById('clearBtn');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const copyPromptText = document.getElementById('copyPromptText');
const filesContainer = document.getElementById('filesContainer');
const qrToggleBtn = document.getElementById('qrToggleBtn');
const qrModal = document.getElementById('qrModal');
const closeModal = document.getElementById('closeModal');
const modalUrlDisplay = document.getElementById('modalUrlDisplay');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const toast = document.getElementById('toast');

// --- 1. Room Strategy: Auto-Generated or Custom ---
function getRandomCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function getActiveRoom() {
  const hash = window.location.hash.replace('#', '').trim();
  if (hash) {
    return hash.toLowerCase();
  }
  const auto = getRandomCode();
  window.history.replaceState(null, '', `#${auto}`);
  return auto;
}

let activeRoom = getActiveRoom();
currentRoomText.textContent = '#' + activeRoom;

function getShareableURL() {
  return `${window.location.origin}${window.location.pathname}#${activeRoom}`;
}

// Custom Room Switch
joinCustomBtn.addEventListener('click', () => {
  const desired = customRoomInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!desired) return;
  window.location.hash = desired;
  window.location.reload();
});

// Cache Prompt
const cacheKey = `airtext_draft_${activeRoom}`;
editor.value = localStorage.getItem(cacheKey) || '';
updateCharCount();

function updateCharCount() {
  charCount.textContent = `${editor.value.length} characters`;
}

// Device Label
const isPhone = /Android|iPhone|iPad/i.test(navigator.userAgent);
const myPlatform = isPhone ? 'Mobile Device' : 'Laptop / PC';

// --- 2. Real-Time WebRTC P2P (PeerJS + STUN) ---
let peer = null;
let activeConnection = null;
let isRemoteChange = false;

// Standard STUN servers enable cross-network NAT traversal
const peerConfig = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

function startP2P(room) {
  if (peer) peer.destroy();

  const hostID = `airtext-${room}-h`;
  const guestID = `airtext-${room}-g-${Math.random().toString(36).substring(2, 6)}`;

  // Attempt Host role first
  peer = new Peer(hostID, peerConfig);

  peer.on('open', () => {
    setConnectionStatus(false, 'Waiting for other device...');
    networkState.textContent = 'Room active. Awaiting mobile/peer...';
  });

  peer.on('error', (err) => {
    // If host ID exists, become client
    if (err.type === 'unavailable-id') {
      peer.destroy();
      peer = new Peer(guestID, peerConfig);

      peer.on('open', () => {
        setConnectionStatus(false, 'Connecting to room host...');
        networkState.textContent = 'Attempting connection...';
        const conn = peer.connect(hostID, { reliable: true });
        setupDataChannel(conn);
      });
    }
  });

  peer.on('connection', (conn) => {
    setupDataChannel(conn);
  });
}

function setupDataChannel(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    setConnectionStatus(true, 'P2P Connected');
    networkState.textContent = 'Connected (Direct WebRTC DataChannel)';
    conn.send({ type: 'HANDSHAKE', device: myPlatform });

    if (editor.value) {
      conn.send({ type: 'TEXT', text: editor.value });
    }
  });

  conn.on('data', (msg) => {
    if (msg.type === 'HANDSHAKE') {
      peerDevice.textContent = `Linked: ${msg.device}`;
      notify(`Linked to ${msg.device}`);
    } else if (msg.type === 'TEXT') {
      isRemoteChange = true;
      editor.value = msg.text;
      localStorage.setItem(cacheKey, msg.text);
      updateCharCount();
      triggerPulse();
      isRemoteChange = false;
    } else if (msg.type === 'FILE') {
      addFileItem(msg);
      notify(`Received file: ${msg.name}`);
    }
  });

  conn.on('close', () => {
    setConnectionStatus(false, 'Peer disconnected');
    networkState.textContent = 'Peer left. Standing by...';
    peerDevice.textContent = 'No device connected';
    activeConnection = null;
  });
}

function setConnectionStatus(connected, label) {
  statusCircle.className = 'status-circle' + (connected ? ' connected' : '');
  statusLabel.textContent = label;
}

function triggerPulse() {
  flashIndicator.classList.add('active');
  setTimeout(() => flashIndicator.classList.remove('active'), 1200);
}

// --- 3. Synchronized Editor Typing ---
let debouncer;
editor.addEventListener('input', () => {
  updateCharCount();
  localStorage.setItem(cacheKey, editor.value);

  if (isRemoteChange || !activeConnection) return;

  clearTimeout(debouncer);
  debouncer = setTimeout(() => {
    activeConnection.send({ type: 'TEXT', text: editor.value });
  }, 90);
});

// --- 4. File Transfers ---
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (!activeConnection) {
    notify('Pair with your device before sending files.');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      type: 'FILE',
      name: file.name,
      size: formatBytes(file.size),
      data: reader.result
    };
    activeConnection.send(payload);
    addFileItem(payload, true);
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

function addFileItem(file, isOut = false) {
  const item = document.createElement('div');
  item.className = 'file-item';
  item.innerHTML = `
    <div>
      <div class="file-name">${isOut ? '📤 Sent: ' : '📥 Received: '}${file.name}</div>
      <div class="file-size">${file.size}</div>
    </div>
    <a href="${file.data}" download="${file.name}" class="file-download-link">Download</a>
  `;
  filesContainer.prepend(item);
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// --- 5. Action Handlers & QR Modal ---
copyPromptBtn.addEventListener('click', async () => {
  if (!editor.value) return;
  await navigator.clipboard.writeText(editor.value);
  copyPromptText.textContent = 'Copied!';
  setTimeout(() => (copyPromptText.textContent = '📋 Copy Prompt'), 1500);
});

clearBtn.addEventListener('click', () => {
  editor.value = '';
  updateCharCount();
  localStorage.removeItem(cacheKey);
  if (activeConnection) {
    activeConnection.send({ type: 'TEXT', text: '' });
  }
});

copyUrlBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(getShareableURL());
  notify('Room link copied!');
});

// QR Modal Handling
qrToggleBtn.addEventListener('click', () => {
  const qrBox = document.getElementById('qrcode');
  qrBox.innerHTML = '';
  new QRCode(qrBox, {
    text: getShareableURL(),
    width: 170,
    height: 170,
    colorDark: '#0c0d12',
    colorLight: '#ffffff'
  });
  modalUrlDisplay.textContent = getShareableURL();
  qrModal.classList.add('open');
});

closeModal.addEventListener('click', () => qrModal.classList.remove('open'));
qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.classList.remove('open');
});

// Theme Toggle
const storedTheme = localStorage.getItem('airtext_theme') || 'dark';
document.documentElement.setAttribute('data-theme', storedTheme);
themeIcon.textContent = storedTheme === 'dark' ? '☀' : '🌙';

themeToggleBtn.addEventListener('click', () => {
  const now = document.documentElement.getAttribute('data-theme');
  const next = now === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('airtext_theme', next);
  themeIcon.textContent = next === 'dark' ? '☀' : '🌙';
});

function notify(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// Initialize
startP2P(activeRoom);
