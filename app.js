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
const sendFileBtn = document.getElementById('sendFileBtn');
const fileInput = document.getElementById('fileInput');
const filesDeck = document.getElementById('filesDeck');

// Room resolution
function generateSlug() {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

let activeRoom = window.location.hash.replace('#', '').trim().toLowerCase();
if (!activeRoom) {
  activeRoom = generateSlug();
  window.history.replaceState(null, '', '#' + activeRoom);
}
roomCodeDisplay.textContent = '#' + activeRoom;

function updateCharCount() {
  chars.textContent = `${editor.value.length} characters`;
}

// WebRTC State
let rtcPeer = null;
let dataChannel = null;
let mqttClient = null;
let isRemoteInput = false;

const myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
const topicBase = `airtext/v1/${activeRoom}`;

// Standard STUN + Port 443 TURN relays
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelay',
      credential: 'openrelay'
    }
  ]
};

// --- Step 1: Connect to Firewall-Proof MQTT Signaling Broker ---
function initSignaling() {
  networkText.textContent = 'Connecting to signaling network...';
  
  // Connect to public enterprise-friendly broker over secure TLS port 8884
  mqttClient = new Paho.MQTT.Client('broker.hivemq.com', 8884, myPeerId);

  mqttClient.onConnectionLost = (resp) => {
    if (resp.errorCode !== 0) {
      networkText.textContent = 'Signaling blip. Reconnecting...';
      setTimeout(initSignaling, 2000);
    }
  };

  mqttClient.onMessageArrived = (msg) => {
    handleSignalingMessage(JSON.parse(msg.payloadString));
  };

  mqttClient.connect({
    useSSL: true,
    timeout: 5,
    onSuccess: () => {
      // Subscribe to room signaling channel
      mqttClient.subscribe(`${topicBase}/signal`, { qos: 1 });
      networkText.textContent = 'Ready. Scan QR with 2nd device!';
      
      // Announce arrival in the room
      sendSignal({ type: 'DISCOVERY', from: myPeerId });
    },
    onFailure: (err) => {
      console.warn('MQTT error:', err);
      networkText.textContent = 'Signaling unavailable. Check network.';
    }
  });
}

function sendSignal(payload) {
  if (mqttClient && mqttClient.isConnected()) {
    const msg = new Paho.MQTT.Message(JSON.stringify(payload));
    msg.destinationName = `${topicBase}/signal`;
    msg.qos = 1;
    mqttClient.send(msg);
  }
}

// --- Step 2: Native WebRTC Handshake ---
function createPeerConnection(isInitiator) {
  if (rtcPeer) return;

  rtcPeer = new RTCPeerConnection(rtcConfig);

  rtcPeer.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal({ type: 'CANDIDATE', candidate: e.candidate, from: myPeerId });
    }
  };

  if (isInitiator) {
    // Creator establishes data channel
    dataChannel = rtcPeer.createDataChannel('airtext_channel');
    bindChannelEvents(dataChannel);

    rtcPeer.createOffer().then((offer) => {
      return rtcPeer.setLocalDescription(offer);
    }).then(() => {
      sendSignal({ type: 'OFFER', sdp: rtcPeer.localDescription, from: myPeerId });
    });
  } else {
    // Receiver listens for incoming data channel
    rtcPeer.ondatachannel = (e) => {
      dataChannel = e.channel;
      bindChannelEvents(dataChannel);
    };
  }
}

function handleSignalingMessage(data) {
  if (data.from === myPeerId) return; // Ignore own messages

  if (data.type === 'DISCOVERY') {
    // The device with lexicographically smaller ID acts as the WebRTC offerer
    if (myPeerId < data.from) {
      createPeerConnection(true);
    }
  } else if (data.type === 'OFFER') {
    createPeerConnection(false);
    rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
      return rtcPeer.createAnswer();
    }).then((answer) => {
      return rtcPeer.setLocalDescription(answer);
    }).then(() => {
      sendSignal({ type: 'ANSWER', sdp: rtcPeer.localDescription, from: myPeerId });
    });
  } else if (data.type === 'ANSWER') {
    rtcPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'CANDIDATE') {
    if (rtcPeer) {
      rtcPeer.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }
}

// --- Step 3: Direct WebRTC P2P Channel ---
function bindChannelEvents(channel) {
  channel.onopen = () => {
    statusDot.className = 'status-dot active';
    statusLabel.textContent = 'Synced';
    networkText.textContent = 'Direct P2P Synced (Zero Server Relay)';
    peerLabel.textContent = '1 device connected';

    // Disconnect signaling: WebRTC is completely peer-to-peer now
    if (mqttClient && mqttClient.isConnected()) {
      mqttClient.disconnect();
    }

    if (editor.value) {
      channel.send(JSON.stringify({ type: 'SYNC_TEXT', text: editor.value }));
    }
  };

  channel.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'SYNC_TEXT') {
      isRemoteInput = true;
      editor.value = data.text;
      updateCharCount();
      flash.classList.add('show');
      setTimeout(() => flash.classList.remove('show'), 900);
      isRemoteInput = false;
    } else if (data.type === 'SYNC_FILE') {
      renderFileCard(data.name, data.size, data.data, false);
    }
  };

  channel.onclose = () => {
    statusDot.className = 'status-dot';
    statusLabel.textContent = 'Disconnected';
    peerLabel.textContent = '0 devices connected';
    networkText.textContent = 'Peer disconnected. Refresh to pair.';
  };
}

// --- Controls, Typing, and UI ---
editor.addEventListener('input', () => {
  updateCharCount();
  if (isRemoteInput || !dataChannel || dataChannel.readyState !== 'open') return;
  dataChannel.send(JSON.stringify({ type: 'SYNC_TEXT', text: editor.value }));
});

sendFileBtn.addEventListener('click', () => {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    alert('Wait until devices are paired before sending files');
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
      size: (file.size / 1024).toFixed(1) + ' KB',
      data: reader.result
    };
    dataChannel.send(JSON.stringify(payload));
    renderFileCard(payload.name, payload.size, payload.data, true);
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

function renderFileCard(name, size, data, isSelf) {
  const card = document.createElement('div');
  card.className = 'file-item';
  card.innerHTML = `
    <div>
      <span class="file-name">${isSelf ? '📤 ' : '📥 '}${name}</span>
      <span class="file-size">(${size})</span>
    </div>
    <a href="${data}" download="${name}" class="file-download">Download</a>
  `;
  filesDeck.prepend(card);
}

qrBtn.addEventListener('click', () => {
  qrCanvas.innerHTML = '';
  new QRCode(qrCanvas, {
    text: window.location.href,
    width: 180,
    height: 180,
    colorDark: '#0a0b0e',
    colorLight: '#ffffff'
  });
  qrModal.classList.add('open');
});

closeModalBtn.addEventListener('click', () => qrModal.classList.remove('open'));
copyBtn.addEventListener('click', () => navigator.clipboard.writeText(editor.value));
copyLinkBtn.addEventListener('click', () => navigator.clipboard.writeText(window.location.href));
resetRoomBtn.addEventListener('click', () => {
  window.location.hash = generateSlug();
  window.location.reload();
});

// Start Signaling
initSignaling();

  
