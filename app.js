// --- AirText: Zero-Friction Enterprise Cloud Relay (Firebase REST) ---
(function () {
  'use strict';

  // UI Elements
  let editor, chars, roomCodeDisplay, networkText, flash, statusDot, statusLabel;
  let peerLabel, clearBtn, copyBtn, copyLinkBtn, resetRoomBtn, joinInput, joinBtn;
  let qrBtn, qrModal, closeModalBtn, qrCanvas, themeBtn, toast, sendFileBtn, fileInput, filesDeck;

  // Session State
  let isRemoteInput = false;
  let pollTimer = null;
  let heartbeatTimer = null;
  let isPolling = false;
  let lastReceivedMid = null;

  let isHost = true;
  let activeRoom = '';
  let cacheKey = '';
  const myClientId = 'cli_' + Math.random().toString(36).substring(2, 9);

  // ⚠️ Sanitize base URL (guaranteed no trailing slash)
  const RAW_FIREBASE_URL = 'https://airtext-relay-default-rtdb.firebaseio.com';
  const FIREBASE_BASE = RAW_FIREBASE_URL.replace(/\/+$/, '');

  function generateSlug() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let slug = '';
    for (let i = 0; i < 6; i++) {
      slug += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return slug;
  }

  function getFullShareUrl() {
    return `${window.location.origin}${window.location.pathname}#${activeRoom}?role=guest`;
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

  // --- 1. Cloud Storage Dispatchers & Listeners ---
  async function publishPayload(payload) {
    const packet = {
      mid: 'm_' + Math.random().toString(36).substring(2, 9),
      senderId: myClientId,
      time: Date.now(),
      ...payload
    };
    lastReceivedMid = packet.mid;

    try {
      // PUT overwrites the sync node in place to keep storage near zero
      await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}/sync.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet)
      });
    } catch (err) {
      console.warn('Publish error:', err);
    }
  }

  async function pollCloudUpdates() {
    if (isPolling) return;
    isPolling = true;

    try {
      // Cache-buster query prevents proxy caching
      const res = await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}/sync.json?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.mid && data.mid !== lastReceivedMid) {
          lastReceivedMid = data.mid;

          // Process payload only if sent by the other device
          if (data.senderId !== myClientId) {
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
          }
        }
      }

      // Check peers presence
      const presenceRes = await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}/presence.json?t=${Date.now()}`);
      if (presenceRes.ok) {
        const presence = await presenceRes.json();
        if (presence && typeof presence === 'object') {
          const now = Date.now();
          // Consider a peer active if they posted a heartbeat in the last 6 seconds
          const activePeers = Object.values(presence).filter(p => now - p.lastSeen < 6000);

          if (activePeers.length > 1) {
            updateStatus(true, 'Cloud Synced (Firewall Bypassed)');
            logStatus('Connected via Secure Cloud Relay');
            if (peerLabel) peerLabel.textContent = `${activePeers.length - 1} peer connected`;
          } else {
            updateStatus(false, 'Waiting for peer...');
            logStatus('Room active. Scan QR on 2nd device!');
            if (peerLabel) peerLabel.textContent = '0 peers connected';
          }
        }
      }
    } catch (err) {
      // Suppress network jitter logs while polling
    } finally {
      isPolling = false;
    }

    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollCloudUpdates, 1200);
  }

  async function sendHeartbeat() {
    try {
      await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}/presence/${myClientId}.json`, {
        method: 'PUT',
        body: JSON.stringify({ lastSeen: Date.now(), isHost: isHost })
      });
    } catch (e) {}
  }

  // Complete cleanup: Purge this room entirely from Firebase
  function cleanupRoomData() {
    if (!activeRoom || !FIREBASE_BASE) return;
    const roomUrl = `${FIREBASE_BASE}/rooms/${activeRoom}.json`;

    try {
      fetch(roomUrl, {
        method: 'DELETE',
        keepalive: true
      }).catch(() => {});
    } catch (e) {}

    console.log(`[AirText] Dispatched cloud purge for room #${activeRoom}`);
  }

  // --- 2. Application Initialization ---
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

    const rawHash = window.location.hash.replace('#', '').trim().toLowerCase();
    const isGuestParam = rawHash.includes('role=guest');
    const cleanRoomCode = rawHash.split('?')[0].replace(/[^a-z0-9]/g, '');

    if (!cleanRoomCode) {
      activeRoom = generateSlug();
      isHost = true;
      window.history.replaceState(null, '', '#' + activeRoom);
    } else {
      activeRoom = cleanRoomCode;
      isHost = !isGuestParam;
    }

    if (roomCodeDisplay) {
      roomCodeDisplay.textContent = '#' + activeRoom + (isHost ? ' (Host)' : ' (Guest)');
    }

    cacheKey = `airtext_draft_${activeRoom}`;

    if (editor) {
      editor.value = localStorage.getItem(cacheKey) || '';
      updateCharCount();

      let typingTimer;
      editor.addEventListener('input', () => {
        updateCharCount();
        localStorage.setItem(cacheKey, editor.value);

        if (isRemoteInput) return;

        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          publishPayload({ type: 'SYNC_TEXT', text: editor.value });
        }, 100);
      });
    }

    if (sendFileBtn && fileInput) {
      sendFileBtn.addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;

        if (file.size > 8 * 1024 * 1024) {
          showToast('File too large (Max 8MB for cloud relay)');
          fileInput.value = '';
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          const payload = {
            type: 'SYNC_FILE',
            name: file.name,
            size: formatFileSize(file.size),
            data: reader.result
          };
          publishPayload(payload);
          renderFileCard(file.name, payload.size, reader.result, true);
          showToast(`Sent ${file.name}`);
        };
        reader.readAsDataURL(file);
        fileInput.value = '';
      });
    }

    if (resetRoomBtn) {
      resetRoomBtn.addEventListener('click', () => {
        if (confirm('Start a new room? This will purge all cloud data for this room.')) {
          cleanupRoomData();
          localStorage.removeItem(cacheKey);
          clearTimeout(pollTimer);
          clearInterval(heartbeatTimer);
          window.location.hash = '';
          window.location.reload();
        }
      });
    }

    if (joinBtn && joinInput) {
      joinBtn.addEventListener('click', () => {
        const code = joinInput.value.trim().toLowerCase();
        if (!code) return;
        window.location.hash = code + '?role=guest';
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
        publishPayload({ type: 'SYNC_TEXT', text: '' });
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
        while (qrCanvas.firstChild) {
          qrCanvas.removeChild(qrCanvas.firstChild);
        }
        const shareUrl = getFullShareUrl();
        const qrImg = document.createElement('img');
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}`;
        qrImg.alt = 'Scan to Join';
        qrImg.style.width = '180px';
        qrImg.style.height = '180px';
        qrImg.style.display = 'block';
        qrImg.style.margin = '0 auto';
        qrCanvas.appendChild(qrImg);
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

    // Attach lifecycle exit purges (clean Firebase when closing tab/navigating away)
    window.addEventListener('pagehide', cleanupRoomData);
    window.addEventListener('beforeunload', cleanupRoomData);

    // Initial setup: start heartbeat and update poller
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, 3000);
    pollCloudUpdates();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();

 
              
        
