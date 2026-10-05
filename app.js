// --- AirText: Glare-Free Corporate WebRTC Engine ---
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
  let handshakeTimer = null;
  let iceCandidateQueue = [];
  const processedMessageIds = new Set();

  const mySessionId = 's_' + Math.random().toString(36).substring(2, 9);
  const sessionStartTime = Date.now();
  let activeRoom = '';
  let cacheKey = '';
  let relayEndpoint = '';

  // Free TURN relay on Port 443 TCP for corporate symmetric NATs
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
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

  // --- 1. Freshness-Guarded HTTPS Signaling ---
  async function sendSignal(payload) {
    const packet = {
      mid: Math.random().toString(36).substring(2, 9),
      sender: mySessionId,
      time: Date.now(),
      ...payload
    };
    try {
      await fetch(relayEndpoint, {
        method: 'POST',
        headers: { 'Priority': 'low', 'Title': 'Sig' },
        body: JSON.stringify(packet)
      });
    } catch (e) {
      console.warn('Signal send failed:', e);
    }
  }

  async function pollSignaling() {
    if (dataChannel && dataChannel.readyState === 'open') return;
    if (isPolling) return;
    isPolling = true;

    try {
      // Poll recent 6 seconds only so old session messages are never accepted
      const res = await fetch(`${relayEndpoint}/json?poll=1&since=6s`);
      if (res.ok) {
        const text = await res.text();
        const lines = text.trim().split('\n');

        for (const line of lines) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.event === 'message' && entry.message) {
              const msg = JSON.parse(entry.message);

              // Discard messages sent before this page loaded or already processed
              if (!msg || !msg.mid || processedMessageIds.has(msg.mid)) continue;
              if (msg.time && msg.time < sessionStartTime - 3000) continue;

              processedMessageIds.add(msg.mid);
              handleSignalingMessage(msg);
            }
          } catch (ignore) {}
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

  // --- 2. Deterministic Glare-Free WebRTC (Tie-Breaker Initiator) ---
  function getOrCreatePeerConnection(isInitiator) {
    if (rtcPeer) return rtcPeer;

    logStatus(isInitiator ? 'Negotiating (Offer)...' : 'Negotiating (Answer)...');
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

    if (isInitiator) {
      dataChannel = rtcPeer.createDataChannel('airtext_channel', { reliable: true });
      bindDataChannel(dataChannel);

      rtcPeer.createOffer().then((offer) => {
        return rtcPeer.setLocalDescription(offer);
      }).then(() => {
        sendSignal({ type: 'OFFER', sdp: rtcPeer.localDescription });
      }).catch((err) => console.error('Offer error:', err));
    } else {
      rtcPeer.ondatachannel = (e) => {
        logStatus('Data link opened!');
        dataChannel = e.channel;
        bindDataChannel(dataChannel);
      };
    }

    return rtcPeer;
  }

  function handleSignalingMessage(data) {
    if (!data || data.sender === mySessionId) return;

    if (data.type === 'PING') {
      logStatus('Peer detected! Linking...');
      // Strict tie-breaker: device with lexicographically smaller ID initiates
      if (mySessionId < data.sender && (!rtcPeer || rtcPeer.signalingState === 'stable' && !dataChannel)) {
        getOrCreatePeerConnection(true);
      }
    } else if (data.type === 'OFFER') {
      logStatus('Processing offer...');
      const peer = getOrCreatePeerConnection(false);

      // If we are already negotiating or have a local offer, gracefully roll back if polite
      if (peer.signalingState !== 'stable') {
        if (mySessionId < data.sender) return; // We are impolite; ignore conflicting offer
      }

      peer.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
        while (iceCandidateQueue.length > 0) {
          peer.addIceCandidate(iceCandidateQueue.shift());
        }
        return peer.createAnswer();
      }).then((answer) => {
        return peer.setLocalDescription(answer);
      }).then(() => {
        sendSignal({ type: 'ANSWER', sdp: peer.localDescription });
      }).catch((err) => console.error('Answer creation error:', err));
    } else if (data.type === 'ANSWER') {
      logStatus('Completing handshake...');
      if (rtcPeer && rtcPeer.signalingState === 'have-local-offer') {
        rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
          while (iceCandidateQueue.length > 0) {
            rtcPeer.addIceCandidate(iceCandidateQueue.shift());
          }
        }).catch((err) => console.error('Remote desc error:', err));
      }
    } else if (data.type === 'ICE_CANDIDATE') {
      const candidate = new RTCIceCandidate(data.candidate);
      if (rtcPeer && rtcPeer.remoteDescription && rtcPeer.remoteDescription.type) {
        rtcPeer.addIceCandidate(candidate).catch((e) => console.warn('ICE add error:', e));
      } else {
        iceCandidateQueue.push(candidate);
      }
    }
  }

  // --- 3. DataChannel Setup ---
  function bindDataChannel(channel) {
    channel.onopen = () => {
      clearTimeout(pollTimer);
      clearInterval(handshakeTimer);

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
    logStatus('Signaling ready. Scan QR with 2nd device!');
    updateStatus(false, 'Ready');

    // Heartbeat every 2s until WebRTC data channel opens
    clearInterval(handshakeTimer);
    handshakeTimer = setInterval(() => {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        sendSignal({ type: 'PING' });
      } else {
        clearInterval(handshakeTimer);
      }
    }, 2000);

    sendSignal({ type: 'PING' });
    pollTimer = setTimeout(pollSignaling, 1000);
  }

  // --- 4. Application Init ---
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
    // Namespace signaling topic to isolate from previous room runs
    relayEndpoint = `https://ntfy.sh/airtext_p2p_${activeRoom}`;

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
          clearInterval(handshakeTimer);
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

    // Reliable Dynamic QR Generator (Works every time clicked)
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
