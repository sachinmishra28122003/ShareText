// --- AirText: Fast & Reliable P2P Sync (PeerJS Engine) ---
(function () {
  'use strict';

  let editor, chars, roomCodeDisplay, networkText, flash, statusDot, statusLabel;
  let peerLabel, clearBtn, copyBtn, copyLinkBtn, resetRoomBtn, joinInput, joinBtn;
  let qrBtn, qrModal, closeModalBtn, qrCanvas, themeBtn, toast, sendFileBtn, fileInput, filesDeck;

  let peer = null;
  let activeConn = null;
  let isRemoteInput = false;
  let activeRoom = '';
  let cacheKey = '';

  function generateSlug() {
    const c = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  function getFullShareUrl() {
    return `${window.location.origin}${window.location.pathname}#${activeRoom}`;
  }

  function logStatus(msg) {
    console.log('[AirText]', msg);
    if (networkText) networkText.textContent = msg;
  }

  function updateStatus(isLive, label) {
    if (statusDot) statusDot.className = 'status-dot' + (isLive ? ' active' : '');
    if (statusLabel) statusLabel.textContent = label;
  }

  function showToast(text) {
    if (toast) {
      toast.textContent = text;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  }

  function triggerPulse() {
    if (flash) {
      flash.classList.add('show');
      setTimeout(() => flash.classList.remove('show'), 900);
    }
  }

  function updateCharCount() {
    if (chars && editor) chars.textContent = `${editor.value.length} characters`;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function renderFileCard(name, size, dataUri, isSelf) {
    if (!filesDeck) return;
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

  // --- WebRTC Peer Setup ---
  function initPeer() {
    logStatus('Connecting to signaling network...');
    updateStatus(false, 'Connecting');

    // Deterministic Peer IDs: Host is the room ID, Client is room ID + '_guest'
    const hostId = `airtext_room_${activeRoom}`;
    const guestId = `${hostId}_guest_${Math.random().toString(36).substring(2, 7)}`;

    // Try hosting the room first
    peer = new Peer(hostId, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ]
      }
    });

    peer.on('open', () => {
      logStatus('Signaling ready. Scan QR with 2nd device!');
      updateStatus(false, 'Ready (Host)');
    });

    // Incoming connection (Host receiving Guest)
    peer.on('connection', (conn) => {
      bindConnection(conn);
    });

    peer.on('error', (err) => {
      // If host ID is already taken, this device is the Guest joining an existing room
      if (err.type === 'unavailable-id') {
        peer.destroy();
        peer = new Peer(guestId);

        peer.on('open', () => {
          logStatus('Room found! Linking devices...');
          const conn = peer.connect(hostId, { reliable: true });
          bindConnection(conn);
        });
      } else {
        console.warn('Peer error:', err);
        logStatus('Network error. Retrying in 3s...');
        setTimeout(initPeer, 3000);
      }
    });
  }

  function bindConnection(conn) {
    activeConn = conn;

    conn.on('open', () => {
      updateStatus(true, 'Direct P2P Synced');
      logStatus('Direct P2P Synced');
      if (peerLabel) peerLabel.textContent = '1 device connected';
      showToast('Device connected!');

      if (editor && editor.value) {
        conn.send({ type: 'SYNC_TEXT', text: editor.value });
      }
    });

    conn.on('data', (data) => {
      if (data.type === 'SYNC_TEXT' && editor) {
        isRemoteInput = true;
        editor.value = data.text;
        localStorage.setItem(cacheKey, data.text);
        updateCharCount();
        triggerPulse();
        isRemoteInput = false;
      } else if (data.type === 'SYNC_FILE') {
        renderFileCard(data.name, data.size, data.data, false);
        showToast(`Received ${data.name}`);
      }
    });

    conn.on('close', () => {
      updateStatus(false, 'Disconnected');
      if (peerLabel) peerLabel.textContent = '0 devices connected';
      logStatus('Peer disconnected.');
    });
  }

  // --- App Initialization ---
  function initApp() {
    editor = document.getElementById('editor');
    chars = document.getElementById('chars');
    roomCodeDisplay = document.getElementById('roomCodeDisplay');
    networkText = document.getElementById('networkText');
    flash = document.getElementById('flash');
    statusDot = document.getElementById('statusDot');
    statusLabel = document.getElementById('statusLabel');
    peerLabel = document.getElementById('peerLabel');
    clearBtn = document.getElementById('clearBtn');
    copyBtn = document.getElementById('copyBtn');
    copyLinkBtn = document.getElementById('copyLinkBtn');
    resetRoomBtn = document.getElementById('resetRoomBtn');
    joinInput = document.getElementById('joinInput');
    joinBtn = document.getElementById('joinBtn');
    qrBtn = document.getElementById('qrBtn');
    qrModal = document.getElementById('qrModal');
    closeModalBtn = document.getElementById('closeModalBtn');
    qrCanvas = document.getElementById('qrCanvas');
    themeBtn = document.getElementById('themeBtn');
    toast = document.getElementById('toast');
    sendFileBtn = document.getElementById('sendFileBtn');
    fileInput = document.getElementById('fileInput');
    filesDeck = document.getElementById('filesDeck');

    activeRoom = window.location.hash.replace('#', '').trim().toLowerCase();
    if (!activeRoom) {
      activeRoom = generateSlug();
      window.history.replaceState(null, '', '#' + activeRoom);
    }
    if (roomCodeDisplay) {
      roomCodeDisplay.textContent = '#' + activeRoom;
    }
    cacheKey = `airtext_draft_${activeRoom}`;

    if (editor) {
      editor.value = localStorage.getItem(cacheKey) || '';
      updateCharCount();

      let typingTimer;
      editor.addEventListener('input', () => {
        updateCharCount();
        localStorage.setItem(cacheKey, editor.value);

        if (isRemoteInput || !activeConn || !activeConn.open) return;

        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          activeConn.send({ type: 'SYNC_TEXT', text: editor.value });
        }, 80);
      });
    }

    if (sendFileBtn && fileInput) {
      sendFileBtn.addEventListener('click', () => {
        if (!activeConn || !activeConn.open) {
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
          activeConn.send(payload);
          renderFileCard(file.name, payload.size, reader.result, true);
          showToast(`Sent ${file.name}`);
        };
        reader.readAsDataURL(file);
        fileInput.value = '';
      });
    }

    if (resetRoomBtn) {
      resetRoomBtn.addEventListener('click', () => {
        if (confirm('Start a new room?')) {
          localStorage.removeItem(cacheKey);
          if (peer) peer.destroy();
          window.location.hash = generateSlug();
          window.location.reload();
        }
      });
    }

    if (joinBtn && joinInput) {
      joinBtn.addEventListener('click', () => {
        const code = joinInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!code) return;
        window.location.hash = code;
        window.location.reload();
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        if (!editor || !editor.value) return;
        await navigator.clipboard.writeText(editor.value);
        showToast('Copied to clipboard!');
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (editor) editor.value = '';
        updateCharCount();
        localStorage.removeItem(cacheKey);
        if (activeConn && activeConn.open) {
          activeConn.send({ type: 'SYNC_TEXT', text: '' });
        }
      });
    }

    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(getFullShareUrl());
        showToast('Room link copied!');
      });
    }

    if (qrBtn && qrModal && qrCanvas) {
      qrBtn.addEventListener('click', () => {
        qrCanvas.innerHTML = '';
        if (typeof window.QRCode !== 'undefined') {
          new window.QRCode(qrCanvas, {
            text: getFullShareUrl(),
            width: 180,
            height: 180,
            colorDark: '#0a0b0e',
            colorLight: '#ffffff',
            correctLevel: window.QRCode.CorrectLevel.M
          });
        }
        qrModal.classList.add('open');
      });
    }

    if (closeModalBtn && qrModal) {
      closeModalBtn.addEventListener('click', () => qrModal.classList.remove('open'));
      qrModal.addEventListener('click', (e) => {
        if (e.target === qrModal) qrModal.classList.remove('open');
      });
    }

    if (themeBtn) {
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
    }

    initPeer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();



