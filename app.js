// --- DOM References ---
const editor = document.getElementById('editor');
const charCount = document.getElementById('charCount');
const roomLabel = document.getElementById('roomLabel');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const copyBtn = document.getElementById('copyBtn');
const copyBtnText = document.getElementById('copyBtnText');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const clearBtn = document.getElementById('clearBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const filesSection = document.getElementById('filesSection');
const fileList = document.getElementById('fileList');

// --- Theme Handling ---
const storedTheme = localStorage.getItem('airpad_theme') || 'dark';
document.documentElement.setAttribute('data-theme', storedTheme);
updateThemeIcon(storedTheme);

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('airpad_theme', next);
  updateThemeIcon(next);
});

function updateThemeIcon(theme) {
  themeIcon.textContent = theme === 'dark' ? '☀️️' : '🌙';
}

// --- Room & Cache Initialization ---
let roomKey = window.location.hash.slice(1).trim();
if (!roomKey) {
  // Use a default or generate a random memorable hash
  roomKey = 'scratchpad';
  window.location.hash = roomKey;
}
roomLabel.textContent = '#' + roomKey;

// Restore prompt from browser cache
const cachedText = localStorage.getItem(`airpad_text_${roomKey}`) || '';
editor.value = cachedText;
updateCounter();

function updateCounter() {
  charCount.textContent = `${editor.value.length} characters`;
}

// --- WebRTC Peer-to-Peer Networking ---
let peer = null;
let activeConnection = null;
let isRemoteInput = false;

const hostId = `airpad-h-${roomKey}`;
const clientId = `airpad-c-${roomKey}`;

function initPeer() {
  // Try connecting as Host first
  peer = new Peer(hostId);

  peer.on('open', () => {
    setStatus('waiting', 'Ready • Waiting for phone...');
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      // Host exists: switch role to Client and connect
      peer.destroy();
      peer = new Peer(clientId);
      peer.on('open', () => {
        const conn = peer.connect(hostId, { reliable: true });
        bindConnection(conn);
      });
    } else {
      console.warn('Peer status:', err.type);
    }
  });

  peer.on('connection', (conn) => {
    bindConnection(conn);
  });
}

function bindConnection(conn) {
  activeConnection = conn;

  conn.on('open', () => {
    setStatus('connected', 'Live P2P Synced');
    // If we have cached text, sync it to peer immediately
    if (editor.value) {
      conn.send({ type: 'SYNC_TEXT', text: editor.value });
    }
  });

  conn.on('data', (payload) => {
    if (payload.type === 'SYNC_TEXT') {
      isRemoteInput = true;
      editor.value = payload.text;
      localStorage.setItem(`airpad_text_${roomKey}`, payload.text);
      updateCounter();
      isRemoteInput = false;
    } else if (payload.type === 'SHARE_FILE') {
      appendFileCard(payload);
    }
  });

  conn.on('close', () => {
    setStatus('waiting', 'Device disconnected');
    activeConnection = null;
  });
}

function setStatus(state, message) {
  statusDot.className = 'status-dot';
  if (state === 'connected') statusDot.classList.add('connected');
  if (state === 'disconnected') statusDot.classList.add('disconnected');
  statusText.textContent = message;
}

// --- Input Sync Event ---
let debounceTimeout;
editor.addEventListener('input', () => {
  updateCounter();
  localStorage.setItem(`airpad_text_${roomKey}`, editor.value);

  if (isRemoteInput || !activeConnection) return;

  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    activeConnection.send({ type: 'SYNC_TEXT', text: editor.value });
  }, 100);
});

// --- File Transfer ---
uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (!activeConnection) {
    alert('Please wait until both devices are connected to send files.');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const payload = {
      type: 'SHARE_FILE',
      name: file.name,
      size: formatFileSize(file.size),
      data: reader.result
    };
    activeConnection.send(payload);
    appendFileCard(payload, true); // show in self feed as sent
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

function appendFileCard({ name, size, data }, isSelf = false) {
  filesSection.style.display = 'flex';
  const card = document.createElement('div');
  card.className = 'file-card';
  card.innerHTML = `
    <div class="file-meta">
      <span class="file-name">${isSelf ? '📤 ' : '📥 '} ${name}</span>
      <span class="file-size">${size}</span>
    </div>
    <a class="download-link" href="${data}" download="${name}">Download</a>
  `;
  fileList.prepend(card);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// --- Copy & Clear ---
copyBtn.addEventListener('click', async () => {
  if (!editor.value) return;
  try {
    await navigator.clipboard.writeText(editor.value);
    copyBtnText.textContent = 'Copied!';
    setTimeout(() => (copyBtnText.textContent = 'Copy Prompt'), 1500);
  } catch (err) {
    console.error('Failed to copy', err);
  }
});

clearBtn.addEventListener('click', () => {
  editor.value = '';
  updateCounter();
  localStorage.removeItem(`airpad_text_${roomKey}`);
  if (activeConnection) {
    activeConnection.send({ type: 'SYNC_TEXT', text: '' });
  }
});

// Start network
initPeer();