/* ═══════════════════════════════════════════════════════
   WORLDCHAT — Client
   Three.js + Socket.IO + WebRTC
   ═══════════════════════════════════════════════════════ */

const MOVE_SPEED = 6;
const SPRINT_MULT = 1.8;
const JUMP_FORCE = 8;
const GRAVITY = 20;
const SPRINT_MAX = 100;
const SPRINT_DRAIN = 30;
const SPRINT_REGEN = 20;
const PROXIMITY_RANGE = 20;
const MAX_PEERS = 5;
const POS_SEND_RATE = 50;

const MAP_DATA = { name: 'Neon Plaza', sky: 0x0a0020, ambient: 0x332266, fog: 0x0a0020, ground: 0x1a1a2e };
const SKIN_COLOR = 0x7c3aed;

// ── State ────────────────────────────────────────────────
let socket = null, myUserId = null, myUsername = '', myRoomCode = '';
let scene, camera, renderer, clock;
let playerMesh = null;
let cameraOrbit = { theta: 0, phi: 0.5, distance: 8 };
let isRightMouseDown = false;
let playerVelocity = new THREE.Vector3();
let isGrounded = true;
let sprintStamina = SPRINT_MAX;
let chatVisible = true;

const keys = {};
let lastPosSend = 0;
const remotePlayers = new Map();

// Mobile joystick
const joystick = { active: false, dx: 0, dy: 0, touchId: null };
const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || ('ontouchstart' in window && window.innerWidth < 1024);

// WebRTC
let localStream = null;
const peerConnections = new Map();
const remoteStreams = new Map();
const remoteAudioElements = new Map();
let cameraEnabled = true, micEnabled = true, pttKeyHeld = false;

// Speaking detection
let audioContext = null;
const speakingAnalysers = new Map(); // userId -> { analyser, dataArray }
const activeSpeakers = new Map();    // userId -> { name, level, timeout }

const settings = {
  masterVolume: 80, micSensitivity: 50, pushToTalk: false,
  echoCancellation: true, cameraQuality: 'medium', showVideo: true,
  videoRange: 20, mouseSensitivity: 3, invertY: false, zoomSensitivity: 1,
  sprintEnabled: true, showNames: true, showBubbles: true,
  showMinimap: true, showCrosshair: true, renderDistance: 60
};

// ── Login ────────────────────────────────────────────────

function initLoginUI() {
  const container = document.getElementById('login-particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'login-particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (4 + Math.random() * 6) + 's';
    p.style.animationDelay = (Math.random() * 5) + 's';
    p.style.width = p.style.height = (2 + Math.random() * 4) + 'px';
    container.appendChild(p);
  }
  const urlRoom = new URLSearchParams(window.location.search).get('room');
  if (urlRoom) document.getElementById('room-code-input').value = urlRoom.toUpperCase();
}

function connectSocket() {
  socket = io();

  socket.on('room-created', ({ roomCode, userId, userData }) => {
    myUserId = userId; myRoomCode = roomCode;
    enterGame(userData);
    showToast(`Room created: ${roomCode}`);
  });

  socket.on('joined', ({ roomCode, userId, userData, existingUsers, userCount }) => {
    myUserId = userId; myRoomCode = roomCode;
    enterGame(userData);
    for (const [uid, udata] of Object.entries(existingUsers)) spawnRemotePlayer(uid, udata);
    updateUserCount(userCount);
    showToast(`Joined room ${roomCode}`);
  });

  socket.on('room-not-found', () => { showToast('Room not found!'); document.getElementById('btn-join').disabled = false; });
  socket.on('room-full', () => { showToast('Room is full'); document.getElementById('btn-join').disabled = false; });

  socket.on('user-joined', ({ userId, userData, userCount }) => {
    spawnRemotePlayer(userId, userData);
    updateUserCount(userCount);
    addSystemMessage(`${userData.username} joined`);
    showToast(`${userData.username} joined`);
  });

  socket.on('user-left', ({ userId, username, userCount }) => {
    removeRemotePlayer(userId);
    updateUserCount(userCount);
    addSystemMessage(`${username} left`);
    closePeerConnection(userId);
  });

  socket.on('user-moved', ({ userId, position, rotation }) => {
    const rp = remotePlayers.get(userId);
    if (rp) {
      rp.targetPos = new THREE.Vector3(position.x, position.y, position.z);
      rp.targetRot = rotation;
    }
  });

  socket.on('chat-message', ({ userId, username, message, timestamp }) => {
    addChatMessage(username, message, timestamp, userId === myUserId);
  });

  socket.on('avatar-speech', ({ userId, message }) => showSpeechBubble(userId, message));

  socket.on('media-toggle', ({ userId, type, enabled }) => {
    const rp = remotePlayers.get(userId);
    if (rp) {
      if (type === 'camera') rp.data.cameraEnabled = enabled;
      if (type === 'mic') rp.data.micEnabled = enabled;
    }
  });

  // WebRTC signaling
  socket.on('webrtc-offer', async ({ fromUserId, offer }) => {
    const pc = getOrCreatePeer(fromUserId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    const boosted = { type: answer.type, sdp: boostAudioInSDP(answer.sdp) };
    await pc.setLocalDescription(boosted);
    socket.emit('webrtc-answer', { targetUserId: fromUserId, answer: boosted });
  });

  socket.on('webrtc-answer', async ({ fromUserId, answer }) => {
    const pc = peerConnections.get(fromUserId);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('webrtc-ice-candidate', async ({ fromUserId, candidate }) => {
    const pc = peerConnections.get(fromUserId);
    if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  });
}

// ── Room Actions ─────────────────────────────────────────

window.createRoom = function() {
  myUsername = document.getElementById('username-input').value.trim() || 'Player';
  if (!socket) connectSocket();
  document.getElementById('btn-create').disabled = true;
  socket.emit('create-room', { username: myUsername });
};

window.joinRoom = function() {
  myUsername = document.getElementById('username-input').value.trim() || 'Player';
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code || code.length < 5) { showToast('Enter a valid room code'); return; }
  if (!socket) connectSocket();
  document.getElementById('btn-join').disabled = true;
  socket.emit('join-room', { roomCode: code, username: myUsername });
};

window.autoJoin = function() {
  myUsername = document.getElementById('username-input').value.trim() || 'Player';
  if (!socket) connectSocket();
  document.getElementById('btn-auto-join').disabled = true;
  socket.emit('auto-join', { username: myUsername });
};

// ── Enter Game ───────────────────────────────────────────

function enterGame(userData) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('game-ui').classList.remove('hidden');
  document.getElementById('room-code-text').textContent = myRoomCode;
  document.getElementById('map-badge').textContent = MAP_DATA.name;
  document.getElementById('pip-name').textContent = myUsername;
  initThreeJS();
  spawnLocalPlayer(userData);
  initControls();
  initMediaStream();
  animate();
}

// ── Three.js ─────────────────────────────────────────────

function initThreeJS() {
  clock = new THREE.Clock();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(MAP_DATA.sky);
  scene.fog = new THREE.Fog(MAP_DATA.fog, 30, settings.renderDistance);
  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(MAP_DATA.ambient, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(10, 20, 10);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 60;
  dir.shadow.camera.left = -30; dir.shadow.camera.right = 30;
  dir.shadow.camera.top = 30;   dir.shadow.camera.bottom = -30;
  scene.add(dir);
  buildMap();
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function buildMap() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshStandardMaterial({ color: MAP_DATA.ground, roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(100, 50, 0x333344, 0x222233);
  grid.position.y = 0.01;
  grid.material.opacity = 0.3;
  grid.material.transparent = true;
  scene.add(grid);

  const colors = [0x7c3aed, 0x3b82f6, 0xf472b6, 0x22c55e, 0xf97316];
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = 18 + Math.random() * 8;
    const h = 3 + Math.random() * 5;
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(1, h, 1),
      new THREE.MeshStandardMaterial({ color: colors[i % colors.length], emissive: colors[i % colors.length], emissiveIntensity: 0.5 })
    );
    pillar.position.set(Math.cos(angle) * r, h / 2, Math.sin(angle) * r);
    pillar.castShadow = true;
    scene.add(pillar);
  }
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(4, 4, 0.3, 32),
    new THREE.MeshStandardMaterial({ color: 0x2a1a4a, emissive: 0x7c3aed, emissiveIntensity: 0.2 })
  );
  platform.position.y = 0.15;
  scene.add(platform);
  [0x7c3aed, 0x3b82f6, 0xf472b6].forEach((c, i) => {
    const pl = new THREE.PointLight(c, 1, 20);
    pl.position.set(Math.cos(i * 2) * 10, 3, Math.sin(i * 2) * 10);
    scene.add(pl);
  });
}

// ── Avatar ───────────────────────────────────────────────

function createAvatarMesh() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.5), mat);
  body.position.y = 1.2; body.castShadow = true; group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat);
  head.position.y = 2.05; head.castShadow = true; group.add(head);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  [-0.12, 0.12].forEach(x => {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.05), eyeMat);
    eye.position.set(x, 2.1, 0.33); group.add(eye);
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), pupilMat);
    pupil.position.set(x, 2.1, 0.36); group.add(pupil);
  });
  const mouthMat = new THREE.MeshBasicMaterial({ color: 0x1a0a2e });
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.05), mouthMat);
  mouth.position.set(0, 1.92, 0.33); group.add(mouth);
  group.mouthMesh = mouth;
  [-0.55, 0.55].forEach(x => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.8, 0.25), mat);
    arm.position.set(x, 1.1, 0); arm.castShadow = true; group.add(arm);
  });
  [-0.18, 0.18].forEach(x => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.3), mat);
    leg.position.set(x, 0.35, 0); leg.castShadow = true; group.add(leg);
  });
  return group;
}

function spawnLocalPlayer(userData) {
  playerMesh = createAvatarMesh();
  playerMesh.position.set(userData.position.x, 0, userData.position.z);
  scene.add(playerMesh);
}

function spawnRemotePlayer(userId, userData) {
  if (remotePlayers.has(userId)) return;
  const mesh = createAvatarMesh();
  mesh.position.set(userData.position.x, userData.position.y || 0, userData.position.z);
  mesh.rotation.y = userData.rotation || 0;
  scene.add(mesh);
  const nameSprite = createTextSprite(userData.username);
  nameSprite.position.set(0, 0.35, 0.4);
  mesh.add(nameSprite);
  remotePlayers.set(userId, {
    mesh, nameSprite, mouthMesh: mesh.mouthMesh, bubbleSprite: null, bubbleTimeout: null,
    data: { ...userData },
    targetPos: new THREE.Vector3(userData.position.x, userData.position.y || 0, userData.position.z),
    targetRot: userData.rotation || 0
  });
}

function removeRemotePlayer(userId) {
  const rp = remotePlayers.get(userId);
  if (rp) {
    scene.remove(rp.mesh);
    if (rp.bubbleTimeout) clearTimeout(rp.bubbleTimeout);
    remotePlayers.delete(userId);
  }
  // Clean up speaking analyser
  speakingAnalysers.delete(userId);
  activeSpeakers.delete(userId);
}

function createTextSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256; canvas.height = 64;
  ctx.font = 'bold 28px Outfit, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 128, 42);
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2, 0.5, 1);
  return sprite;
}

function createBubbleSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512; canvas.height = 128;
  ctx.fillStyle = 'rgba(15,15,25,0.85)';
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(canvas.width - r, 0);
  ctx.quadraticCurveTo(canvas.width, 0, canvas.width, r);
  ctx.lineTo(canvas.width, canvas.height - r);
  ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - r, canvas.height);
  ctx.lineTo(r, canvas.height);
  ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(124,58,237,0.4)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.font = '24px Outfit, sans-serif'; ctx.fillStyle = '#e0e0e0'; ctx.textAlign = 'center';
  ctx.fillText(text.length > 40 ? text.slice(0, 40) + '...' : text, 256, 76);
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.5, 0.9, 1);
  return sprite;
}

function showSpeechBubble(userId, message) {
  if (!settings.showBubbles) return;
  const rp = remotePlayers.get(userId);
  if (!rp) return;
  if (rp.bubbleSprite) { rp.mesh.remove(rp.bubbleSprite); if (rp.bubbleTimeout) clearTimeout(rp.bubbleTimeout); }
  const bubble = createBubbleSprite(message);
  bubble.position.set(0, 3.8, 0);
  rp.mesh.add(bubble);
  rp.bubbleSprite = bubble;
  rp.bubbleTimeout = setTimeout(() => { rp.mesh.remove(bubble); rp.bubbleSprite = null; }, 5000);
}

// ── Controls ─────────────────────────────────────────────

function initControls() {
  const canvas = renderer.domElement;

  document.addEventListener('keydown', (e) => {
    if (document.activeElement === document.getElementById('chat-input')) return;
    keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); showTabMenu(true); }
    if (e.code === 'Enter') document.getElementById('chat-input').focus();
    if (e.code === 'Escape') closeAllOverlays();
    if (e.code === 'KeyV' && settings.pushToTalk && localStream && !pttKeyHeld) {
      pttKeyHeld = true;
      localStream.getAudioTracks().forEach(t => t.enabled = true);
      micEnabled = true; updateMediaButtons();
      if (socket) socket.emit('media-toggle', { type: 'mic', enabled: true });
    }
  });

  document.addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'Tab') showTabMenu(false);
    if (e.code === 'KeyV' && settings.pushToTalk && localStream) {
      pttKeyHeld = false;
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      micEnabled = false; updateMediaButtons();
      if (socket) socket.emit('media-toggle', { type: 'mic', enabled: false });
    }
  });

  canvas.addEventListener('mousedown', (e) => { if (e.button === 2) { isRightMouseDown = true; e.preventDefault(); } });
  document.addEventListener('mouseup', (e) => { if (e.button === 2) isRightMouseDown = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('mousemove', (e) => {
    if (!isRightMouseDown) return;
    const sens = settings.mouseSensitivity * 0.002;
    cameraOrbit.theta -= e.movementX * sens;
    const yMult = settings.invertY ? -1 : 1;
    cameraOrbit.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, cameraOrbit.phi + e.movementY * sens * yMult));
  });

  canvas.addEventListener('wheel', (e) => {
    cameraOrbit.distance = Math.max(0, Math.min(20, cameraOrbit.distance + e.deltaY * 0.01 * settings.zoomSensitivity * 0.5));
    e.preventDefault();
  }, { passive: false });

  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.code === 'Enter') { sendChat(); e.preventDefault(); }
    if (e.code === 'Escape') document.getElementById('chat-input').blur();
    e.stopPropagation();
  });

  // Mobile joystick
  if (isMobile) initJoystick();
}

function initJoystick() {
  const zone = document.getElementById('joystick-zone');
  const base = document.getElementById('joystick-base');
  const thumb = document.getElementById('joystick-thumb');
  if (!zone) return;
  zone.classList.remove('hidden');

  const maxDist = 50;

  zone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    joystick.touchId = touch.identifier;
    joystick.active = true;
    const rect = zone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = Math.max(-maxDist, Math.min(maxDist, touch.clientX - cx));
    const dy = Math.max(-maxDist, Math.min(maxDist, touch.clientY - cy));
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
    joystick.dx = dx / maxDist;
    joystick.dy = dy / maxDist;
  }, { passive: false });

  zone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      if (touch.identifier !== joystick.touchId) continue;
      const rect = zone.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = touch.clientX - cx;
      let dy = touch.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > maxDist) { dx = dx / dist * maxDist; dy = dy / dist * maxDist; }
      thumb.style.transform = `translate(${dx}px, ${dy}px)`;
      joystick.dx = dx / maxDist;
      joystick.dy = dy / maxDist;
    }
  }, { passive: false });

  const endTouch = (e) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier !== joystick.touchId) continue;
      joystick.active = false;
      joystick.dx = 0;
      joystick.dy = 0;
      joystick.touchId = null;
      thumb.style.transform = 'translate(0px, 0px)';
    }
  };
  zone.addEventListener('touchend', endTouch);
  zone.addEventListener('touchcancel', endTouch);

  // Camera orbit via touch on the right side of the screen
  const canvasEl = renderer.domElement;
  let cameraTouchId = null, lastCamX = 0, lastCamY = 0;
  canvasEl.addEventListener('touchstart', (e) => {
    for (const touch of e.changedTouches) {
      if (touch.clientX > window.innerWidth * 0.4 && cameraTouchId === null) {
        cameraTouchId = touch.identifier;
        lastCamX = touch.clientX;
        lastCamY = touch.clientY;
      }
    }
  }, { passive: true });
  canvasEl.addEventListener('touchmove', (e) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier !== cameraTouchId) continue;
      const sens = settings.mouseSensitivity * 0.004;
      cameraOrbit.theta -= (touch.clientX - lastCamX) * sens;
      const yMult = settings.invertY ? -1 : 1;
      cameraOrbit.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, cameraOrbit.phi + (touch.clientY - lastCamY) * sens * yMult));
      lastCamX = touch.clientX;
      lastCamY = touch.clientY;
    }
  }, { passive: true });
  const endCam = (e) => { for (const touch of e.changedTouches) { if (touch.identifier === cameraTouchId) cameraTouchId = null; } };
  canvasEl.addEventListener('touchend', endCam);
  canvasEl.addEventListener('touchcancel', endCam);
}

// ── Game Loop ────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  updatePlayer(dt);
  updateCamera();
  updateRemotePlayers(dt);
  updateMinimap();
  updateProximityConnections();
  updateProximityAudio();
  updateSpeakingIndicator();
  renderer.render(scene, camera);
}

function updatePlayer(dt) {
  if (!playerMesh) return;
  const forward = new THREE.Vector3(-Math.sin(cameraOrbit.theta), 0, -Math.cos(cameraOrbit.theta));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const moveDir = new THREE.Vector3();
  if (keys['KeyW'] || keys['ArrowUp']) moveDir.add(forward);
  if (keys['KeyS'] || keys['ArrowDown']) moveDir.sub(forward);
  if (keys['KeyA'] || keys['ArrowLeft']) moveDir.sub(right);
  if (keys['KeyD'] || keys['ArrowRight']) moveDir.add(right);
  if (joystick.active) {
    moveDir.add(forward.clone().multiplyScalar(-joystick.dy));
    moveDir.add(right.clone().multiplyScalar(joystick.dx));
  }
  const isMoving = moveDir.length() > 0.01;
  if (isMoving) moveDir.normalize();
  const isSprinting = keys['ShiftLeft'] && isMoving && settings.sprintEnabled && sprintStamina > 0;
  const speed = MOVE_SPEED * (isSprinting ? SPRINT_MULT : 1);
  if (isSprinting) sprintStamina = Math.max(0, sprintStamina - SPRINT_DRAIN * dt);
  else sprintStamina = Math.min(SPRINT_MAX, sprintStamina + SPRINT_REGEN * dt);

  const sprintBar = document.getElementById('sprint-bar-container');
  const sprintFill = document.getElementById('sprint-bar-fill');
  if (sprintStamina < SPRINT_MAX) { sprintBar.classList.remove('hidden'); sprintFill.style.width = (sprintStamina / SPRINT_MAX * 100) + '%'; }
  else sprintBar.classList.add('hidden');

  playerMesh.position.x += moveDir.x * speed * dt;
  playerMesh.position.z += moveDir.z * speed * dt;
  const bound = 48;
  playerMesh.position.x = Math.max(-bound, Math.min(bound, playerMesh.position.x));
  playerMesh.position.z = Math.max(-bound, Math.min(bound, playerMesh.position.z));

  if (isMoving) {
    const target = Math.atan2(moveDir.x, moveDir.z);
    let diff = target - playerMesh.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    playerMesh.rotation.y += diff * Math.min(1, 10 * dt);
  }

  if (keys['Space'] && isGrounded) { playerVelocity.y = JUMP_FORCE; isGrounded = false; }
  playerVelocity.y -= GRAVITY * dt;
  playerMesh.position.y += playerVelocity.y * dt;
  if (playerMesh.position.y <= 0) { playerMesh.position.y = 0; playerVelocity.y = 0; isGrounded = true; }

  if (isMoving && isGrounded) {
    const bobSpeed = isSprinting ? 12 : 8;
    playerMesh.children[0].position.y = 1.2 + Math.sin(clock.elapsedTime * bobSpeed) * 0.03;
  }

  const now = Date.now();
  if (now - lastPosSend > POS_SEND_RATE && socket) {
    lastPosSend = now;
    socket.emit('position-update', {
      position: { x: playerMesh.position.x, y: playerMesh.position.y, z: playerMesh.position.z },
      rotation: playerMesh.rotation.y
    });
  }
}

function updateCamera() {
  if (!playerMesh) return;
  const eyeHeight = 2.0;
  const headPos = playerMesh.position.clone().add(new THREE.Vector3(0, eyeHeight, 0));
  if (cameraOrbit.distance < 0.5) {
    camera.position.copy(headPos);
    const lookDir = new THREE.Vector3(
      -Math.sin(cameraOrbit.theta) * Math.cos(cameraOrbit.phi),
      -Math.sin(cameraOrbit.phi),
      -Math.cos(cameraOrbit.theta) * Math.cos(cameraOrbit.phi)
    );
    camera.lookAt(headPos.clone().add(lookDir));
    playerMesh.visible = false;
  } else {
    playerMesh.visible = true;
    const offset = new THREE.Vector3(
      Math.sin(cameraOrbit.theta) * Math.cos(cameraOrbit.phi) * cameraOrbit.distance,
      Math.sin(cameraOrbit.phi) * cameraOrbit.distance,
      Math.cos(cameraOrbit.theta) * Math.cos(cameraOrbit.phi) * cameraOrbit.distance
    );
    camera.position.copy(headPos).add(offset);
    camera.lookAt(headPos);
  }
}

function updateRemotePlayers(dt) {
  for (const [uid, rp] of remotePlayers) {
    rp.mesh.position.lerp(rp.targetPos, Math.min(1, 10 * dt));
    let angleDiff = rp.targetRot - rp.mesh.rotation.y;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    rp.mesh.rotation.y += angleDiff * Math.min(1, 10 * dt);
    if (rp.nameSprite) rp.nameSprite.visible = settings.showNames;
    if (rp.videoPlane && camera) {
      const worldPos = new THREE.Vector3();
      rp.videoPlane.getWorldPosition(worldPos);
      const camDir = new THREE.Vector3();
      camDir.subVectors(camera.position, worldPos);
      rp.videoPlane.rotation.y = Math.atan2(camDir.x, camDir.z) - rp.mesh.rotation.y;
    }
  }
}

// ── WebRTC ───────────────────────────────────────────────

async function initMediaStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: { echoCancellation: settings.echoCancellation, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 }
    });
    if (settings.pushToTalk) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      micEnabled = false; updateMediaButtons();
    }
    const pipVideo = document.getElementById('pip-video');
    pipVideo.srcObject = localStream;
    document.getElementById('pip-view').classList.remove('hidden');
  } catch (err) {
    console.warn('Media access denied:', err);
    showToast('Camera/mic not available');
    cameraEnabled = false; micEnabled = false; updateMediaButtons();
  }
}

function getVideoConstraints() {
  switch (settings.cameraQuality) {
    case 'low': return { width: 160, height: 120, frameRate: 15 };
    case 'high': return { width: 640, height: 480, frameRate: 30 };
    default: return { width: 320, height: 240, frameRate: 20 };
  }
}

function getOrCreatePeer(userId, isInitiator) {
  if (peerConnections.has(userId)) return peerConnections.get(userId);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
  if (localStream) {
    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'audio') {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate = 128000;
          sender.setParameters(params).catch(() => {});
        } catch (e) {}
      }
    });
  }
  pc.onicecandidate = (e) => { if (e.candidate && socket) socket.emit('webrtc-ice-candidate', { targetUserId: userId, candidate: e.candidate }); };
  pc.ontrack = (e) => { if (e.streams[0]) { remoteStreams.set(userId, e.streams[0]); handleRemoteStream(userId, e.streams[0]); } };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') closePeerConnection(userId); };
  peerConnections.set(userId, pc);
  if (isInitiator) {
    pc.createOffer().then(offer => {
      const boosted = { type: offer.type, sdp: boostAudioInSDP(offer.sdp) };
      pc.setLocalDescription(boosted);
      socket.emit('webrtc-offer', { targetUserId: userId, offer: boosted });
    });
  }
  return pc;
}

function boostAudioInSDP(sdp) {
  return sdp.replace(/a=fmtp:111 /g, 'a=fmtp:111 maxaveragebitrate=128000;stereo=0;sprop-stereo=0;usedtx=0;');
}

function closePeerConnection(userId) {
  const pc = peerConnections.get(userId);
  if (pc) { pc.close(); peerConnections.delete(userId); }
  remoteStreams.delete(userId);
  const audioEl = remoteAudioElements.get(userId);
  if (audioEl) { audioEl.srcObject = null; audioEl.remove(); remoteAudioElements.delete(userId); }
  const rp = remotePlayers.get(userId);
  if (rp && rp.videoPlane) { rp.mesh.remove(rp.videoPlane); rp.videoPlane = null; }
  speakingAnalysers.delete(userId);
  activeSpeakers.delete(userId);
}

function handleRemoteStream(userId, stream) {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length > 0) {
    const audioStream = new MediaStream(audioTracks);
    let audioEl = remoteAudioElements.get(userId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true; audioEl.playsInline = true;
      document.body.appendChild(audioEl);
      remoteAudioElements.set(userId, audioEl);
    }
    audioEl.srcObject = audioStream;
    audioEl.volume = settings.masterVolume / 100;
    audioEl.play().catch(() => {});

    // Set up speaking detection analyser
    setupSpeakingAnalyser(userId, audioStream);
  }

  if (settings.showVideo) {
    const rp = remotePlayers.get(userId);
    if (!rp) return;
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) return;
    const videoStream = new MediaStream(videoTracks);
    const video = document.createElement('video');
    video.srcObject = videoStream; video.autoplay = true; video.playsInline = true; video.muted = true;
    video.play().catch(() => {});
    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.85),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
    );
    plane.position.set(0, 2.9, 0);
    if (rp.videoPlane) rp.mesh.remove(rp.videoPlane);
    rp.mesh.add(plane);
    rp.videoPlane = plane;
  }
}

// ── Speaking Detection (Web Audio API) ───────────────────

function setupSpeakingAnalyser(userId, audioStream) {
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(audioStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    speakingAnalysers.set(userId, { analyser, dataArray });
  } catch (e) {
    console.warn('Could not create speaking analyser:', e);
  }
}

function updateSpeakingIndicator() {
  const SPEAK_THRESHOLD = 30;
  const now = Date.now();

  // Check each remote user's audio level
  for (const [userId, { analyser, dataArray }] of speakingAnalysers) {
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const avg = sum / dataArray.length;

    if (avg > SPEAK_THRESHOLD) {
      activeSpeakers.set(userId, { level: avg, expiry: now + 400 });
    }
  }

  // Remove expired speakers
  for (const [userId, info] of activeSpeakers) {
    if (now > info.expiry) activeSpeakers.delete(userId);
  }

  // Animate mouth on each remote player's avatar
  for (const [userId, rp] of remotePlayers) {
    if (!rp.mouthMesh) continue;
    const speaker = activeSpeakers.get(userId);
    if (speaker) {
      const open = 0.5 + (speaker.level / 100) * 2.5;
      rp.mouthMesh.scale.y = open;
    } else {
      rp.mouthMesh.scale.y = 1;
    }
  }
}

// ── Proximity Audio ──────────────────────────────────────

function updateProximityAudio() {
  if (!playerMesh) return;
  const myPos = playerMesh.position;
  const range = settings.videoRange;
  const masterVol = settings.masterVolume / 100;
  for (const [userId, audioEl] of remoteAudioElements) {
    const rp = remotePlayers.get(userId);
    if (!rp) { audioEl.volume = 0; continue; }
    const dist = myPos.distanceTo(rp.mesh.position);
    let vol = dist <= 2 ? 1 : dist >= range ? 0 : 1 - ((dist - 2) / (range - 2));
    vol = vol * vol;
    audioEl.volume = Math.max(0, Math.min(1, vol * masterVol));
  }
}

let proximityTimer = 0;
function updateProximityConnections() {
  proximityTimer++;
  if (proximityTimer % 60 !== 0) return;
  if (!playerMesh || !socket) return;
  const myPos = playerMesh.position;
  const range = settings.videoRange;
  const nearby = [];
  for (const [uid, rp] of remotePlayers) {
    const dist = myPos.distanceTo(rp.mesh.position);
    if (dist < range) nearby.push({ userId: uid, dist });
  }
  nearby.sort((a, b) => a.dist - b.dist);
  const targetIds = new Set(nearby.slice(0, MAX_PEERS).map(t => t.userId));
  for (const [uid] of peerConnections) { if (!targetIds.has(uid)) closePeerConnection(uid); }
  for (const t of nearby.slice(0, MAX_PEERS)) { if (!peerConnections.has(t.userId)) getOrCreatePeer(t.userId, true); }
}

// ── Minimap ──────────────────────────────────────────────

function updateMinimap() {
  if (!settings.showMinimap) { document.getElementById('minimap').style.display = 'none'; return; }
  document.getElementById('minimap').style.display = '';
  const canvas = document.getElementById('minimap');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, scale = w / 100;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(10, 10, 18, 0.9)'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(124, 58, 237, 0.3)'; ctx.lineWidth = 1; ctx.strokeRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 100; i += 20) {
    const px = i * scale;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, px); ctx.lineTo(w, px); ctx.stroke();
  }
  for (const [, rp] of remotePlayers) {
    ctx.fillStyle = '#3b82f6'; ctx.beginPath();
    ctx.arc((rp.mesh.position.x + 50) * scale, (rp.mesh.position.z + 50) * scale, 2, 0, Math.PI * 2); ctx.fill();
  }
  if (playerMesh) {
    const px = (playerMesh.position.x + 50) * scale, py = (playerMesh.position.z + 50) * scale;
    ctx.save(); ctx.translate(px, py); ctx.rotate(-cameraOrbit.theta + Math.PI);
    ctx.fillStyle = '#7c3aed'; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(-3, 3); ctx.lineTo(3, 3); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

// ── Chat ─────────────────────────────────────────────────

window.sendChat = function() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !socket) return;
  socket.emit('chat-message', { message: msg });
  input.value = ''; input.blur();
};

function addChatMessage(username, message, timestamp, isSelf) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<span class="chat-name" style="color:${isSelf ? '#7c3aed' : '#3b82f6'}">${escapeHtml(username)}</span>${escapeHtml(message)}<span class="chat-time">${time}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addSystemMessage(text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

// ── UI ───────────────────────────────────────────────────

window.toggleCamera = function() {
  if (!localStream) return;
  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = cameraEnabled);
  updateMediaButtons();
  if (socket) socket.emit('media-toggle', { type: 'camera', enabled: cameraEnabled });
};

window.toggleMic = function() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  updateMediaButtons();
  if (socket) socket.emit('media-toggle', { type: 'mic', enabled: micEnabled });
};

function updateMediaButtons() {
  const camBtn = document.getElementById('btn-camera-toggle');
  const micBtn = document.getElementById('btn-mic-toggle');
  camBtn.classList.toggle('active', cameraEnabled); camBtn.classList.toggle('muted-state', !cameraEnabled);
  camBtn.textContent = cameraEnabled ? 'Cam' : 'Cam Off';
  micBtn.classList.toggle('active', micEnabled); micBtn.classList.toggle('muted-state', !micEnabled);
  micBtn.textContent = micEnabled ? 'Mic' : 'Mic Off';
}

window.toggleChat = function() {
  chatVisible = !chatVisible;
  document.getElementById('chat-panel').classList.toggle('hidden', !chatVisible);
  document.getElementById('btn-chat-toggle').classList.toggle('active', chatVisible);
};

window.toggleSettings = function() { document.getElementById('settings-panel').classList.toggle('hidden'); };
window.toggleFullscreen = function() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
};

window.copyRoomCode = function() {
  navigator.clipboard.writeText(myRoomCode).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.querySelector('.copy-icon').classList.add('hidden');
    btn.querySelector('.copy-done').classList.remove('hidden');
    setTimeout(() => { btn.querySelector('.copy-icon').classList.remove('hidden'); btn.querySelector('.copy-done').classList.add('hidden'); }, 1500);
    showToast('Room code copied!');
  });
};

window.leaveRoom = function() {
  if (socket) socket.disconnect();
  for (const [uid] of peerConnections) closePeerConnection(uid);
  remotePlayers.clear();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  speakingAnalysers.clear(); activeSpeakers.clear();
  document.getElementById('game-ui').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('btn-create').disabled = false;
  document.getElementById('btn-join').disabled = false;
  document.getElementById('btn-auto-join').disabled = false;
  if (renderer) { renderer.dispose(); const c = document.getElementById('canvas-container'); while (c.firstChild) c.removeChild(c.firstChild); }
  scene = null; playerMesh = null; socket = null; myUserId = null;
};

function closeAllOverlays() { document.getElementById('settings-panel').classList.add('hidden'); }

function showTabMenu(show) {
  const menu = document.getElementById('tab-menu');
  if (show) {
    menu.classList.remove('hidden');
    document.getElementById('tab-room-code').textContent = myRoomCode;
    document.getElementById('tab-map-name').textContent = MAP_DATA.name;
    const list = document.getElementById('tab-player-list');
    list.innerHTML = '';
    document.getElementById('tab-player-count').textContent = `Players (${remotePlayers.size + 1}/50)`;
    const self = document.createElement('div'); self.className = 'tab-player-row self';
    self.innerHTML = `<div class="tab-player-dot" style="background:#7c3aed"></div><span class="tab-player-name">${escapeHtml(myUsername)} (You)</span>`;
    list.appendChild(self);
    for (const [, rp] of remotePlayers) {
      const row = document.createElement('div'); row.className = 'tab-player-row';
      const dist = playerMesh ? playerMesh.position.distanceTo(rp.mesh.position).toFixed(1) : '?';
      row.innerHTML = `<div class="tab-player-dot" style="background:#7c3aed"></div><span class="tab-player-name">${escapeHtml(rp.data.username)}</span><span class="tab-proximity">${dist}m</span>`;
      list.appendChild(row);
    }
  } else menu.classList.add('hidden');
}

function updateUserCount(count) { document.getElementById('user-count-badge').textContent = `${count}/50`; }

function showToast(text) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Settings ─────────────────────────────────────────────

function initSettingsBindings() {
  [['set-master-volume','val-master-volume','masterVolume'],['set-mouse-sens','val-mouse-sens','mouseSensitivity']].forEach(([inputId, valId, key]) => {
    const input = document.getElementById(inputId), val = document.getElementById(valId);
    if (input && val) input.addEventListener('input', () => { settings[key] = parseInt(input.value); val.textContent = input.value; });
  });
  [['set-push-to-talk','pushToTalk'],['set-invert-y','invertY']].forEach(([inputId, key]) => {
    const input = document.getElementById(inputId);
    if (input) input.addEventListener('change', () => {
      settings[key] = input.checked;
      if (key === 'pushToTalk' && localStream) {
        if (settings.pushToTalk) {
          localStream.getAudioTracks().forEach(t => t.enabled = false);
          micEnabled = false; pttKeyHeld = false; updateMediaButtons();
          showToast('Push to talk enabled — hold V to speak');
        } else {
          localStream.getAudioTracks().forEach(t => t.enabled = true);
          micEnabled = true; updateMediaButtons();
          showToast('Push to talk disabled — mic is open');
        }
        if (socket) socket.emit('media-toggle', { type: 'mic', enabled: micEnabled });
      }
    });
  });
}

// ── Init ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initLoginUI();
  initSettingsBindings();
  document.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'Enter') && document.activeElement && document.activeElement.tagName === 'BUTTON') {
      if (document.activeElement.closest('#game-ui')) { e.preventDefault(); document.activeElement.blur(); }
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
      setTimeout(() => { if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur(); }, 0);
    }
  });
});
