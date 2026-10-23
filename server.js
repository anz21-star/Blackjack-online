'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const engine = require('./game/engine');
const ai = require('./game/ai');

const PORT = process.env.PORT || 3000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// How long a dropped lobby member's seat is held for reclaim (ms).
const AWAY_GRACE_MS = Number(process.env.AWAY_GRACE_MS) || 90000;

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
      away: !!m.away,
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

// Private per-member reclaim token. Sent only in the create/join/reclaim
// acks to the member it belongs to; never part of any broadcast view.
function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function clearAwayTimer(member) {
  if (member && member.awayTimer) {
    clearTimeout(member.awayTimer);
    member.awayTimer = null;
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
  const seats = [];
  const staying = [];
  for (const m of room.members) {
    clearAwayTimer(m); // the game now holds their place, not the grace timer
    if (m.away) {
      // Dropped before the start: a CPU minds their seat, stamped with
      // their token so they can reclaim it if they reconnect mid-game.
      seats.push({ key: null, name: m.name, isCPU: true, humanToken: m.token });
      room.detached.push({ token: m.token, name: m.name });
    } else {
      staying.push(m);
      seats.push({ key: m.socketId, name: m.name, isCPU: false });
    }
  }
  room.members = staying;
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

// Hand a CPU-minded seat back to its human, identified by reclaim
// token. Returns true when a seat was rebound.
function rebindSeat(room, token, socketId) {
  if (!room.game) return false;
  const seat = room.game.players.find((p) => p.humanToken && p.humanToken === token);
  if (!seat || seat.key) return false;
  seat.key = socketId;
  seat.isCPU = false;
  seat.humanToken = null;
  return true;
}

function removeFromLobby(room, socketId) {
  const departing = room.members.find((m) => m.socketId === socketId);
  if (departing) clearAwayTimer(departing);
  room.members = room.members.filter((m) => m.socketId !== socketId);
  if (room.hostKey === socketId) {
    const next = room.members.length ? room.members[0] : null;
    room.hostKey = next ? next.socketId : null;
    room.hostToken = next ? next.token : null;
  }
  if (room.members.length === 0 && !room.game) {
    clearRoomTimer(room);
    rooms.delete(room.code);
    return false;
  }
  return true;
}

function handleDeparture(socket, explicit) {
  const code = socket.data.code;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.code = null;
  if (!room) return;

  const member = room.members.find((m) => m.socketId === socket.id);

  if (room.game && room.game.phase !== 'over') {
    // Mid-game: the seat becomes a CPU so the game continues. The member
    // record moves to room.detached (and the seat is stamped with their
    // token) so they can reclaim the seat if they reconnect.
    const idx = seatIndexOf(room, socket.id);
    if (idx < 0 && !member) return; // stale socket; its seat was already reclaimed
    if (idx >= 0) {
      const seat = room.game.players[idx];
      seat.isCPU = true;
      seat.key = null;
      if (member) seat.humanToken = member.token;
      room.game.log.push(`${seat.name} disconnected — a CPU takes over their seat.`);
    }
    if (member) {
      room.members = room.members.filter((m) => m !== member);
      room.detached.push({ token: member.token, name: member.name });
    }
    if (room.hostKey === socket.id) {
      const nextHost = room.game.players.find((p) => p.key);
      room.hostKey = nextHost ? nextHost.key : null;
      const hostMember = nextHost ? room.members.find((m) => m.socketId === nextHost.key) : null;
      room.hostToken = hostMember ? hostMember.token : null;
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

  // Lobby, or a finished game.
  if (!member) return; // stale socket; its membership was already reclaimed
  room.game = null;
  if (explicit) {
    if (removeFromLobby(room, socket.id)) broadcastLobby(room);
    return;
  }
  // A dropped connection gets a grace period: the member stays in the
  // lobby, marked away, and is only removed if they don't reclaim in
  // time. The host dropping holds the room open the same way.
  member.away = true;
  clearAwayTimer(member);
  member.awayTimer = setTimeout(() => {
    member.awayTimer = null;
    if (rooms.get(room.code) !== room) return; // room already gone/replaced
    if (removeFromLobby(room, member.socketId)) broadcastLobby(room);
  }, AWAY_GRACE_MS);
  broadcastLobby(room);
}

// ------------------------------------------------------------------ sockets

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name } = {}, cb) => {
    const code = makeCode();
    const token = makeToken();
    const room = {
      code,
      hostKey: socket.id,
      hostToken: token,
      fillCPU: true,
      members: [{ socketId: socket.id, name: cleanName(name), token, away: false, awayTimer: null }],
      detached: [], // members whose game seat a CPU is minding: { token, name }
      game: null,
      startSeat: 0,
      timer: null,
    };
    rooms.set(code, room);
    socket.data.code = code;
    if (cb) cb({ ok: true, code, token });
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
    const token = makeToken();
    room.members.push({ socketId: socket.id, name: cleanName(name), token, away: false, awayTimer: null });
    socket.data.code = room.code;
    if (cb) cb({ ok: true, code: room.code, token });
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
    const seats = room.game.players.map((p) => ({
      key: p.key,
      name: p.name,
      isCPU: p.isCPU,
      humanToken: p.key ? null : p.humanToken || null,
    }));
    room.game = engine.createGame(seats, room.startSeat % seats.length);
    room.startSeat += 1;
    if (cb) cb({ ok: true });
    settle(room);
  });

  socket.on('reclaim', ({ code, token } = {}, cb) => {
    const fail = () => {
      if (cb) cb({ ok: false });
    };
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room || !token) return fail();
    if (socket.data.code && socket.data.code !== room.code) return fail();
    const inGame = !!(room.game && room.game.phase !== 'over');

    // Still on the member list: a lobby member inside the grace period,
    // or a player whose dropped socket has not been noticed as gone yet.
    const member = room.members.find((m) => m.token === token);
    if (member) {
      const prevSocketId = member.socketId;
      clearAwayTimer(member);
      member.away = false;
      member.socketId = socket.id;
      socket.data.code = room.code;
      if (room.hostToken === token) room.hostKey = socket.id;
      if (cb) cb({ ok: true, isHost: room.hostKey === socket.id, inGame });
      if (inGame) {
        const idx = room.game.players.findIndex((p) => p.key === prevSocketId);
        if (idx >= 0) room.game.players[idx].key = socket.id;
        settle(room);
      } else if (room.game) {
        // Finished game: rebind the seat so Play again keeps them human.
        const idx = room.game.players.findIndex((p) => p.key === prevSocketId);
        if (idx >= 0) room.game.players[idx].key = socket.id;
        broadcastGame(room);
      } else {
        broadcastLobby(room);
      }
      return;
    }

    // Not a member: they dropped mid-game (or were away at the start)
    // and a CPU is minding their seat.
    const dIdx = room.detached.findIndex((d) => d.token === token);
    if (dIdx < 0) return fail();
    if (!room.game && room.members.length >= 4) return fail(); // lobby filled up meanwhile
    const [entry] = room.detached.splice(dIdx, 1);
    room.members.push({ socketId: socket.id, name: entry.name, token, away: false, awayTimer: null });
    socket.data.code = room.code;
    if (room.hostToken === token) room.hostKey = socket.id;
    if (cb) cb({ ok: true, isHost: room.hostKey === socket.id, inGame });
    if (inGame) {
      if (rebindSeat(room, token, socket.id)) {
        room.game.log.push(`${entry.name} reconnected — retakes their seat.`);
      }
      // settle() also clears any AI move still pending for that seat.
      settle(room);
    } else if (room.game) {
      rebindSeat(room, token, socket.id);
      broadcastGame(room);
    } else {
      broadcastLobby(room);
    }
  });

  socket.on('leaveRoom', () => {
    handleDeparture(socket, true);
  });

  socket.on('disconnect', () => {
    handleDeparture(socket, false);
  });
});

server.listen(PORT, () => {
  console.log(`Blackjack server listening on port ${PORT}`);
});
