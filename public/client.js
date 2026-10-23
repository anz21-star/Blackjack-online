'use strict';

/* Blackjack (British, Crazy 8s-style) — multiplayer client.
   The server is authoritative; the mirroring of the play rules here only
   drives highlighting and the Play button. Anything the mirror lets
   through is still validated server-side. */

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const SYM = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SUIT_NAME = { spades: 'Spades', hearts: 'Hearts', diamonds: 'Diamonds', clubs: 'Clubs' };

const socket = io();
let state = null; // latest server state (lobby or game)
let selected = []; // card ids, in tap order
let renderedSeq = 0; // lastPlay seq already animated
let displayedTop = []; // discard fan contents (lags during play animation)
let fanTimer = null;
let suitPickFor = null; // cardIds awaiting a declared suit

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  setTimeout(() => ($toast.hidden = true), 3400);
}

function emit(event, data) {
  return new Promise((resolve) => socket.emit(event, data || {}, resolve));
}

// ------------------------------------------------------------- room reclaim

// The server gives each room member a private token. Keeping it (with
// the room code) in localStorage lets a dropped connection reclaim its
// seat after Socket.IO reconnects with a fresh socket id.
const ROOM_STORE_KEY = 'bj-room';
let myRoom = null; // { code, name, token }
let reclaimInFlight = false;

function loadStoredRoom() {
  try {
    const raw = localStorage.getItem(ROOM_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.code && parsed.token) return parsed;
  } catch {}
  return null;
}

function storeRoom(details) {
  myRoom = details;
  try {
    if (details) localStorage.setItem(ROOM_STORE_KEY, JSON.stringify(details));
    else localStorage.removeItem(ROOM_STORE_KEY);
  } catch {}
}

function sameRoom(a, b) {
  return !!a && !!b && a.code === b.code && a.token === b.token;
}

myRoom = loadStoredRoom();

// ------------------------------------------------------------- card utils

function rankValue(r) {
  if (r === 'A') return 14;
  if (r === 'K') return 13;
  if (r === 'Q') return 12;
  if (r === 'J') return 11;
  return parseInt(r, 10);
}
const isRed = (c) => c.suit === 'hearts' || c.suit === 'diamonds';
const isBlackJack = (c) => c.rank === 'J' && !isRed(c);
const isRedJack = (c) => c.rank === 'J' && isRed(c);

function ranksAdjacent(a, b) {
  if (Math.abs(rankValue(a) - rankValue(b)) === 1) return true;
  return (a === 'A' && b === '2') || (a === '2' && b === 'A');
}
function linksTo(prev, next) {
  if (prev.rank === 'Q') return true;
  if (prev.rank === next.rank) return true;
  if (prev.suit !== next.suit) return false;
  return ranksAdjacent(prev.rank, next.rank);
}
function powerTag(c) {
  if (c.rank === '2') return '+2 pick up';
  if (isBlackJack(c)) return '+5 pick up';
  if (isRedJack(c)) return 'cancels pick up';
  if (c.rank === '8') return 'skip';
  if (c.rank === 'K') return 'reverse';
  if (c.rank === 'Q') return 'must be covered';
  if (c.rank === 'A') return 'name a suit';
  return '';
}

// ------------------------------------------------------------- validation mirror

function topCard() {
  if (!state || !state.topCards || !state.topCards.length) return null;
  return state.topCards[state.topCards.length - 1];
}

function myTurnContext() {
  if (!state || state.screen !== 'game') return 'none';
  if (state.phase === 'bringback' && state.bringBack && state.bringBack.actorIdx === state.yourIdx) return 'bringback';
  if (state.phase === 'playing' && state.currentIdx === state.yourIdx) return 'turn';
  return 'none';
}

function firstLegal(card) {
  const top = topCard();
  if (!top) return false;
  if (top.rank === 'Q') return true;
  if (state.requiredSuit) return card.suit === state.requiredSuit || card.rank === 'A';
  if (card.rank === 'A') return true;
  return card.suit === top.suit || card.rank === top.rank;
}

function validateSelection() {
  const ctx = myTurnContext();
  if (ctx === 'none') return { ok: false, msg: '' };
  if (selected.length === 0) return { ok: false, msg: '' };
  const hand = state.yourHand;
  const cards = selected.map((id) => hand.find((c) => c.id === id));
  if (cards.some((c) => !c)) return { ok: false, msg: '' };

  if (ctx === 'bringback') {
    if (cards.every(isRedJack)) return { ok: true, msg: 'Cancel the bring-back.' };
    if (cards.every((c) => c.rank === '2' || isBlackJack(c))) return { ok: true, msg: 'Bring them back in!' };
    return { ok: false, msg: 'Only pick up cards (2s, black Jacks) — or a red Jack to cancel.' };
  }
  if (state.chain) {
    if (!cards.every((c) => c.rank === '2' || c.rank === 'J')) {
      return { ok: false, msg: 'Pick up pending — only a 2, a black Jack, or a red Jack to cancel.' };
    }
    if (cards.some(isRedJack) && !cards.every(isRedJack)) {
      return { ok: false, msg: 'Red Jacks cancel on their own.' };
    }
    return { ok: true, msg: '' };
  }
  if (!firstLegal(cards[0])) return { ok: false, msg: 'That card can\'t open your play here.' };
  for (let i = 1; i < cards.length; i++) {
    if (!linksTo(cards[i - 1], cards[i])) {
      return {
        ok: false,
        msg: 'In a run, each next card must link from the last: same rank, or same suit and consecutive (anything can cover a Queen).',
      };
    }
  }
  const final = cards[cards.length - 1];
  if (final.rank === 'Q') return { ok: false, msg: 'A Queen must be covered — a play can\'t end on a Queen.' };
  if (final.rank === 'A') return { ok: true, msg: '', needsSuit: true };
  return { ok: true, msg: '' };
}

function isCardPlayableFirst(card) {
  const ctx = myTurnContext();
  if (ctx === 'none') return false;
  if (ctx === 'bringback') return card.rank === '2' || card.rank === 'J';
  if (state.chain) return card.rank === '2' || card.rank === 'J';
  if (card.rank === 'Q') {
    // A lone Queen can never be played (it must be covered) unless it starts a run.
    return firstLegal(card);
  }
  return firstLegal(card);
}

// ------------------------------------------------------------- rendering: home

function renderHome() {
  const saved = localStorage.getItem('bj-name') || '';
  $app.innerHTML = `
    <h1>Blackjack</h1>
    <p class="sub">The British card game — not the casino one. 2–4 players, one room code, no accounts.</p>
    <div class="panel">
      <input type="text" id="name" placeholder="Your name" value="${escapeHtml(saved)}" maxlength="20">
      <button class="primary" id="create" style="width:100%">Create a room</button>
    </div>
    <div class="panel">
      <input type="text" id="code" class="code" placeholder="CODE" maxlength="4">
      <button id="join" style="width:100%">Join room</button>
    </div>`;
  document.getElementById('create').onclick = async () => {
    const name = document.getElementById('name').value.trim();
    localStorage.setItem('bj-name', name);
    const res = await emit('createRoom', { name });
    if (!res || !res.ok) toast((res && res.error) || 'Could not create a room.');
    else storeRoom({ code: res.code, name, token: res.token });
  };
  document.getElementById('join').onclick = async () => {
    const name = document.getElementById('name').value.trim();
    const code = document.getElementById('code').value.trim().toUpperCase();
    localStorage.setItem('bj-name', name);
    if (!code) return toast('Enter the room code.');
    const res = await emit('joinRoom', { code, name });
    if (!res || !res.ok) toast((res && res.error) || 'Could not join that room.');
    else storeRoom({ code: res.code, name, token: res.token });
  };
}

// ------------------------------------------------------------- rendering: lobby

function renderLobby() {
  const members = state.members
    .map(
      (m) =>
        `<div class="member"><span>${escapeHtml(m.name)}${m.isYou ? ' (you)' : ''}${m.away ? ' (away)' : ''}</span>${
          m.isHost ? '<span class="tag-host">HOST</span>' : ''
        }</div>`
    )
    .join('');
  $app.innerHTML = `
    <h1>Blackjack</h1>
    <p class="sub">Share this code with your friends:</p>
    <div class="room-code">${state.code}</div>
    <div class="panel">${members}</div>
    ${
      state.isHost
        ? `<div class="panel">
             <label class="toggle"><input type="checkbox" id="fill" ${state.fillCPU ? 'checked' : ''}> Fill empty seats with computer players (games are 4 seats)</label>
             <p class="small">With fill off, the game uses just the humans in the room — you need at least 2.</p>
             <button class="primary" id="start" style="width:100%" ${state.canStart ? '' : 'disabled'}>Start game</button>
           </div>`
        : `<div class="panel center-text">Waiting for the host to start…</div>`
    }
    <div class="center-text"><button class="ghost" id="leave">Leave room</button></div>`;
  const leave = document.getElementById('leave');
  if (leave) leave.onclick = leaveRoom;
  if (state.isHost) {
    document.getElementById('fill').onchange = async (e) => {
      await emit('setFillCPU', { fill: e.target.checked });
    };
    document.getElementById('start').onclick = async () => {
      const res = await emit('startGame', {});
      if (!res || !res.ok) toast((res && res.error) || 'Could not start.');
    };
  }
}

// ------------------------------------------------------------- rendering: game

function seatClass(view, idx) {
  const n = view.players.length;
  const rel = (idx - view.yourIdx + n) % n;
  if (rel === 0) return 'seat-bottom';
  if (n === 2) return 'seat-top';
  if (n === 3) return rel === 1 ? 'seat-topleft' : 'seat-topright';
  return ['seat-bottom', 'seat-left', 'seat-top', 'seat-right'][rel];
}

function cardEl(card, extra) {
  const colour = isRed(card) ? 'red' : 'black';
  const tag = powerTag(card);
  return `<div class="card ${colour} ${extra || ''}">
    <span class="rank">${card.rank}</span><span class="suit">${SYM[card.suit]}</span>
    ${tag ? `<span class="ptag">${tag}</span>` : ''}
  </div>`;
}

function seatEl(view, p) {
  const isActor =
    (view.phase === 'playing' && view.currentIdx === p.idx) ||
    (view.phase === 'bringback' && view.bringBack && view.bringBack.actorIdx === p.idx);
  return `<div class="seat ${seatClass(view, p.idx)} ${isActor ? 'active-turn' : ''} ${p.out ? 'out' : ''}" data-seat="${p.idx}">
    ${p.declared ? '<div class="bubble">Last Cards!</div>' : ''}
    <div class="sname">${escapeHtml(p.name)}${p.isYou ? ' (you)' : ''}${p.isCPU ? '' : ''}</div>
    <div class="scount">${
      p.out
        ? `<span>${p.place ? ordinal(p.place) + ' place' : 'Out'}</span>`
        : `<span class="mini-back"></span><span>× ${p.cardCount}</span>${p.isCPU ? '' : p.connected ? '' : ' (away)'}`
    }</div>
  </div>`;
}

function ordinal(n) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[n] || `${n}th`;
}

function renderGame() {
  const view = state;
  const me = view.players[view.yourIdx];
  const ctx = myTurnContext();
  const check = validateSelection();
  const selCards = selected.map((id) => view.yourHand.find((c) => c.id === id)).filter(Boolean);

  const seats = view.players.map((p) => seatEl(view, p)).join('');
  const fan = displayedTop.map((c) => cardEl(c)).join('');

  let banner = '';
  if (view.phase === 'bringback' && view.bringBack) {
    const fin = view.players[view.bringBack.finisherIdx].name;
    const actor = view.players[view.bringBack.actorIdx].name;
    banner = `<div class="banner">${fin} is out — unless a pick up chain reaches them. ${actor} to act${
      view.bringBack.total ? ` (chain at ${view.bringBack.total})` : ''
    }.</div>`;
  } else if (view.chain && view.phase === 'playing') {
    banner = `<div class="banner">Pick up ${view.pending} pending — play a 2 or black Jack to add to it, a red Jack to cancel, or pick up ${view.pending}.</div>`;
  }

  const turnName =
    view.phase === 'playing'
      ? view.currentIdx === view.yourIdx
        ? 'Your turn'
        : `${view.players[view.currentIdx].name}'s turn`
      : view.phase === 'over'
        ? 'Game over'
        : 'Bring-back';

  const pickupLabel =
    view.phase === 'bringback'
      ? view.bringBack && view.bringBack.total > 0
        ? `Pick up ${view.bringBack.total}`
        : 'Pass'
      : view.chain
        ? `Pick up ${view.pending}`
        : 'Pick up 1';

  const handHtml = view.yourHand
    .map((c) => {
      const selIdx = selected.indexOf(c.id);
      const playable = selected.length === 0 ? isCardPlayableFirst(c) : false;
      return `<div class="card ${isRed(c) ? 'red' : 'black'} ${selIdx >= 0 ? 'selected' : ''} ${
        selected.length === 0 && ctx !== 'none' ? (playable ? 'legal' : 'dim') : ''
      }" data-card="${c.id}">
        ${selIdx >= 0 ? `<span class="order-badge">${selIdx + 1}</span>` : ''}
        <span class="rank">${c.rank}</span><span class="suit">${SYM[c.suit]}</span>
        ${powerTag(c) ? `<span class="ptag">${powerTag(c)}</span>` : ''}
      </div>`;
    })
    .join('');

  const overHtml =
    view.phase === 'over' && view.placements
      ? `<div class="modal"><div class="box">
           <h2 style="margin-top:0">Game over</h2>
           ${view.placements
             .slice()
             .sort((a, b) => a.place - b.place)
             .map((p) => `<div class="member"><span>${ordinal(p.place)}</span><span>${escapeHtml(p.name)}</span></div>`)
             .join('')}
           <div style="margin-top:14px"><button class="primary" id="again">Play again</button></div>
           <p class="small">Only the host can start the next game (unless they've left).</p>
         </div></div>`
      : '';

  $app.innerHTML = `
    <h1>Blackjack</h1>
    <div class="table" id="table">
      ${seats}
      <div class="centre">
        <div class="pile"><div class="draw-back"></div><div class="label">Draw · ${view.drawCount}</div></div>
        <div class="pile"><div class="fan" id="fan">${fan}</div><div class="label">Discard · room ${view.code}</div></div>
      </div>
    </div>
    <div class="meta-row">
      <span class="chip">${view.direction === 1 ? '↻ Clockwise' : '↺ Counter-clockwise'}</span>
      <span class="chip turn">${turnName}</span>
      ${view.requiredSuit ? `<span class="chip">Suit to follow: ${SYM[view.requiredSuit]} ${SUIT_NAME[view.requiredSuit]}</span>` : ''}
    </div>
    ${banner}
    <div class="hand-title">Your hand · ${view.yourHand.length}</div>
    <div class="hand" id="hand">${handHtml}</div>
    <div class="hint ${check.ok ? 'ok' : 'err'}" id="hint">${
      selected.length
        ? check.msg || `Playing: ${selCards.map((c) => `${c.rank}${SYM[c.suit]}`).join(' → ')}`
        : me && me.declared
          ? 'You have called last cards.'
          : ''
    }</div>
    <div class="controls">
      <button class="primary" id="play" ${check.ok ? '' : 'disabled'}>Play${selected.length ? ` (${selected.length})` : ''}</button>
      <button class="warn" id="pickup" ${ctx !== 'none' ? '' : 'disabled'}>${pickupLabel}</button>
      <button id="declare" ${view.canDeclare ? '' : 'disabled'}>${
        me && me.declared ? 'Last cards called ✓' : 'Call "last cards"'
      }</button>
      <button class="ghost" id="clear" ${selected.length ? '' : 'disabled'}>Clear</button>
    </div>
    <div class="center-text"><button class="ghost" id="leave">Leave room</button></div>
    <div class="log" id="log">${view.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>
    ${overHtml}
    <div id="suit-modal"></div>`;

  // wire up
  document.querySelectorAll('#hand .card').forEach((el) => {
    el.onclick = () => toggleCard(el.dataset.card);
  });
  document.getElementById('play').onclick = onPlay;
  document.getElementById('pickup').onclick = async () => {
    const res = await emit('pickup', {});
    if (!res || !res.ok) toast((res && res.error) || 'That pick up is not allowed.');
    else selected = [];
  };
  document.getElementById('declare').onclick = async () => {
    const res = await emit('declare', {});
    if (!res || !res.ok) toast((res && res.error) || 'You can\'t call last cards right now.');
  };
  document.getElementById('clear').onclick = () => {
    selected = [];
    render();
  };
  const leave = document.getElementById('leave');
  if (leave) leave.onclick = leaveRoom;
  const again = document.getElementById('again');
  if (again)
    again.onclick = async () => {
      const res = await emit('playAgain', {});
      if (!res || !res.ok) toast((res && res.error) || 'Only the host can start the next game.');
    };
  const log = document.getElementById('log');
  if (log) log.scrollTop = log.scrollHeight;
}

function toggleCard(id) {
  const i = selected.indexOf(id);
  if (i >= 0) selected.splice(i, 1);
  else selected.push(id);
  render();
}

async function onPlay() {
  const check = validateSelection();
  if (!check.ok) return;
  if (check.needsSuit) {
    suitPickFor = selected.slice();
    renderSuitPicker();
    return;
  }
  const res = await emit('play', { cardIds: selected.slice(), declaredSuit: null });
  if (!res || !res.ok) toast((res && res.error) || 'That play is not allowed.');
  else selected = [];
}

function renderSuitPicker() {
  const modal = document.getElementById('suit-modal');
  if (!modal) return;
  modal.innerHTML = `<div class="modal"><div class="box">
    <div>Your Ace names the suit to follow:</div>
    <div class="suits">${SUITS.map(
      (s) => `<button data-suit="${s}" style="color:${s === 'hearts' || s === 'diamonds' ? '#f0a294' : '#dfe9f2'}">${SYM[s]}</button>`
    ).join('')}</div>
  </div></div>`;
  modal.querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      const res = await emit('play', { cardIds: suitPickFor, declaredSuit: b.dataset.suit });
      suitPickFor = null;
      document.getElementById('suit-modal').innerHTML = '';
      if (!res || !res.ok) toast((res && res.error) || 'That play is not allowed.');
      else selected = [];
    };
  });
}

function leaveRoom() {
  storeRoom(null); // explicit leave: no reclaim afterwards
  socket.emit('leaveRoom', {});
  state = null;
  selected = [];
  renderedSeq = 0;
  displayedTop = [];
  render();
}

// ------------------------------------------------------------- animation

function animatePlay(lp) {
  const table = document.getElementById('table');
  const fan = document.getElementById('fan');
  if (!table || !fan) return;
  const seatEl = table.querySelector(`[data-seat="${lp.playerIdx}"]`);
  const from = (seatEl || table).getBoundingClientRect();
  const to = fan.getBoundingClientRect();
  lp.cards.forEach((card, i) => {
    const el = document.createElement('div');
    el.innerHTML = cardEl(card);
    const inner = el.firstChild;
    inner.classList.add('fly-card');
    inner.style.left = `${from.left + from.width / 2 - 27}px`;
    inner.style.top = `${from.top + 10}px`;
    document.body.appendChild(inner);
    const dx = to.left + to.width / 2 - 27 - (from.left + from.width / 2 - 27);
    const dy = to.top - (from.top + 10);
    inner.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${(i % 3) - 1}deg)`, opacity: 1 },
      ],
      { duration: 550, delay: i * 380, easing: 'ease-in-out', fill: 'forwards' }
    );
    setTimeout(() => inner.remove(), i * 380 + 600);
  });
}

// ------------------------------------------------------------- main render

function render() {
  if (!state) return renderHome();
  if (state.screen === 'lobby') return renderLobby();
  return renderGame();
}

socket.on('state', (s) => {
  const prevScreen = state && state.screen;
  state = s;
  if (s.screen === 'game') {
    // Keep only still-valid selections.
    if (selected.length) {
      const handIds = new Set(s.yourHand.map((c) => c.id));
      selected = selected.filter((id) => handIds.has(id));
      if (myTurnContext() === 'none') selected = [];
    }
    if (s.lastPlay && s.lastPlay.seq > renderedSeq) {
      const lp = s.lastPlay;
      renderedSeq = lp.seq;
      render(); // render everything (hand, counts, log) first…
      animatePlay(lp); // …cards fly from the seat…
      const total = lp.cards.length * 380 + 550;
      if (fanTimer) clearTimeout(fanTimer);
      fanTimer = setTimeout(() => {
        displayedTop = state.topCards; // …and only then appear in the fan
        const fan = document.getElementById('fan');
        if (fan && state.screen === 'game') fan.innerHTML = displayedTop.map((c) => cardEl(c)).join('');
      }, total);
      return;
    }
    displayedTop = s.topCards;
    if (prevScreen !== 'game') renderedSeq = s.lastPlay ? s.lastPlay.seq : 0;
  }
  render();
});

socket.on('connect', async () => {
  // Every (re)connect gets a fresh socket id, which the server does not
  // recognise — reclaim the room from the stored details so a dropped
  // connection (app switch, signal loss) lands back in its lobby/seat.
  const saved = myRoom || loadStoredRoom();
  if (saved && !reclaimInFlight) {
    reclaimInFlight = true;
    const res = await emit('reclaim', { code: saved.code, token: saved.token });
    reclaimInFlight = false;
    if (res && res.ok) {
      // The server re-sends the lobby/game state, which re-renders.
      if (sameRoom(loadStoredRoom(), saved)) myRoom = saved;
      return;
    }
    // Failed — unless the player has since created/joined a different
    // room (stored details changed), that room is gone for good.
    if (sameRoom(loadStoredRoom(), saved)) {
      storeRoom(null);
      state = null;
      selected = [];
      render();
      toast('That room has ended — create a new one or rejoin with a fresh code.');
    }
    return;
  }
  if (!state) render();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

render();
