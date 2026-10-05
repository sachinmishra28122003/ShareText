// --- AirText Core Application ---
(function () {
  'use strict';

  // Elements map
  let editor, chars, roomCodeDisplay, networkText, flash, statusDot, statusLabel;
  let peerLabel, clearBtn, copyBtn, copyLinkBtn, resetRoomBtn, joinInput, joinBtn;
  let qrBtn, qrModal, closeModalBtn, qrCanvas, themeBtn, toast, sendFileBtn, fileInput, filesDeck;

  // State Variables
  let rtcPeer = null;
  let dataChannel = null;
  let mqttClient = null;
  let isRemoteInput = false;
  let handshakeInterval = null;
  let iceCandidateQueue = [];
  let activeRoom = '';
  let cacheKey = '';
  let brokerIndex = 0;

  const brokers = [
    { host: 'broker.emqx.io', port: 8084, path: '/mqtt' },
    { host: 'broker.hivemq.com', port: 8884, path: '/mqtt' }
  ];

  const myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
  let topic = '';

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
    const c = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) {
      s += c[Math.floor(Math.random() * c.length)];
    }
    return s;
  }

  function getFullShareUrl() {
    return `${window.location.origin}${window.location.pathname}#${activeRoom}`;
  }

  function updateCharCount() {
    if (chars && editor) {
      chars.textContent = `${editor.value.length} characters`;
    }
  }

  function logDebug(msg) {
    console.log('[AirText]', msg);
    if (networkText) {
      networkText.textContent = msg;
    }
  }

  function updateStatus(isLive, label) {
    if (statusDot) {
      statusDot.className = 'status-dot' + (isLive ? ' active' : '');
    }
    if (statusLabel) {
      statusLabel.textContent = label;
    }
  }

  function triggerPulse() {
    if (flash) {
      flash.classList.add('show');
      setTimeout(() => flash.classList.remove('show'), 900);
    }
  }

  function showToast(text) {
    if (toast) {
      toast.textContent = text;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
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

  // --- Signaling Helpers ---
  function getPaho() {
    if (typeof window.Paho !== 'undefined' && window.Paho.MQTT) return window.Paho.MQTT;
    if (typeof Paho !== 'undefined' && Paho.MQTT) return Paho.MQTT;
    if (typeof Paho !== 'undefined' && Paho.Client) return Paho;
    return null;
  }

  function sendSignal(payload) {
    const pahoLib = getPaho();
    if (mqttClient && mqttClient.isConnected() && pahoLib) {
      const msg = new pahoLib.Message(JSON.stringify(payload));
      msg.destinationName = topic;
      msg.qos = 1;
      mqttClient.send(msg);
    }
  }

  function bindDataChannel(channel) {
    channel.onopen = () => {
      clearInterval(handshakeInterval);
      updateStatus(true, 'Direct P2P Synced');
      logDebug('Direct P2P Synced (Firewall Bypassed)');
      if (peerLabel) peerLabel.textContent = '1 device connected';
      showToast('Device connected!');

      if (mqttClient && mqttClient.isConnected()) {
        try {
          mqttClient.disconnect();
        } catch (e) {}
      }

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
      logDebug('Peer disconnected. Refresh to re-pair.');
    };
  }

  function getOrCreatePeerConnection(isInitiator) {
    if (rtcPeer) return rtcPeer;

    logDebug(isInitiator ? 'Initiating WebRTC offer...' : 'Waiting for WebRTC offer...');
    rtcPeer = new RTCPeerConnection(rtcConfig);

    rtcPeer.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: 'ICE_CANDIDATE', candidate: e.candidate, from: myPeerId });
      }
    };

    rtcPeer.oniceconnectionstatechange = () => {
      if (rtcPeer && rtcPeer.iceConnectionState === 'connected') {
        logDebug('Direct P2P Synced');
      }
    };

    if (isInitiator) {
      dataChannel = rtcPeer.createDataChannel('airtext_channel', { reliable: true });
      bindDataChannel(dataChannel);

      rtcPeer.createOffer().then((offer) => {
        return rtcPeer.setLocalDescription(offer);
      }).then(() => {
        sendSignal({ type: 'OFFER', sdp: rtcPeer.localDescription, from: myPeerId });
      }).catch((e) => console.error('Offer error:', e));
    } else {
      rtcPeer.ondatachannel = (e) => {
        logDebug('Data channel received!');
        dataChannel = e.channel;
        bindDataChannel(dataChannel);
      };
    }

    return rtcPeer;
  }

  function handleSignalingMessage(data) {
    if (data.from === myPeerId) return;

    if (data.type === 'PING_PEER') {
      logDebug('Peer detected! Negotiating...');
      if (myPeerId < data.from && (!rtcPeer || rtcPeer.connectionState === 'disconnected')) {
        getOrCreatePeerConnection(true);
      }
    } else if (data.type === 'OFFER') {
      logDebug('Received offer. Creating answer...');
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
      }).catch((e) => console.error('Answer error:', e));
    } else if (data.type === 'ANSWER') {
      logDebug('Received answer. Finalizing link...');
      if (rtcPeer) {
        rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
          while (iceCandidateQueue.length > 0) {
            rtcPeer.addIceCandidate(iceCandidateQueue.shift());
          }
        }).catch((e) => console.error('Remote desc error:', e));
      }
    } else if (data.type === 'ICE_CANDIDATE') {
      const cand = new RTCIceCandidate(data.candidate);
      if (rtcPeer && rtcPeer.remoteDescription) {
        rtcPeer.addIceCandidate(cand).catch((e) => console.warn('ICE add error:', e));
      } else {
        iceCandidateQueue.push(cand);
      }
    }
  }

  function initSignaling() {
    const pahoLib = getPaho();
    if (!pahoLib) {
      logDebug('Waiting for Paho library...');
      setTimeout(initSignaling, 300);
      return;
    }

    const currentBroker = brokers[brokerIndex % brokers.length];
    logDebug(`Connecting to signaling (${currentBroker.host})...`);

    mqttClient = new pahoLib.Client(
      currentBroker.host,
      currentBroker.port,
      currentBroker.path,
      myPeerId
    );

    mqttClient.onConnectionLost = (resp) => {
      if (resp && resp.errorCode !== 0) {
        logDebug('Signaling lost. Reconnecting...');
        updateStatus(false, 'Reconnecting');
        setTimeout(initSignaling, 2000);
      }
    };

    mqttClient.onMessageArrived = (msg) => {
      try {
        const payload = JSON.parse(msg.payloadString);
        handleSignalingMessage(payload);
      } catch (e) {
        console.warn('Packet decode error:', e);
      }
    };

    mqttClient.connect({
      useSSL: true,
      timeout: 8,
      keepAliveInterval: 30,
      cleanSession: true,
      onSuccess: () => {
        mqttClient.subscribe(topic, { qos: 1 });
        logDebug('Signaling ready. Scan QR with 2nd device!');
        updateStatus(false, 'Ready');

        clearInterval(handshakeInterval);
        handshakeInterval = setInterval(() => {
          if (!dataChannel || dataChannel.readyState !== 'open') {
            sendSignal({ type: 'PING_PEER', from: myPeerId });
          } else {
            clearInterval(handshakeInterval);
          }
        }, 1500);

        sendSignal({ type: 'PING_PEER', from: myPeerId });
      },
      onFailure: (err) => {
        console.warn('Broker connect failed:', err);
        brokerIndex++;
        logDebug('Switching signaling broker...');
        setTimeout(initSignaling, 1500);
      }
    });
  }

  // --- App Initialization (DOM Ready) ---
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
    topic = `airtext_pub/v2/${activeRoom}`;

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
          clearInterval(handshakeInterval);
          const fresh = generateSlug();
          window.location.hash = fresh;
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
        const shareUrl = getFullShareUrl();

        if (typeof window.QRCode !== 'undefined') {
          new window.QRCode(qrCanvas, {
            text: shareUrl,
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

    initSignaling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
