// --- Elements ---
const editor = document.getElementById('editor');
const chars = document.getElementById('chars');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const networkText = document.getElementById('networkText');
const flash = document.getElementById('flash');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const peerLabel = document.getElementById('peerLabel');
const clearBtn = document.getElementById('clearBtn');
const copyBtn = document.getElementById('copyBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const resetRoomBtn = document.getElementById('resetRoomBtn');
const joinInput = document.getElementById('joinInput');
const joinBtn = document.getElementById('joinBtn');
const qrBtn = document.getElementById('qrBtn');
const qrModal = document.getElementById('qrModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const qrCanvas = document.getElementById('qrCanvas');
const themeBtn = document.getElementById('themeBtn');
const toast = document.getElementById('toast');
const sendFileBtn = document.getElementById('sendFileBtn');
const fileInput = document.getElementById('fileInput');
const filesDeck = document.getElementById('filesDeck');

// --- 1. Deterministic Room Management ---
function generateSlug() {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += c[Math.floor(Math.random() * c.length)];
  }
  return s;
}

let activeRoom = window.location.hash.replace('#', '').trim().toLowerCase();
if (!activeRoom) {
  activeRoom = generateSlug();
  window.history.replaceState(null, '', '#' + activeRoom);
}
roomCodeDisplay.textContent = '#' + activeRoom;

function getFullShareUrl() {
  return `${window.location.origin}${window.location.pathname}#${activeRoom}`;
}

const cacheKey = `airtext_draft_${activeRoom}`;
editor.value = localStorage.getItem(cacheKey) || '';
updateCharCount();

function updateCharCount() {
  chars.textContent = `${editor.value.length} characters`;
}

function logDebug(msg) {
  console.log('[AirText]', msg);
  networkText.textContent = msg;
}

// --- 2. Signaling State & WebRTC Config ---
let rtcPeer = null;
let dataChannel = null;
let mqttClient = null;
let isRemoteInput = false;
let handshakeInterval = null;
let iceCandidateQueue = [];

const myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
const topic = `airtext_pub/v2/${activeRoom}`;

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

// --- 3. Reliable Paho Accessor & MQTT Client ---
function getPaho() {
  if (typeof window.Paho !== 'undefined' && window.Paho.MQTT) return window.Paho.MQTT;
  if (typeof Paho !== 'undefined' && Paho.MQTT) return Paho.MQTT;
  if (typeof Paho !== 'undefined' && Paho.Client) return Paho;
  return null;
}

function initSignaling() {
  const pahoLib = getPaho();
  if (!pahoLib) {
    logDebug('Waiting for Paho library...');
    setTimeout(initSignaling, 300);
    return;
  }

  logDebug('Connecting to signaling broker...');

  try {
    mqttClient = new pahoLib.Client('broker.emqx.io', 443, '/mqtt', myPeerId);
  } catch (err) {
    console.warn('Port 443 unavailable, switching to 8084:', err);
    mqttClient = new pahoLib.Client('broker.emqx.io', 8084, '/mqtt', myPeerId);
  }

  mqttClient.onConnectionLost = (resp) => {
    if (resp.errorCode !== 0) {
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
    timeout: 10,
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
      console.error('MQTT error:', err);
      logDebug('Signaling blocked by network. Retrying...');
      setTimeout(initSignaling, 3000);
    }
  });
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

// --- 4. WebRTC Connection Setup ---
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
    console.log('[ICE State]', rtcPeer.iceConnectionState);
    if (rtcPeer.iceConnectionState === 'connected') {
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

// --- 5. DataChannel & Sync ---
function bindDataChannel(channel) {
  channel.onopen = () => {
    clearInterval(handshakeInterval);
    updateStatus(true, 'Direct P2P Synced');
    logDebug('Direct P2P Synced (Firewall Bypassed)');
    peerLabel.textContent = '1 device connected';
    showToast('Device connected!');

    if (mqttClient && mqttClient.isConnected()) {
      try {
        mqttClient.disconnect();
      } catch (e) {}
    }

    if (editor.value) {
      channel.send(JSON.stringify({ type: 'SYNC_TEXT', text: editor.value }));
    }
  };

  channel.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'SYNC_TEXT') {
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
    peerLabel.textContent = '0 devices connected';
    logDebug('Peer disconnected. Refresh to re-pair.');
  };
}

function updateStatus(isLive, label) {
  statusDot.className = 'status-dot' + (isLive ? ' active' : '');
  statusLabel.textContent = label;
}

function triggerPulse() {
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 900);
}

// --- 6. Typing Sync ---
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

// --- 7. File Sharing ---
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

function renderFileCard(name, size, dataUri, isSelf) {
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

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// --- 8. Controls & QR ---
resetRoomBtn.addEventListener('click', () => {
  if (confirm('Start a new room?')) {
    localStorage.removeItem(cacheKey);
    clearInterval(handshakeInterval);
    const fresh = generateSlug();
    window.location.hash = fresh;
    window.location.reload();
  }
});

joinBtn.addEventListener('click', () => {
  const code = joinInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!code) return;
  window.location.hash = code;
  window.location.reload();
});

copyBtn.addEventListener('click', async () => {
  if (!editor.value) return;
  await navigator.clipboard.writeText(editor.value);
  showToast('Copied to clipboard!');
});

clearBtn.addEventListener('click', () => {
  editor.value = '';
  updateCharCount();
  localStorage.removeItem(cacheKey);
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'SYNC_TEXT', text: '' }));
  }
});

copyLinkBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(getFullShareUrl());
  showToast('Room link copied!');
});

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

closeModalBtn.addEventListener('click', () => qrModal.classList.remove('open'));
qrModal.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.classList.remove('open');
});

// Theme handling
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

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// Start
initSignaling();
