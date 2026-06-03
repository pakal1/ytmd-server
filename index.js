const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);

// ─── Config ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const MAX_ROOMS = 50;
const MAX_ROOM_MEMBERS = 10;
const ROOM_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const RATE_LIMIT_MS = 500; // min ms between state-updates per socket

// ─── Rate limiter map: socketId → last event timestamp ────
const rateLimits = new Map();

// ─── Active rooms ─────────────────────────────────────────
// rooms[code] = { host: socketId, members: Set<socketId>, lastActivity: Date, createdAt: Date }
const rooms = new Map();

// ─── Helper: generate random 8-char alphanumeric code ─────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O,0,1,I to avoid confusion
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Helper: validate state payload ───────────────────────
function isValidState(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.videoId !== 'string' || state.videoId.length > 20) return false;
  if (typeof state.currentTime !== 'number' || state.currentTime < 0 || state.currentTime > 86400) return false;
  if (typeof state.paused !== 'boolean') return false;
  if (state.title && typeof state.title !== 'string') return false;
  if (state.title && state.title.length > 200) return false;
  return true;
}

// ─── Cleanup expired rooms every 30 minutes ───────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      console.log(`[Server] Cleaning up expired room ${code}`);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

// ─── Health check endpoint ────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

// ─── Socket.io ────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: '*', // Electron app — no browser origin restriction needed
    methods: ['GET', 'POST']
  },
  // Limit payload size to 2KB to prevent abuse
  maxHttpBufferSize: 2 * 1024
});

io.on('connection', (socket) => {
  console.log(`[Server] Connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────
  socket.on('create-room', (displayName, cb) => {
    // Support old signature create-room(cb) and new create-room(displayName, cb)
    if (typeof displayName === 'function') { cb = displayName; displayName = 'Host'; }
    if (typeof cb !== 'function') return;

    // Limit total rooms
    if (rooms.size >= MAX_ROOMS) {
      return cb({ error: 'El servidor está al límite de salas activas. Intentá de nuevo más tarde.' });
    }

    // Generate unique code
    let code;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
    } while (rooms.has(code) && attempts < 10);

    if (rooms.has(code)) {
      return cb({ error: 'No se pudo generar un código único. Intentá de nuevo.' });
    }

    rooms.set(code, {
      host: socket.id,
      members: new Set([socket.id]),
      lastActivity: Date.now(),
      createdAt: Date.now()
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    socket.data.displayName = typeof displayName === 'string' ? displayName.slice(0, 30) : 'Host';

    console.log(`[Server] Room created: ${code} by ${socket.id}`);
    cb({ code });
  });

  // ── JOIN ROOM ────────────────────────────────────────────
  socket.on('join-room', (code, displayName, cb) => {
    if (typeof cb !== 'function') return;
    if (typeof code !== 'string' || code.length !== 8) {
      return cb({ error: 'Código inválido.' });
    }

    const room = rooms.get(code.toUpperCase());
    if (!room) {
      return cb({ error: 'Sala no encontrada. Verificá el código.' });
    }

    if (room.members.size >= MAX_ROOM_MEMBERS) {
      return cb({ error: 'La sala está llena (máximo 10 personas).' });
    }

    room.members.add(socket.id);
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.isHost = false;
    socket.data.displayName = typeof displayName === 'string' ? displayName.slice(0, 30) : 'Oyente';

    console.log(`[Server] ${socket.id} joined room ${code}`);

    // Notify others in the room
    socket.to(code.toUpperCase()).emit('member-joined', {
      id: socket.id,
      name: socket.data.displayName,
      count: room.members.size
    });

    cb({ success: true, memberCount: room.members.size });
  });

  // ── STATE UPDATE (Host → Listeners) ─────────────────────
  socket.on('state-update', (state) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room || room.host !== socket.id) return; // Only host can broadcast state
    if (!isValidState(state)) return; // Validate payload

    // Rate limiting
    const now = Date.now();
    const lastTime = rateLimits.get(socket.id) || 0;
    if (now - lastTime < RATE_LIMIT_MS) return;
    rateLimits.set(socket.id, now);

    room.lastActivity = now;
    socket.to(code).emit('state-update', state);
  });

  // ── CHAT MESSAGE ─────────────────────────────────────────
  socket.on('chat-message', (text) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    // Validate
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 200) return;

    room.lastActivity = Date.now();
    // Use socket.to() NOT io.to() — this excludes the sender.
    // The sender already shows the message locally via appendChatMessage().
    socket.to(code).emit('chat-message', {
      from: socket.data.displayName || (socket.data.isHost ? 'Host' : 'Oyente'),
      text: text.trim().slice(0, 200),
      ts: Date.now()
    });
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    rateLimits.delete(socket.id);

    if (!room) return;

    room.members.delete(socket.id);

    if (room.members.size === 0) {
      // Empty room — delete it
      rooms.delete(code);
      console.log(`[Server] Room ${code} deleted (empty)`);
    } else if (room.host === socket.id) {
      // Host left — promote another member
      const newHost = [...room.members][0];
      room.host = newHost;
      io.to(newHost).emit('promoted-to-host');
      io.to(code).emit('host-changed', { newHostId: newHost });
      console.log(`[Server] Host of ${code} changed to ${newHost}`);
    } else {
      io.to(code).emit('member-left', {
        id: socket.id,
        count: room.members.size
      });
    }

    console.log(`[Server] Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[YTMD Listen Together] Server running on http://localhost:${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
});
