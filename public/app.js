const authCard = document.getElementById('authCard');
const callCard = document.getElementById('callCard');
const authMessage = document.getElementById('authMessage');

const tabSignup = document.getElementById('tabSignup');
const tabSignin = document.getElementById('tabSignin');
const signupForm = document.getElementById('signupForm');
const signinForm = document.getElementById('signinForm');

const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const muteBtn = document.getElementById('muteBtn');
const roomStatus = document.getElementById('roomStatus');
const participantsEl = document.getElementById('participants');

const STORAGE_USERS = 'voice_room_users_v1';
const STORAGE_SESSION = 'voice_room_session_v1';

let me = null;
let roomId = '';
let localStream = null;
let isMuted = false;
let channel = null;
const tabId = crypto.randomUUID();
const peerConnections = new Map();
const users = new Map();

function setMessage(msg, isError = false) {
  authMessage.textContent = msg;
  authMessage.style.color = isError ? '#fca5a5' : '#7dd3fc';
}

function getUsers() {
  return JSON.parse(localStorage.getItem(STORAGE_USERS) || '[]');
}

function setUsers(usersList) {
  localStorage.setItem(STORAGE_USERS, JSON.stringify(usersList));
}

function setSession(username) {
  localStorage.setItem(STORAGE_SESSION, JSON.stringify({ username }));
}

function clearSession() {
  localStorage.removeItem(STORAGE_SESSION);
}

function getSession() {
  return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null');
}

function showSignup() {
  tabSignup.classList.add('active');
  tabSignin.classList.remove('active');
  signupForm.classList.remove('hidden');
  signinForm.classList.add('hidden');
  setMessage('');
}

function showSignin() {
  tabSignin.classList.add('active');
  tabSignup.classList.remove('active');
  signinForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
  setMessage('');
}

function enterAuthUi() {
  callCard.classList.add('hidden');
  authCard.classList.remove('hidden');
  leaveRoom();
}

function renderUsers() {
  participantsEl.innerHTML = '';
  const allUsers = [{ username: me?.username || 'You', isMe: true }, ...users.values()];
  allUsers.forEach((u) => {
    const li = document.createElement('li');
    li.textContent = u.isMe ? `${u.username} (you)` : u.username;
    participantsEl.appendChild(li);
  });
}

function enterCallUi() {
  authCard.classList.add('hidden');
  callCard.classList.remove('hidden');
  currentUserEl.textContent = me.username;
  roomStatus.textContent = 'Not connected to a room';
  users.clear();
  renderUsers();
}

async function hashPassword(password) {
  const encoded = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function disconnectPeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
  const audio = document.getElementById(`audio-${peerId}`);
  if (audio) {
    audio.remove();
  }
}

function leaveRoom() {
  if (channel && roomId) {
    channel.postMessage({ type: 'leave', from: tabId, username: me?.username, roomId });
    channel.close();
    channel = null;
  }
  for (const peerId of peerConnections.keys()) {
    disconnectPeer(peerId);
  }
  users.clear();
  roomId = '';
  renderUsers();
}

async function initAudio() {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
  return localStream;
}

async function createPeerConnection(peerId, shouldCreateOffer) {
  const existing = peerConnections.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate && channel) {
      channel.postMessage({
        type: 'candidate',
        from: tabId,
        to: peerId,
        roomId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const audio = document.getElementById(`audio-${peerId}`) || document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.autoplay = true;
    audio.srcObject = event.streams[0];
    if (!audio.parentElement) document.body.appendChild(audio);
  };

  peerConnections.set(peerId, pc);

  if (shouldCreateOffer && channel) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    channel.postMessage({ type: 'offer', from: tabId, to: peerId, roomId, offer, username: me.username });
  }

  return pc;
}

async function joinRoom() {
  try {
    await initAudio();
    const nextRoom = roomInput.value.trim();
    if (!nextRoom) {
      roomStatus.textContent = 'Enter a room name first.';
      return;
    }

    leaveRoom();
    roomId = nextRoom;
    users.clear();
    renderUsers();

    channel = new BroadcastChannel(`voice-room-${roomId}`);

    channel.onmessage = async (event) => {
      const message = event.data;
      if (!message || message.from === tabId || message.roomId !== roomId) return;

      if (message.type === 'join-announcement') {
        users.set(message.from, { username: message.username });
        renderUsers();
        await createPeerConnection(message.from, true);
      }

      if (message.type === 'offer' && message.to === tabId) {
        users.set(message.from, { username: message.username });
        renderUsers();
        const pc = await createPeerConnection(message.from, false);
        await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        channel.postMessage({ type: 'answer', from: tabId, to: message.from, roomId, answer });
      }

      if (message.type === 'answer' && message.to === tabId) {
        const pc = peerConnections.get(message.from);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
        }
      }

      if (message.type === 'candidate' && message.to === tabId) {
        const pc = peerConnections.get(message.from);
        if (pc && message.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
          } catch {
            // Ignore malformed ICE candidates.
          }
        }
      }

      if (message.type === 'leave') {
        users.delete(message.from);
        renderUsers();
        disconnectPeer(message.from);
      }
    };

    channel.postMessage({ type: 'join-announcement', from: tabId, username: me.username, roomId });
    roomStatus.textContent = `Connected to room: ${roomId}`;
  } catch {
    roomStatus.textContent = 'Microphone access is required to join.';
  }
}

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(signupForm);
  const username = String(formData.get('username') || '').trim();
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');

  if (!username || !email || !password) {
    setMessage('Username, email and password are required.', true);
    return;
  }

  const allUsers = getUsers();
  if (allUsers.some((u) => u.username === username)) {
    setMessage('Username is already taken.', true);
    return;
  }
  if (allUsers.some((u) => u.email === email)) {
    setMessage('Email is already in use.', true);
    return;
  }

  allUsers.push({ username, email, passwordHash: await hashPassword(password) });
  setUsers(allUsers);
  setSession(username);
  me = { username, email };
  setMessage('Account created. You are signed in.');
  enterCallUi();
});

signinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(signinForm);
  const username = String(formData.get('username') || '').trim();
  const password = String(formData.get('password') || '');

  const user = getUsers().find((u) => u.username === username);
  if (!user) {
    setMessage('Invalid username or password.', true);
    return;
  }

  const providedHash = await hashPassword(password);
  if (providedHash !== user.passwordHash) {
    setMessage('Invalid username or password.', true);
    return;
  }

  setSession(user.username);
  me = { username: user.username, email: user.email };
  setMessage('Signed in successfully.');
  enterCallUi();
});

logoutBtn.addEventListener('click', () => {
  clearSession();
  leaveRoom();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  me = null;
  roomStatus.textContent = 'Not connected to a room';
  enterAuthUi();
});

joinBtn.addEventListener('click', joinRoom);

muteBtn.addEventListener('click', () => {
  if (!localStream) {
    roomStatus.textContent = 'Join a room first.';
    return;
  }
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
});

tabSignup.addEventListener('click', showSignup);
tabSignin.addEventListener('click', showSignin);

function boot() {
  showSignup();
  const session = getSession();
  if (!session?.username) {
    enterAuthUi();
    return;
  }

  const found = getUsers().find((u) => u.username === session.username);
  if (!found) {
    clearSession();
    enterAuthUi();
    return;
  }

  me = { username: found.username, email: found.email };
  enterCallUi();
}

window.addEventListener('beforeunload', () => {
  leaveRoom();
});

boot();