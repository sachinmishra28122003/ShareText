// --- AirText: Zero-Dependency Corporate WebRTC (Self-Cleaning Firebase REST) ---
(function () {
  'use strict';

  // Elements
  let editor, chars, roomCodeDisplay, networkText, flash, statusDot, statusLabel;
  let peerLabel, clearBtn, copyBtn, copyLinkBtn, resetRoomBtn, joinInput, joinBtn;
  let qrBtn, qrModal, closeModalBtn, qrCanvas, themeBtn, toast, sendFileBtn, fileInput, filesDeck;

  // WebRTC & Session State
  let rtcPeer = null;
  let dataChannel = null;
  let isRemoteInput = false;
  let pollTimer = null;
  let isPolling = false;
  let lastHandledMessageId = null;

  let isHost = true;
  let activeRoom = '';
  let cacheKey = '';

  // ⚠️ REPLACE THIS WITH YOUR REALTIME DATABASE URL (No trailing slash)
  const FIREBASE_BASE = 'https://airtext-relay-default-rtdb.firebaseio.com/';

  // Free TURN relays over Port 443 TCP to punch through corporate symmetric firewalls
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay'
      }
    ]
  };

  function generateSlug() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
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

  // Gather STUN/TURN candidates directly into the initial SDP description
  function waitForIceGathering(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        const checkState = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', checkState);
        setTimeout(() => {
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }, 1200);
      }
    });
  }

  // --- 1. Cloud-Optimized Firebase REST Signaling ---
  async function sendSignal(payload) {
    const targetPath = isHost ? 'h2g' : 'g2h';
    const packet = {
      mid: Math.random().toString(36).substring(2, 9),
      time: Date.now(),
      ...payload
    };
    try {
      await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}/${targetPath}.json`, {
        method: 'PUT',
        body: JSON.stringify(packet)
      });
    } catch (e) {
      console.warn('Firebase push error:', e);
    }
  }

  async function pollSignaling() {
    if (dataChannel && dataChannel.readyState === 'open') return;
    if (isPolling) return;
    isPolling = true;

    const listenPath = isHost ? 'g2h' : 'h2g';
    try {
      const res = await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}/${listenPath}.json?t=${Date.now()}`);
      if (res.ok) {
        const msg = await res.json();
        if (msg && msg.mid && msg.mid !== lastHandledMessageId) {
          lastHandledMessageId = msg.mid;
          handleSignalingMessage(msg);
        }
      }
    } catch (err) {
      // Ignore temporary polling glitches
    } finally {
      isPolling = false;
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollSignaling, 1800);
    }
  }

  // Wipe the signaling room node from Firebase completely to save free storage
  async function cleanupFirebaseRoom() {
    try {
      await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}.json`, {
        method: 'DELETE'
      });
      console.log('[AirText] Cleaned up signaling room from Firebase');
    } catch (e) {}
  }

  // --- 2. Deterministic WebRTC Setup ---
  function initPeerConnection() {
    if (rtcPeer) return rtcPeer;

    rtcPeer = new RTCPeerConnection(rtcConfig);

    rtcPeer.oniceconnectionstatechange = () => {
      if (rtcPeer.iceConnectionState === 'connected' || rtcPeer.iceConnectionState === 'completed') {
        logStatus('Direct P2P Synced');
      }
    };

    if (isHost) {
      dataChannel = rtcPeer.createDataChannel('airtext_channel', { reliable: true });
      bindDataChannel(dataChannel);
    } else {
      rtcPeer.ondatachannel = (e) => {
        logStatus('Data link opened!');
        dataChannel = e.channel;
        bindDataChannel(dataChannel);
      };
    }

    return rtcPeer;
  }

  async function handleSignalingMessage(data) {
    if (!data || !data.type) return;

    if (isHost) {
      if (data.type === 'GUEST_JOINED') {
        logStatus('Guest detected! Packaging complete Offer...');
        const peer = initPeerConnection();
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          await waitForIceGathering(peer);
          await sendSignal({ type: 'OFFER', sdp: peer.localDescription.sdp });
        } catch (err) {
          console.error('Host offer creation error:', err);
        }
      } else if (data.type === 'ANSWER') {
        logStatus('Answer received! Finalizing connection...');
        if (rtcPeer && rtcPeer.signalingState === 'have-local-offer') {
          await rtcPeer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
        }
      }
    } else {
      if (data.type === 'OFFER') {
        logStatus('Host offer received! Packaging complete Answer...');
        const peer = initPeerConnection();
        try {
          await peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await waitForIceGathering(peer);
          await sendSignal({ type: 'ANSWER', sdp: peer.localDescription.sdp });
        } catch (err) {
          console.error('Guest answer creation error:', err);
        }
      }
    }
  }

  // --- 3. DataChannel & Instant Self-Cleanup ---
  function bindDataChannel(channel) {
    channel.onopen = () => {
      clearTimeout(pollTimer);

      // Instant Cleanup: Handshake complete, delete cloud data
      cleanupFirebaseRoom();

      updateStatus(true, 'Direct P2P Synced');
      logStatus('Direct P2P Synced (Firewall Bypassed)');
      if (peerLabel) peerLabel.textContent = '1 device connected';
      showToast('Device connected!');

      if (editor && editor.value) {
        channel.send(JSON.stringify({ type: 'SYNC_TEXT', text: editor.value }));
      }
    };

    channel.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
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
      } catch (err) {
        console.warn('Channel error:', err);
      }
    };

    channel.onclose = () => {
      updateStatus(false, 'Disconnected');
      if (peerLabel) peerLabel.textContent = '0 devices connected';
      logStatus('Peer disconnected. Refresh page to pair again.');
    };
  }

  async function startSignaling() {
    logStatus(isHost ? 'Signaling ready. Scan QR with 2nd device!' : 'Connecting to Host...');
    updateStatus(false, 'Ready');

    clearTimeout(pollTimer);

    if (isHost) {
      // Pre-seed an empty node so GET never returns 404
      try {
        await fetch(`${FIREBASE_BASE}/rooms/${activeRoom}.json`, {
          method: 'PUT',
          body: JSON.stringify({ created: Date.now() })
        });
      } catch (e) {}
    } else {
      sendSignal({ type: 'GUEST_JOINED' });
    }

    pollTimer = setTimeout(pollSignaling, 1000);
  }

  // --- 4. Application Initialization ---
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

        // Text synchronization is 100% P2P over WebRTC DataChannel (0 bytes used on Firebase)
        if (isRemoteInput || !dataChannel || dataChannel.readyState !== 'open') return;

        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          dataChannel.send(JSON.stringify({ type: 'SYNC_TEXT', text: editor.value }));
        }, 80);
      });
    }

    if (sendFileBtn && fileInput) {
      sendFileBtn.addEventListener('click', () => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
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
          // File synchronization is 100% P2P over WebRTC DataChannel (0 bytes used on Firebase)
          dataChannel.send(JSON.stringify(payload));
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
          cleanupFirebaseRoom();
          localStorage.removeItem(cacheKey);
          clearTimeout(pollTimer);
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
        if (dataChannel && dataChannel.readyState === 'open') {
          dataChannel.send(JSON.stringify({ type: 'SYNC_TEXT', text: '' }));
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

    startSignaling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
