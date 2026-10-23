'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const engine = require('./game/engine');
const ai = require('./game/ai');

const PORT = process.env.PORT || 3000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ------------------------------------------------------------------ rooms

const rooms = new Map(); // code -> room

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 20);
  return n || 'Player';
}

function lobbyView(room, socketId) {
  return {
    screen: 'lobby',
    code: room.code,
    isHost: room.hostKey === socketId,
    fillCPU: room.fillCPU,
    members: room.members.map((m) => ({
      name: m.name,
      isYou: m.socketId === socketId,
      isHost: m.socketId === room.hostKey,
    })),
    canStart:
      room.hostKey === socketId && (room.fillCPU ? room.members.length >= 1 : room.members.length >= 2),
  };
}

function broadcastLobby(room) {
  for (const m of room.members) {
    io.to(m.socketId).emit('state', lobbyView(room, m.socketId));
  }
}

function broadcastGame(room) {
  const state = room.game;
  if (!state) return;
  state.players.forEach((p, idx) => {
    if (p.key) {
      const view = engine.buildView(state, idx);
      view.code = room.code;
      view.isHost = room.hostKey === p.key;
      io.to(p.key).emit('state', view);
    }
  });
}

// CPUs call "last cards" as soon as they are eligible, just like a player
// who is paying attention (the call is allowed at any time before their
// next turn, not just on their turn).
function cpuDeclareSweep(room) {
  const state = room.game;
  if (!state || state.phase !== 'playing') return;
  state.players.forEach((p, idx) => {
    if (p.isCPU && engine.canDeclare(state, idx)) engine.applyDeclare(state, idx);
  });
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function scheduleAi(room) {
  clearRoomTimer(room);
  const state = room.game;
  if (!state || state.phase === 'over') return;
  const actorIdx = state.phase === 'bringback' ? state.bringBack.actor : state.current;
  const actor = state.players[actorIdx];
  if (!actor || !actor.isCPU) return;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.game !== state) return; // game was replaced (play again)
    cpuDeclareSweep(room);
    const action = ai.chooseAction(state, actorIdx);
    let res;
    if (action.type === 'play') {
      res = engine.applyPlay(state, actorIdx, action.cardIds, action.declaredSuit);
      if (!res.ok) res = engine.applyPickup(state, actorIdx); // fall back rather than stall
    } else {
      res = engine.applyPickup(state, actorIdx);
    }
    if (!res.ok) {
      // Last resort: log and stop the chain rather than spin.
      console.error(`AI action failed in room ${room.code}:`, res.error);
      return;
    }
    cpuDeclareSweep(room);
    broadcastGame(room);
    scheduleAi(room);
  }, 850 + Math.random() * 550);
}

function settle(room) {
  cpuDeclareSweep(room);
  if (room.game) broadcastGame(room);
  else broadcastLobby(room);
  scheduleAi(room);
}

function startGame(room) {
  const seats = room.members.map((m) => ({ key: m.socketId, name: m.name, isCPU: false }));
  if (room.fillCPU) {
    let n = 1;
    while (seats.length < 4) {
      seats.push({ key: null, name: `CPU ${n++}`, isCPU: true });
    }
  }
  room.game = engine.createGame(seats, room.startSeat % seats.length);
  room.startSeat += 1;
  settle(room);
}

function seatIndexOf(room, socketId) {
  if (!room.game) return -1;
  return room.game.players.findIndex((p) => p.key === socketId);
}

function removeFromLobby(room, socketId) {
  room.members = room.members.filter((m) => m.socketId !== socketId);
  if (room.hostKey === socketId) {
    room.hostKey = room.members.length ? room.members[0].socketId : null;
  }
  if (room.members.length === 0 && !room.game) {
    clearRoomTimer(room);
    rooms.delete(room.code);
    return false;
  }
  return true;
}

function handleDeparture(socket) {
  const code = socket.data.code;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.code = null;
  if (!room) return;

  if (room.game && room.game.phase !== 'over') {
    // Mid-game: the seat becomes a CPU so the game continues.
    const idx = seatIndexOf(room, socket.id);
    if (idx >= 0) {
      const seat = room.game.players[idx];
      seat.isCPU = true;
      seat.key = null;
      room.game.log.push(`${seat.name} disconnected — a CPU takes over their seat.`);
    }
    room.members = room.members.filter((m) => m.socketId !== socket.id);
    if (room.hostKey === socket.id) {
      const nextHost = room.game.players.find((p) => p.key);
      room.hostKey = nextHost ? nextHost.key : null;
    }
    if (!room.game.players.some((p) => p.key)) {
      // Nobody human left: abandon the room.
      clearRoomTimer(room);
      rooms.delete(room.code);
      return;
    }
    settle(room);
    return;
  }

  // Lobby, or a finished game: just leave.
  room.game = null;
  if (removeFromLobby(room, socket.id)) broadcastLobby(room);
}

// ------------------------------------------------------------------ sockets

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name } = {}, cb) => {
    const code = makeCode();
    const room = {
      code,
      hostKey: socket.id,
      fillCPU: true,
      members: [{ socketId: socket.id, name: cleanName(name) }],
      game: null,
      startSeat: 0,
      timer: null,
    };
    rooms.set(code, room);
    socket.data.code = code;
    if (cb) cb({ ok: true, code });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) {
      if (cb) cb({ ok: false, error: 'No room with that code.' });
      return;
    }
    if (room.game && room.game.phase !== 'over') {
      if (cb) cb({ ok: false, error: 'That game has already started.' });
      return;
    }
    if (room.game && room.game.phase === 'over') room.game = null; // finished: room is a lobby again
    if (room.members.length >= 4) {
      if (cb) cb({ ok: false, error: 'That room is full.' });
      return;
    }
    room.members.push({ socketId: socket.id, name: cleanName(name) });
    socket.data.code = room.code;
    if (cb) cb({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('setFillCPU', ({ fill } = {}, cb) => {
    const room = rooms.get(socket.data.code || '');
    if (!room || room.game) return;
    if (room.hostKey !== socket.id) {
      if (cb) cb({ ok: false, error: 'Only the host can change that.' });
      return;
    }
    room.fillCPU = !!fill;
    if (cb) cb({ ok: true });
    broadcastLobby(room);
  });

  socket.on('startGame', (_data, cb) => {
    const room = rooms.get(socket.data.code || '');
    if (!room || room.game) {
      if (cb) cb({ ok: false, error: 'No lobby to start from.' });
      return;
    }
    if (room.hostKey !== socket.id) {
      if (cb) cb({ ok: false, error: 'Only the host can start the game.' });
      return;
    }
    if (!room.fillCPU && room.members.length < 2) {
      if (cb) cb({ ok: false, error: 'With CPU fill off you need at least 2 human players.' });
      return;
    }
    if (room.members.length < 1) {
      if (cb) cb({ ok: false, error: 'The room is empty.' });
      return;
    }
    if (cb) cb({ ok: true });
    startGame(room);
  });

  socket.on('play', ({ cardIds, declaredSuit } = {}, cb) => {
    const room = rooms.get(socket.data.code || '');
    if (!room || !room.game) {
      if (cb) cb({ ok: false, error: 'No game running.' });
      return;
    }
    const idx = seatIndexOf(room, socket.id);
    if (idx < 0) {
      if (cb) cb({ ok: false, error: 'You are not in this game.' });
      return;
    }
    const res = engine.applyPlay(room.game, idx, cardIds, declaredSuit || null);
    if (cb) cb(res);
    if (res.ok) settle(room);
  });

  socket.on('pickup', (_data, cb) => {
    const room = rooms.get(socket.data.code || '');
    if (!room || !room.game) {
      if (cb) cb({ ok: false, error: 'No game running.' });
      return;
    }
    const idx = seatIndexOf(room, socket.id);
    if (idx < 0) {
      if (cb) cb({ ok: false, error: 'You are not in this game.' });
      return;
    }
    const res = engine.applyPickup(room.game, idx);
    if (cb) cb(res);
    if (res.ok) settle(room);
  });

  socket.on('declare', (_data, cb) => {
    const room = rooms.get(socket.data.code || '');
    if (!room || !room.game) {
      if (cb) cb({ ok: false, error: 'No game running.' });
      return;
    }
    const idx = seatIndexOf(room, socket.id);
    if (idx < 0) {
      if (cb) cb({ ok: false, error: 'You are not in this game.' });
      return;
    }
    const res = engine.applyDeclare(room.game, idx);
    if (cb) cb(res);
    if (res.ok) broadcastGame(room);
  });

  socket.on('playAgain', (_data, cb) => {
    const room = rooms.get(socket.data.code || '');
    if (!room || !room.game || room.game.phase !== 'over') {
      if (cb) cb({ ok: false, error: 'The game is not over yet.' });
      return;
    }
    const hostSeat = room.game.players.find((p) => p.key && p.key === room.hostKey);
    if (room.hostKey !== socket.id && hostSeat) {
      if (cb) cb({ ok: false, error: 'Only the host can start the next game.' });
      return;
    }
    const seats = room.game.players.map((p) => ({ key: p.key, name: p.name, isCPU: p.isCPU }));
    room.game = engine.createGame(seats, room.startSeat % seats.length);
    room.startSeat += 1;
    if (cb) cb({ ok: true });
    settle(room);
  });

  socket.on('leaveRoom', () => {
    handleDeparture(socket);
  });

  socket.on('disconnect', () => {
    handleDeparture(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Blackjack server listening on port ${PORT}`);
});
