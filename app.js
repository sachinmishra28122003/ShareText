// --- AirText: 100% Native WebRTC via HTTPS Long-Polling (No External Libraries) ---
(function () {
  'use strict';

  // UI Elements
  let editor, chars, roomCodeDisplay, networkText, flash, statusDot, statusLabel;
  let peerLabel, clearBtn, copyBtn, copyLinkBtn, resetRoomBtn, joinInput, joinBtn;
  let qrBtn, qrModal, closeModalBtn, qrCanvas, themeBtn, toast, sendFileBtn, fileInput, filesDeck;

  // WebRTC & State
  let rtcPeer = null;
  let dataChannel = null;
  let isRemoteInput = false;
  let signalingTimer = null;
  let handshakeTimer = null;
  let lastSeenTimestamp = 0;
  let iceCandidateQueue = [];

  const myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
  let activeRoom = '';
  let topic = '';
  let cacheKey = '';

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };

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

  // --- 1. Pure HTTPS Signaling ---
  async function sendSignal(payload) {
    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn('Signaling send error:', err);
    }
  }

  async function pollSignaling() {
    if (dataChannel && dataChannel.readyState === 'open') return;

    try {
      const url = `https://ntfy.sh/${topic}/json?poll=1&since=${lastSeenTimestamp || '10s'}`;
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        const lines = text.trim().split('\n');

        for (const line of lines) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.time && entry.time > lastSeenTimestamp) {
              lastSeenTimestamp = entry.time;
            }
            if (entry.event === 'message' && entry.message) {
              const signal = JSON.parse(entry.message);
              handleSignalingMessage(signal);
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      console.warn('Signaling poll check failed:', err);
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
      signalingTimer = setTimeout(pollSignaling, 1000);
    }
  }

  function startSignaling() {
    logStatus('Signaling ready. Scan QR with 2nd device!');
    updateStatus(false, 'Ready');

    pollSignaling();

    clearInterval(handshakeTimer);
    handshakeTimer = setInterval(() => {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        sendSignal({ type: 'PING_PEER', from: myPeerId });
      } else {
        clearInterval(handshakeTimer);
      }
    }, 1500);

    sendSignal({ type: 'PING_PEER', from: myPeerId });
  }

  // --- 2. Standard Native WebRTC Connection ---
  function getOrCreatePeerConnection(isInitiator) {
    if (rtcPeer) return rtcPeer;

    logStatus(isInitiator ? 'Initiating P2P offer...' : 'Waiting for P2P offer...');
    rtcPeer = new RTCPeerConnection(rtcConfig);

    rtcPeer.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: 'ICE_CANDIDATE', candidate: e.candidate, from: myPeerId });
      }
    };

    if (isInitiator) {
      dataChannel = rtcPeer.createDataChannel('airtext_channel', { reliable: true });
      bindDataChannel(dataChannel);

      rtcPeer.createOffer().then((offer) => {
        return rtcPeer.setLocalDescription(offer);
      }).then(() => {
        sendSignal({ type: 'OFFER', sdp: rtcPeer.localDescription, from: myPeerId });
      }).catch((err) => console.error('Offer error:', err));
    } else {
      rtcPeer.ondatachannel = (e) => {
        logStatus('Data channel connected!');
        dataChannel = e.channel;
        bindDataChannel(dataChannel);
      };
    }

    return rtcPeer;
  }

  function handleSignalingMessage(data) {
    if (!data || data.from === myPeerId) return;

    if (data.type === 'PING_PEER') {
      logStatus('Peer detected! Negotiating link...');
      if (myPeerId < data.from && (!rtcPeer || rtcPeer.connectionState === 'disconnected')) {
        getOrCreatePeerConnection(true);
      }
    } else if (data.type === 'OFFER') {
      logStatus('Received offer. Answering...');
      const peer = getOrCreatePeerConnection(false);

      peer.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
        while (iceCandidateQueue.length > 0) {
          peer.addIceCandidate(iceCandidateQueue.shift());
        }
        return peer.createAnswer();
      }).then((answer) => {
        return peer.setLocalDescription(answer);
      }).then(() => {
        sendSignal({ type: 'ANSWER', sdp: peer.localDescription, from: myPeerId });
      }).catch((err) => console.error('Answer error:', err));
    } else if (data.type === 'ANSWER') {
      logStatus('Finalizing link...');
      if (rtcPeer) {
        rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
          while (iceCandidateQueue.length > 0) {
            rtcPeer.addIceCandidate(iceCandidateQueue.shift());
          }
        }).catch((err) => console.error('Remote desc error:', err));
      }
    } else if (data.type === 'ICE_CANDIDATE') {
      const candidate = new RTCIceCandidate(data.candidate);
      if (rtcPeer && rtcPeer.remoteDescription) {
        rtcPeer.addIceCandidate(candidate).catch((e) => console.warn('ICE add error:', e));
      } else {
        iceCandidateQueue.push(candidate);
      }
    }
  }

  // --- 3. DataChannel Setup ---
  function bindDataChannel(channel) {
    channel.onopen = () => {
      clearTimeout(signalingTimer);
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

  // --- 4. DOM Initialization ---
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

    topic = `airtext_sig_${activeRoom}`;
    cacheKey = `airtext_draft_${activeRoom}`;

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
          clearTimeout(signalingTimer);
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

    startSignaling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();






