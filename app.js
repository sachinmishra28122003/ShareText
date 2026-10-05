// --- AirText: Zero-Dependency Corporate-Safe WebRTC Sync ---
(function () {
  'use strict';

  // UI Elements
  let editor, chars, roomCodeDisplay, networkText, flash, statusDot, statusLabel;
  let peerLabel, clearBtn, copyBtn, copyLinkBtn, resetRoomBtn, joinInput, joinBtn;
  let qrBtn, qrModal, closeModalBtn, qrCanvas, themeBtn, toast, sendFileBtn, fileInput, filesDeck;

  // WebRTC & Session State
  let rtcPeer = null;
  let dataChannel = null;
  let isRemoteInput = false;
  let pollTimer = null;
  let isPolling = false;
  let iceCandidateQueue = [];
  const processedMessageIds = new Set();

  let isHost = true;
  let activeRoom = '';
  let cacheKey = '';
  let sendBucketUrl = '';
  let listenBucketUrl = '';

  // Free Open Relay bucket for AirText
  const KV_BUCKET = 'https://kvdb.io/4y2N6o1QfHqG3qUf1zHq4A';

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
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

  // --- 1. Clean Key-Value HTTPS Signaling ---
  async function sendSignal(payload) {
    const packet = {
      mid: Math.random().toString(36).substring(2, 9),
      time: Date.now(),
      ...payload
    };
    try {
      // Plain text payload avoids CORS preflight OPTIONS requests
      await fetch(sendBucketUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(packet)
      });
    } catch (e) {
      console.warn('Signal send error:', e);
    }
  }

  async function pollSignaling() {
    if (dataChannel && dataChannel.readyState === 'open') return;
    if (isPolling) return;
    isPolling = true;

    try {
      const res = await fetch(`${listenBucketUrl}?t=${Date.now()}`);
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim().length > 0) {
          const msg = JSON.parse(text);
          if (msg && msg.mid && !processedMessageIds.has(msg.mid)) {
            processedMessageIds.add(msg.mid);
            handleSignalingMessage(msg);
          }
        }
      }
    } catch (err) {
      console.warn('Poll error:', err);
    } finally {
      isPolling = false;
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
      pollTimer = setTimeout(pollSignaling, 1800);
    }
  }

  // --- 2. Deterministic WebRTC Setup ---
  function initPeerConnection() {
    if (rtcPeer) return rtcPeer;

    rtcPeer = new RTCPeerConnection(rtcConfig);

    rtcPeer.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: 'ICE_CANDIDATE', candidate: e.candidate });
      }
    };

    rtcPeer.oniceconnectionstatechange = () => {
      console.log('[ICE State]', rtcPeer.iceConnectionState);
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
        logStatus('Guest detected! Creating offer...');
        const peer = initPeerConnection();
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          sendSignal({ type: 'OFFER', sdp: peer.localDescription });
        } catch (err) {
          console.error('Host offer error:', err);
        }
      } else if (data.type === 'ANSWER') {
        logStatus('Received answer. Linking...');
        if (rtcPeer && rtcPeer.signalingState === 'have-local-offer') {
          await rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));
          while (iceCandidateQueue.length > 0) {
            await rtcPeer.addIceCandidate(iceCandidateQueue.shift());
          }
        }
      } else if (data.type === 'ICE_CANDIDATE') {
        applyIceCandidate(data.candidate);
      }
    } else {
      if (data.type === 'OFFER') {
        logStatus('Received offer. Creating answer...');
        const peer = initPeerConnection();
        try {
          await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
          while (iceCandidateQueue.length > 0) {
            await peer.addIceCandidate(iceCandidateQueue.shift());
          }
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendSignal({ type: 'ANSWER', sdp: peer.localDescription });
        } catch (err) {
          console.error('Guest answer error:', err);
        }
      } else if (data.type === 'ICE_CANDIDATE') {
        applyIceCandidate(data.candidate);
      }
    }
  }

  function applyIceCandidate(candidateData) {
    const candidate = new RTCIceCandidate(candidateData);
    if (rtcPeer && rtcPeer.remoteDescription && rtcPeer.remoteDescription.type) {
      rtcPeer.addIceCandidate(candidate).catch((e) => console.warn('ICE add error:', e));
    } else {
      iceCandidateQueue.push(candidate);
    }
  }

  // --- 3. DataChannel Setup ---
  function bindDataChannel(channel) {
    channel.onopen = () => {
      clearTimeout(pollTimer);

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
        console.warn('Channel parse error:', err);
      }
    };

    channel.onclose = () => {
      updateStatus(false, 'Disconnected');
      if (peerLabel) peerLabel.textContent = '0 devices connected';
      logStatus('Peer disconnected. Refresh page to pair again.');
    };
  }

  function startSignaling() {
    logStatus(isHost ? 'Signaling ready. Scan QR with 2nd device!' : 'Connecting to Host...');
    updateStatus(false, 'Ready');

    if (!isHost) {
      const announceInterval = setInterval(() => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
          sendSignal({ type: 'GUEST_JOINED' });
        } else {
          clearInterval(announceInterval);
        }
      }, 1500);
      sendSignal({ type: 'GUEST_JOINED' });
    }

    pollTimer = setTimeout(pollSignaling, 500);
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

    // Dedicated key endpoints: Host writes h2g & reads g2h; Guest writes g2h & reads h2g
    if (isHost) {
      sendBucketUrl = `${KV_BUCKET}/${activeRoom}_h2g`;
      listenBucketUrl = `${KV_BUCKET}/${activeRoom}_g2h`;
    } else {
      sendBucketUrl = `${KV_BUCKET}/${activeRoom}_g2h`;
      listenBucketUrl = `${KV_BUCKET}/${activeRoom}_h2g`;
    }

    if (editor) {
      editor.value = localStorage.getItem(cacheKey) || '';
      updateCharCount();

      let typingTimer;
      editor.addEventListener('input', () => {
        updateCharCount();
        localStorage.setItem(cacheKey, editor.value);

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
          localStorage.removeItem(cacheKey);
          clearTimeout(pollTimer);
          window.location.hash = generateSlug();
          window.location.reload();
        }
      });
    }

    if (joinBtn && joinInput) {
      joinBtn.addEventListener('click', () => {
        const code = joinInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
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

