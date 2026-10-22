const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Deployment / capacity settings (overridable via environment variables).
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 200;
const MAX_CONN_PER_IP = parseInt(process.env.MAX_CONN_PER_IP, 10) || 10;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Turn timer: seconds = clamp(base + perCircle * n, min, max).
// The base (and, for tests, the other values) can be overridden via env vars.
function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const TURN_TIME_BASE_SECONDS = readNumberEnv('TURN_TIME_BASE_SECONDS', 6);
const TURN_TIME_PER_CIRCLE_SECONDS = readNumberEnv('TURN_TIME_PER_CIRCLE_SECONDS', 2);
const TURN_TIME_MIN_SECONDS = readNumberEnv('TURN_TIME_MIN_SECONDS', 12);
const TURN_TIME_MAX_SECONDS = readNumberEnv('TURN_TIME_MAX_SECONDS', 50);
const WRONG_PICK_DELAY_MS = readNumberEnv('WRONG_PICK_DELAY_MS', 1500);

function turnTimeLimitSeconds(n) {
  const seconds = TURN_TIME_BASE_SECONDS + TURN_TIME_PER_CIRCLE_SECONDS * n;
  return Math.max(TURN_TIME_MIN_SECONDS, Math.min(TURN_TIME_MAX_SECONDS, seconds));
}

const app = express();
const server = http.createServer(app);

// Reject cross-origin WebSocket handshakes. Requests without an Origin header
// (for example Node test clients) are allowed so the existing tests keep passing.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    return false;
  }
  return host === req.headers.host;
}

const wss = new WebSocket.Server({
  server,
  verifyClient: (info) => originAllowed(info.req)
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/health', (req, res) => {
  res.send('ok');
});

// Game engine functions (pure, testable)
function generateCircles(n) {
  const W = 1000;
  const H = 700;
  // `size` is the diameter of every circle this round.
  let size = Math.max(60, Math.min(140, Math.floor(Math.sqrt((W * H) / n / 2.6))));
  const margin = 8; // extra gap beyond touching, in logical units
  const positions = [];

  for (let i = 0; i < n; i++) {
    let placed = false;
    let attempts = 0;
    while (!placed) {
      const x = 6 + Math.random() * (W - size - 12);
      const y = 6 + Math.random() * (H - size - 12);
      // Check the rounded centres, which is what the client actually draws.
      const rx = Math.round(x);
      const ry = Math.round(y);
      const ok = positions.every(p => Math.hypot(p[0] - rx, p[1] - ry) > size + margin);
      if (ok) {
        positions.push([rx, ry]);
        placed = true;
      } else if (++attempts > 500) {
        // Not enough room: shrink the circles a little and keep trying.
        size = Math.max(30, size - 4);
        attempts = 0;
      }
    }
  }

  const nums = shuffleArray([...Array(n)].map((_, i) => i + 1));
  return positions.map((p, i) => [nums[i], p[0], p[1], size]);
}

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9 _\.\-]/g, '')
    .trim()
    .slice(0, 12);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Room management
const rooms = new Map();
const clientRooms = new Map();

// Simultaneous connections per client IP (for the per-IP cap).
const ipConnections = new Map();

// Behind a proxy (e.g. Render), the real client IP is the first X-Forwarded-For entry.
function getClientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function releaseIp(ws) {
  if (!ws._ip || ws._ipReleased) return;
  ws._ipReleased = true;
  const n = (ipConnections.get(ws._ip) || 1) - 1;
  if (n <= 0) ipConnections.delete(ws._ip);
  else ipConnections.set(ws._ip, n);
}

class Room {
  constructor(code) {
    this.code = code;
    this.phase = 'lobby';
    this.hostId = null;
    this.players = [];
    this.currentPlayerIndex = 0;
    this.next = 1;
    this.n = 8;
    this.circles = [];
    this.revealed = [];
    this.flash = null;
    this.locked = false;
    this.wrongTimeout = null;
    this.turnTimeout = null;
    this.turnId = 0;
    this.turnStartedAt = 0;
    this.timeLimitMs = 0;
    this.timerRunning = false;
    this.lastEvent = null;
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
  }
}

function createRoom() {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

function deleteRoom(room, code) {
  clearWrongTimeout(room);
  clearTurnTimeout(room);
  // Let any still-connected players know the room is gone.
  room.players.forEach(p => {
    try {
      sendError(p.ws, 'The room was closed');
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        clientRooms.delete(p.ws);
      }
    } catch (e) {
      // ignore
    }
  });
  rooms.delete(code);
}

function cleanupRooms() {
  const now = Date.now();
  const idleTimeout = 30 * 60 * 1000; // 30 minutes
  for (const [code, room] of rooms.entries()) {
    // Check if all players disconnected
    const connectedPlayers = room.players.filter(p => p.connected);
    if (connectedPlayers.length === 0) {
      // Delete empty rooms after 5 minutes
      if (now - room.lastActivity > 5 * 60 * 1000) {
        deleteRoom(room, code);
        continue;
      }
    }
    // Delete rooms idle for 30+ minutes
    if (now - room.lastActivity > idleTimeout) {
      deleteRoom(room, code);
      continue;
    }
  }
}
setInterval(cleanupRooms, 5 * 60 * 1000).unref(); // Check every 5 minutes

// Message rate limiting
const messageRates = new Map();
const MESSAGE_LIMIT = 20; // messages per second
const MESSAGE_WINDOW = 1000; // 1 second
const MAX_MESSAGE_SIZE = 1024; // 1 KB

function isRateLimited(ws) {
  const now = Date.now();
  if (!messageRates.has(ws)) {
    messageRates.set(ws, { count: 1, resetTime: now + MESSAGE_WINDOW });
    return false;
  }
  const rate = messageRates.get(ws);
  if (now > rate.resetTime) {
    rate.count = 1;
    rate.resetTime = now + MESSAGE_WINDOW;
    return false;
  }
  rate.count++;
  return rate.count > MESSAGE_LIMIT;
}

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  if ((ipConnections.get(ip) || 0) >= MAX_CONN_PER_IP) {
    sendError(ws, 'Server is busy, try again later');
    ws.close();
    return;
  }
  ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);
  ws._ip = ip;

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', (data) => {
    try {
      // Check message size
      if (data.length > MAX_MESSAGE_SIZE) {
        sendError(ws, 'Message too large');
        return;
      }
      
      // Check rate limit
      if (isRateLimited(ws)) {
        sendError(ws, 'Rate limit exceeded');
        return;
      }
      
      const msg = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch (e) {
      sendError(ws, 'Invalid message format');
    }
  });
  
  ws.on('close', () => {
    handleDisconnect(ws);
    messageRates.delete(ws);
    releaseIp(ws);
  });
  
  ws.on('error', () => {
    handleDisconnect(ws);
    messageRates.delete(ws);
    releaseIp(ws);
  });
});

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function sendError(ws, message) {
  send(ws, 'error', { message });
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room':
      handleCreateRoom(ws, msg);
      break;
    case 'join_room':
      handleJoinRoom(ws, msg);
      break;
    case 'start_game':
      handleStartGame(ws, msg);
      break;
    case 'pick':
      handlePick(ws, msg);
      break;
    case 'play_again':
      handlePlayAgain(ws, msg);
      break;
    case 'leave':
      handleLeave(ws, msg);
      break;
    default:
      sendError(ws, 'Unknown message type');
  }
}

function handleCreateRoom(ws, msg) {
  if (rooms.size >= MAX_ROOMS) {
    sendError(ws, 'Server is busy, try again later');
    return;
  }
  const name = sanitizeName(msg.name);
  const room = createRoom();
  const playerId = generatePlayerId();
  const player = {
    id: playerId,
    ws,
    name: name || 'Player',
    best: 0,
    wins: 0,
    connected: true
  };
  room.players.push(player);
  room.hostId = playerId;
  room.lastActivity = Date.now();
  clientRooms.set(ws, room.code);
  send(ws, 'room_state', getRoomState(room, playerId));
}

function handleJoinRoom(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const name = sanitizeName(msg.name);
  const room = rooms.get(code);
  
  if (!room) {
    sendError(ws, 'Invalid room code');
    return;
  }
  
  room.lastActivity = Date.now();
  
  if (room.players.length >= 4) {
    sendError(ws, 'Room is full');
    return;
  }
  
  if (room.phase !== 'lobby') {
    sendError(ws, 'Game already started');
    return;
  }
  
  const playerId = generatePlayerId();
  const player = {
    id: playerId,
    ws,
    name: name || `Player ${room.players.length + 1}`,
    best: 0,
    wins: 0,
    connected: true
  };
  room.players.push(player);
  clientRooms.set(ws, room.code);
  // Send each player a snapshot personalised with their own id.
  broadcastRoomState(room);
}

function handleStartGame(ws, msg) {
  const roomCode = clientRooms.get(ws);
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const player = room.players.find(p => p.ws === ws);
  if (!player || room.hostId !== player.id) {
    sendError(ws, 'Only the host can start the game');
    return;
  }
  
  if (room.phase !== 'lobby') {
    sendError(ws, 'Game already started');
    return;
  }
  
  if (room.players.length < 1) {
    sendError(ws, 'Need at least 1 player');
    return;
  }
  
  const n = Math.max(3, Math.min(20, parseInt(msg.n) || 8));
  room.n = n;
  room.lastActivity = Date.now();
  startRound(room);
  broadcastRoomState(room);
}

function handlePick(ws, msg) {
  const roomCode = clientRooms.get(ws);
  const room = rooms.get(roomCode);
  if (!room) return;
  
  if (room.phase !== 'play' || room.locked) return;
  
  const player = room.players.find(p => p.ws === ws);
  if (!player) return;
  const current = room.players[room.currentPlayerIndex];
  if (!current || current.id !== player.id) return;

  const n = parseInt(msg.n);
  if (isNaN(n)) return;
  
  // Check if already revealed
  if (room.revealed.includes(n)) return;
  // Check if circle exists
  if (!room.circles.some(c => c[0] === n)) return;
  
  applyPick(room, n);
}

function applyPick(room, n) {
  if (n === room.next) {
    room.revealed.push(n);
    const currentPlayer = room.players[room.currentPlayerIndex];
    currentPlayer.best = Math.max(currentPlayer.best, n);
    room.next++;
    if (room.next > room.n) {
      currentPlayer.wins = (currentPlayer.wins || 0) + 1;
      room.phase = 'over';
      room.lastEvent = null;
      clearWrongTimeout(room);
      clearTurnTimeout(room);
      broadcastRoomState(room);
      return;
    }
  } else {
    room.flash = n;
    room.locked = true;
    const currentPlayer = room.players[room.currentPlayerIndex];
    room.lastEvent = { type: 'wrong', playerName: currentPlayer ? currentPlayer.name : '' };
    clearTurnTimeout(room); // pause the turn timer during the delay
    clearWrongTimeout(room);
    room.wrongTimeout = setTimeout(() => {
      room.revealed = [];
      room.flash = null;
      room.next = 1;
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
      room.locked = false;
      room.wrongTimeout = null;
      room.lastActivity = Date.now();
      startTurn(room);
      broadcastRoomState(room);
    }, WRONG_PICK_DELAY_MS);
    if (room.wrongTimeout.unref) room.wrongTimeout.unref();
  }
  room.lastActivity = Date.now();
  broadcastRoomState(room);
}

function restartRound(room, playerId) {
  if (!room) return { ok: false, error: 'Room not found' };
  if (room.hostId !== playerId) return { ok: false, error: 'Only the host can restart' };
  if (room.phase !== 'over') return { ok: false, error: 'Round is not over' };
  startRound(room);
  return { ok: true };
}

function handlePlayAgain(ws, msg) {
  const roomCode = clientRooms.get(ws);
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const player = room.players.find(p => p.ws === ws);
  if (!player) return;

  const result = restartRound(room, player.id);
  if (!result.ok) {
    sendError(ws, result.error);
    return;
  }

  room.lastActivity = Date.now();
  broadcastRoomState(room);
}

/**
 * Pure-ish helper that removes a player (identified by socket or id) from a room.
 * Shared by the explicit 'leave' message and the socket 'close' event.
 *
 * Mutates `room` in place and returns:
 *   { removed: boolean, deleted: boolean }
 * `deleted` is true when the room became empty and should be removed by the caller.
 *
 * Safe to call twice (or with a socket that isn't in the room): it simply
 * returns { removed: false, deleted: false } and never throws.
 */
function removePlayer(room, wsOrId) {
  if (!room || !Array.isArray(room.players)) {
    return { removed: false, deleted: false };
  }

  const target = typeof wsOrId === 'string'
    ? wsOrId
    : (room.players.find(p => p.ws === wsOrId) || {}).id;

  if (!target) {
    return { removed: false, deleted: false };
  }

  const playerIndex = room.players.findIndex(p => p.id === target);
  if (playerIndex === -1) {
    return { removed: false, deleted: false };
  }

  const player = room.players[playerIndex];
  room.players.splice(playerIndex, 1);

  // Last player left: signal the caller to delete the room and clear timers.
  if (room.players.length === 0) {
    clearWrongTimeout(room);
    clearTurnTimeout(room);
    return { removed: true, deleted: true, player };
  }

  // Promote the next player in the list to host if the host left.
  if (room.hostId === player.id) {
    room.hostId = room.players[0].id;
  }

  if (room.phase === 'play') {
    if (room.players.length === 1) {
      // Only one player remains: end the round and mark them the winner.
      const lastPlayer = room.players[0];
      lastPlayer.wins = (lastPlayer.wins || 0) + 1;
      room.phase = 'over';
      room.currentPlayerIndex = 0;
      clearWrongTimeout(room);
      clearTurnTimeout(room);
      room.lastEvent = null;
      room.revealed = [];
      room.flash = null;
      room.next = 1;
      room.locked = false;
    } else {
      // Fix the turn index:
      //  - removed before the current player -> shift the index down one
      //  - removed the current player        -> keep the index so the next
      //    player (who shifts into that slot) gets the turn, wrapping to the
      //    start if the current player was last
      //  - removed after the current player  -> nothing to do
      if (playerIndex < room.currentPlayerIndex) {
        room.currentPlayerIndex--;
      } else if (playerIndex === room.currentPlayerIndex &&
                 room.currentPlayerIndex >= room.players.length) {
        room.currentPlayerIndex = 0;
      }
      room.currentPlayerIndex = clampIndex(room.currentPlayerIndex, room.players.length);
      // Reset the sequence so play continues cleanly.
      clearWrongTimeout(room);
      room.revealed = [];
      room.flash = null;
      room.next = 1;
      room.locked = false;
      // Whoever is now current gets a fresh timer.
      startTurn(room);
    }
  } else {
    // Lobby / over: keep the current index point at a valid player.
    room.currentPlayerIndex = clampIndex(room.currentPlayerIndex, room.players.length);
  }

  return { removed: true, deleted: false, player };
}

function clampIndex(index, length) {
  if (!length) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function clearWrongTimeout(room) {
  if (room.wrongTimeout) {
    clearTimeout(room.wrongTimeout);
    room.wrongTimeout = null;
  }
}

function clearTurnTimeout(room) {
  if (room.turnTimeout) {
    clearTimeout(room.turnTimeout);
    room.turnTimeout = null;
  }
  room.timerRunning = false;
}

// Starts a fresh turn: new turnId (so clients can detect the change), full
// timer, and exactly one pending timeout for the room.
function startTurn(room) {
  clearTurnTimeout(room);
  room.lastEvent = null;
  if (room.phase !== 'play' || room.players.length === 0) {
    room.timeLimitMs = 0;
    return;
  }
  room.turnId = (room.turnId || 0) + 1;
  room.timeLimitMs = Math.round(turnTimeLimitSeconds(room.n) * 1000);
  room.turnStartedAt = Date.now();
  room.timerRunning = true;
  room.turnTimeout = setTimeout(() => handleTurnTimeout(room), room.timeLimitMs);
  if (room.turnTimeout.unref) room.turnTimeout.unref();
}

// Time ran out: treat it like a broken sequence. Pause during the same short
// delay used for wrong picks, then reset and hand the turn to the next player.
function handleTurnTimeout(room) {
  room.turnTimeout = null;
  if (room.phase !== 'play' || room.locked) return;
  const current = room.players[room.currentPlayerIndex];
  if (!current) return;

  room.timerRunning = false;
  room.locked = true;
  room.flash = null;
  room.lastEvent = { type: 'timeout', playerName: current.name };
  room.lastActivity = Date.now();
  clearWrongTimeout(room);
  room.wrongTimeout = setTimeout(() => {
    room.revealed = [];
    room.flash = null;
    room.next = 1;
    room.wrongTimeout = null;
    if (room.phase !== 'play' || room.players.length === 0) {
      room.locked = false;
      return;
    }
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    room.locked = false;
    room.lastActivity = Date.now();
    startTurn(room);
    broadcastRoomState(room);
  }, WRONG_PICK_DELAY_MS);
  if (room.wrongTimeout.unref) room.wrongTimeout.unref();
  broadcastRoomState(room);
}

// Single shared entry point for leaving: used by the 'leave' message and the
// socket 'close'/'error' handlers.
function handleLeaveConnection(ws) {
  const roomCode = clientRooms.get(ws);
  clientRooms.delete(ws);
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  const { removed, deleted } = removePlayer(room, ws);

  if (!removed) return;

  if (deleted) {
    rooms.delete(roomCode);
    return;
  }

  room.lastActivity = Date.now();
  broadcastRoomState(room);
}

function handleLeave(ws, msg) {
  handleLeaveConnection(ws);
}

function handleDisconnect(ws) {
  handleLeaveConnection(ws);
}

function generatePlayerId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function startRound(room) {
  clearWrongTimeout(room);
  clearTurnTimeout(room);
  room.circles = generateCircles(room.n);
  room.revealed = [];
  room.flash = null;
  room.currentPlayerIndex = 0;
  room.next = 1;
  room.locked = false;
  room.phase = 'play';
  room.lastEvent = null;
  room.lastActivity = Date.now();
  startTurn(room);
}

function getRoomState(room, youId) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      best: p.best || 0,
      wins: p.wins || 0,
      connected: p.connected
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    next: room.next,
    n: room.n,
    circles: room.circles,
    revealed: room.revealed,
    flash: room.flash,
    locked: room.locked,
    turnId: room.turnId,
    timeLimitMs: room.timeLimitMs,
    turnRemainingMs: room.timerRunning
      ? Math.max(0, room.timeLimitMs - (Date.now() - room.turnStartedAt))
      : 0,
    timerRunning: room.timerRunning,
    lastEvent: room.lastEvent || null,
    youId: youId
  };
}

function broadcastRoomState(room) {
  room.players.forEach(p => {
    if (p.connected && p.ws.readyState === WebSocket.OPEN) {
      send(p.ws, 'room_state', getRoomState(room, p.id));
    }
  });
}

// Ping/pong heartbeat to detect dead connections
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL).unref();

module.exports = {
  generateCircles,
  shuffleArray,
  sanitizeName,
  generateRoomCode,
  Room,
  removePlayer,
  clampIndex,
  turnTimeLimitSeconds,
  startRound,
  startTurn,
  handleTurnTimeout,
  clearTurnTimeout,
  restartRound
};

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Number Rush server listening on port ${PORT}`);
  });
}