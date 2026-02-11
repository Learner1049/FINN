const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── State ────────────────────────────────────────────────
const rooms = new Map();               // roomCode -> room
const socketToUser = new Map();         // socketId -> { userId, roomCode }

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '0123456789';
  let code = '';
  for (let i = 0; i < 3; i++) code += letters[Math.floor(Math.random() * letters.length)];
  code += '-';
  for (let i = 0; i < 3; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function generateShortId() {
  return uuidv4().split('-')[0];
}

function randomSpawn() {
  const range = 15;
  return { x: (Math.random() - 0.5) * range, y: 0, z: (Math.random() - 0.5) * range };
}

function findSocketByUserId(targetUserId, roomCode) {
  for (const [sid, info] of socketToUser) {
    if (info.userId === targetUserId && info.roomCode === roomCode) return sid;
  }
  return null;
}

// ── Socket.IO ────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create-room', ({ username }) => {
    const roomCode = generateRoomCode();
    const userId = generateShortId();
    const pos = randomSpawn();
    const userData = {
      id: userId, username: username || 'Player',
      position: pos, rotation: 0,
      cameraEnabled: false, micEnabled: false
    };
    const room = { code: roomCode, users: new Map() };
    room.users.set(userId, userData);
    rooms.set(roomCode, room);
    socketToUser.set(socket.id, { userId, roomCode });
    socket.join(roomCode);
    socket.emit('room-created', { roomCode, userId, userData });
  });

  socket.on('join-room', ({ roomCode, username }) => {
    const room = rooms.get(roomCode);
    if (!room) { socket.emit('room-not-found'); return; }
    if (room.users.size >= 50) { socket.emit('room-full'); return; }

    const userId = generateShortId();
    const pos = randomSpawn();
    const userData = {
      id: userId, username: username || 'Player',
      position: pos, rotation: 0,
      cameraEnabled: false, micEnabled: false
    };
    room.users.set(userId, userData);
    socketToUser.set(socket.id, { userId, roomCode });
    socket.join(roomCode);

    const existingUsers = {};
    for (const [uid, udata] of room.users) {
      if (uid !== userId) existingUsers[uid] = udata;
    }

    socket.emit('joined', { roomCode, userId, userData, existingUsers, userCount: room.users.size });
    socket.to(roomCode).emit('user-joined', { userId, userData, userCount: room.users.size });
  });

  socket.on('auto-join', ({ username }) => {
    // Find a room with space, or create a new one
    let targetRoom = null;
    for (const [code, room] of rooms) {
      if (room.users.size < 50) { targetRoom = room; break; }
    }

    if (!targetRoom) {
      // No room with space — create one
      const roomCode = generateRoomCode();
      targetRoom = { code: roomCode, users: new Map() };
      rooms.set(roomCode, targetRoom);
    }

    const userId = generateShortId();
    const pos = randomSpawn();
    const userData = {
      id: userId, username: username || 'Player',
      position: pos, rotation: 0,
      cameraEnabled: false, micEnabled: false
    };
    targetRoom.users.set(userId, userData);
    socketToUser.set(socket.id, { userId, roomCode: targetRoom.code });
    socket.join(targetRoom.code);

    const existingUsers = {};
    for (const [uid, udata] of targetRoom.users) {
      if (uid !== userId) existingUsers[uid] = udata;
    }

    socket.emit('joined', { roomCode: targetRoom.code, userId, userData, existingUsers, userCount: targetRoom.users.size });
    socket.to(targetRoom.code).emit('user-joined', { userId, userData, userCount: targetRoom.users.size });
  });

  socket.on('position-update', ({ position, rotation }) => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const user = room.users.get(info.userId);
    if (!user) return;
    user.position = position;
    user.rotation = rotation;
    socket.to(info.roomCode).emit('user-moved', { userId: info.userId, position, rotation });
  });

  socket.on('chat-message', ({ message }) => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const user = room.users.get(info.userId);
    if (!user) return;
    const msg = (message || '').trim().slice(0, 500);
    if (!msg) return;
    io.to(info.roomCode).emit('chat-message', { userId: info.userId, username: user.username, message: msg, timestamp: Date.now() });
    socket.to(info.roomCode).emit('avatar-speech', { userId: info.userId, message: msg });
  });

  // ── WebRTC Signaling ──
  socket.on('webrtc-offer', ({ targetUserId, offer }) => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const sid = findSocketByUserId(targetUserId, info.roomCode);
    if (sid) io.to(sid).emit('webrtc-offer', { fromUserId: info.userId, offer });
  });

  socket.on('webrtc-answer', ({ targetUserId, answer }) => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const sid = findSocketByUserId(targetUserId, info.roomCode);
    if (sid) io.to(sid).emit('webrtc-answer', { fromUserId: info.userId, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetUserId, candidate }) => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const sid = findSocketByUserId(targetUserId, info.roomCode);
    if (sid) io.to(sid).emit('webrtc-ice-candidate', { fromUserId: info.userId, candidate });
  });

  socket.on('media-toggle', ({ type, enabled }) => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const user = room.users.get(info.userId);
    if (!user) return;
    if (type === 'camera') user.cameraEnabled = enabled;
    if (type === 'mic') user.micEnabled = enabled;
    socket.to(info.roomCode).emit('media-toggle', { userId: info.userId, type, enabled });
  });

  socket.on('disconnect', () => {
    const info = socketToUser.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (room) {
      const user = room.users.get(info.userId);
      const username = user ? user.username : 'Unknown';
      room.users.delete(info.userId);
      if (room.users.size === 0) {
        rooms.delete(info.roomCode);
      } else {
        io.to(info.roomCode).emit('user-left', { userId: info.userId, username, userCount: room.users.size });
      }
    }
    socketToUser.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`WorldChat server running on http://localhost:${PORT}`);
});
