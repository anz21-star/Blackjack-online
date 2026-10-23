'use strict';

/* Blackjack (British, Crazy 8s-style) — multiplayer client.
   The server is authoritative; the mirroring of the play rules here only
   drives highlighting and the Play button. Anything the mirror lets
   through is still validated server-side. */

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const SYM = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };

const socket = io();
let state = null; // latest server state (lobby or game)
let selected = []; // card ids, in selected-row order (left to right = play order)
let renderedSeq = 0; // lastPlay seq already animated
let renderedPickupSeq = 0; // lastPickup seq already animated
let displayedTop = []; // discard fan contents (lags during play animation)
let fanTimer = null;
let suitPickFor = null; // cardIds awaiting a declared suit
let hintVisible = false; // guidance box shown via the hint button
let hintTimer = null; // 10s auto-hide timer for the guidance box
let hintStamp = null; // turn stamp captured when the box was shown

/* Display order for the local hand (card ids), drag-reorderable.
   Purely presentational: the play selection is still `selected`, in tap
   order, and the server never sees this order. */
let handOrder = [];
let drag = null; // in-progress hand-card pointer drag, or null
let selDrag = null; // in-progress selected-row pointer drag, or null
let renderQueued = false; // a render() arrived mid-drag and is deferred
const DRAG_THRESHOLD = 8; // px of pointer movement that turns a tap into a drag

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

/* An opponent's hand as a little fan of card-backs instead of a count:
   one mini back per card, tightly overlapped, capped so a huge hand
   still reads as "lots" without overflowing the seat. Side seats get a
   vertical stack of sideways (rotated) backs. */
const OPP_FAN_CAP = 10;
function oppFanHtml(count, vertical) {
  const n = Math.max(0, Math.min(count, OPP_FAN_CAP));
  let backs = '';
  for (let i = 0; i < n; i++) {
    const rot = n > 1 ? (i - (n - 1) / 2) * 3 : 0;
    backs += `<span class="mback" style="--r:${rot.toFixed(1)}deg"></span>`;
  }
  return `<span class="opp-fan${vertical ? ' v' : ''}">${backs}</span>`;
}

function seatEl(view, p) {
  const isActor =
    (view.phase === 'playing' && view.currentIdx === p.idx) ||
    (view.phase === 'bringback' && view.bringBack && view.bringBack.actorIdx === p.idx);
  const cls = seatClass(view, p.idx);
  const vertical = cls === 'seat-left' || cls === 'seat-right';
  // Speech bubbles sit ABOVE every seat box, uniformly (the CSS
  // anchors the stack to the seat's top edge, tail pointing down).
  // The seats along the table's top edge are inset far enough that
  // their stacks still render fully inside the table — no seat gets
  // a special below-the-box placement any more. "Last Cards!" and
  // the named-suit bubble stack in the same container when both
  // apply.
  const suitBubble =
    view.requiredSuit && view.suitDeclarerIdx === p.idx
      ? `<div class="bubble suit"><span class="sg ${isRed({ suit: view.requiredSuit }) ? 'sg-r' : 'sg-b'}">${SYM[view.requiredSuit]}</span></div>`
      : '';
  const bubbles =
    p.declared || suitBubble
      ? `<div class="bubbles">${p.declared ? '<div class="bubble">Last Cards!</div>' : ''}${suitBubble}</div>`
      : '';
  return `<div class="seat ${cls} ${isActor ? 'active-turn' : ''} ${p.out ? 'out' : ''}" data-seat="${p.idx}">
    ${bubbles}
    <div class="sname">${escapeHtml(p.name)}${p.isYou ? ' (you)' : ''}${p.isCPU ? '' : ''}</div>
    <div class="scount">${
      p.out
        ? `<span>${p.place ? ordinal(p.place) + ' place' : 'Out'}</span>`
        : p.isYou
          ? `<span class="mini-back"></span><span>× ${p.cardCount}</span>`
          : `${oppFanHtml(p.cardCount, vertical)}${p.isCPU ? '' : p.connected ? '' : '<span> (away)</span>'}`
    }</div>
  </div>`;
}

function ordinal(n) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[n] || `${n}th`;
}

/* Direction of play, drawn on the felt: one curved arrow in each open
   quadrant between the seats, arcing the way play travels around the
   table. Each path lives in a 56×56 box and bulges toward its
   quadrant's outer corner; the arrowhead sits at the end play flows
   toward, so reversing direction just swaps every arrow for its
   mirror journey. Clockwise flow runs bottom → left → top → right
   (through the quadrants: BL ↗, TL →, TR ↓, BR ←). No text label. */
const DIR_PATHS = {
  qtl: { cw: 'M 12 44 Q 12 12 44 12', ccw: 'M 44 12 Q 12 12 12 44' },
  qtr: { cw: 'M 12 12 Q 44 12 44 44', ccw: 'M 44 44 Q 44 12 12 12' },
  qbr: { cw: 'M 44 12 Q 44 44 12 44', ccw: 'M 12 44 Q 44 44 44 12' },
  qbl: { cw: 'M 44 44 Q 12 44 12 12', ccw: 'M 12 12 Q 12 44 44 44' },
};
function dirArrowsHtml(direction) {
  const key = direction === 1 ? 'cw' : 'ccw';
  const defs =
    '<svg width="0" height="0" style="position:absolute"><defs>' +
    '<marker id="dirHead" viewBox="0 0 10 10" refX="7.5" refY="5" markerWidth="5" markerHeight="5" orient="auto">' +
    '<path d="M 0 2 L 10 5 L 0 8 z" fill="rgba(216,179,106,0.5)"></path></marker></defs></svg>';
  const arrows = Object.keys(DIR_PATHS)
    .map(
      (q) =>
        `<div class="dir-arrow ${q}"><svg viewBox="0 0 56 56" width="56" height="56"><path d="${DIR_PATHS[q][key]}" fill="none" stroke="rgba(216,179,106,0.34)" stroke-width="3.5" stroke-linecap="round" marker-end="url(#dirHead)"></path></svg></div>`
    )
    .join('');
  return defs + arrows;
}

/* The contextual guidance text (chain / bring-back instructions).
   It used to sit on screen as a red box every turn; now it stays
   hidden until the player asks for it with the hint button beside
   the turn pill, and it disappears again once the turn has been
   played or after 10 seconds, whichever comes first. */
function guidanceText(view) {
  if (view.phase === 'bringback' && view.bringBack) {
    const fin = view.players[view.bringBack.finisherIdx].name;
    const actor = view.players[view.bringBack.actorIdx].name;
    return `${fin} is out — unless a pick up chain reaches them. ${actor} to act${
      view.bringBack.total ? ` (chain at ${view.bringBack.total})` : ''
    }.`;
  }
  if (view.chain && view.phase === 'playing') {
    return `Pick up ${view.pending} pending — play a 2 or black Jack to add to it, a red Jack to cancel, or pick up ${view.pending}.`;
  }
  return '';
}

/* A fingerprint of "where the game is": if it changes, the turn the
   guidance was shown for has been played (a play, a pick up, a skip
   or reversal moving the turn on, the phase moving on). */
function turnStamp(view) {
  return [
    view.phase,
    view.currentIdx,
    view.direction,
    view.lastPlay ? view.lastPlay.seq : 0,
    view.lastPickup ? view.lastPickup.seq : 0,
  ].join('|');
}

function showHint() {
  if (!state || state.screen !== 'game' || !guidanceText(state)) return;
  hintVisible = true;
  hintStamp = turnStamp(state);
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintVisible = false;
    hintTimer = null;
    render();
  }, 10000);
  render();
}

function hideHint() {
  hintVisible = false;
  hintStamp = null;
  if (hintTimer) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
}

function renderGame() {
  const view = state;
  const me = view.players[view.yourIdx];
  const ctx = myTurnContext();
  const check = validateSelection();
  const selCards = selected.map((id) => view.yourHand.find((c) => c.id === id)).filter(Boolean);

  const seats = view.players.map((p) => seatEl(view, p)).join('');
  const fan = displayedTop.map((c) => cardEl(c)).join('');

  const guidance = guidanceText(view);
  const banner = hintVisible && guidance ? `<div class="banner">${guidance}</div>` : '';

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

  syncHandOrder(view.yourHand);
  const byId = new Map(view.yourHand.map((c) => [c.id, c]));
  const orderedHand = handOrder.map((id) => byId.get(id)).filter(Boolean);
  // The fan holds only the cards that are NOT selected; selected cards
  // live in the row beneath it, in play order.
  const handHtml = orderedHand
    .filter((c) => !selected.includes(c.id))
    .map((c) => {
      const playable = selected.length === 0 ? isCardPlayableFirst(c) : false;
      return `<div class="card ${isRed(c) ? 'red' : 'black'} ${
        selected.length === 0 && ctx !== 'none' ? (playable ? 'legal' : 'unplayable') : ''
      }" data-card="${c.id}">
        <span class="corner"><span class="crank">${c.rank}</span><span class="csuit">${SYM[c.suit]}</span></span>
        <span class="rank">${c.rank}</span><span class="suit">${SYM[c.suit]}</span>
        ${powerTag(c) ? `<span class="ptag">${powerTag(c)}</span>` : ''}
      </div>`;
    })
    .join('');
  const selHtml = selCards
    .map(
      (c, i) => `<div class="card ${isRed(c) ? 'red' : 'black'} selected" data-selcard="${c.id}">
        <span class="order-badge">${i + 1}</span>
        <span class="corner"><span class="crank">${c.rank}</span><span class="csuit">${SYM[c.suit]}</span></span>
        <span class="rank">${c.rank}</span><span class="suit">${SYM[c.suit]}</span>
        ${powerTag(c) ? `<span class="ptag">${powerTag(c)}</span>` : ''}
      </div>`
    )
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
    <div class="game-head">
      <h1>Blackjack</h1>
      <button class="exit-btn" id="leave" type="button" aria-label="Leave room" title="Leave room"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#d8b36a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>
    </div>
    <div class="table" id="table">
      ${seats}
      <div class="centre">
        <div class="pile"><div class="draw-back"></div><div class="label">× ${view.drawCount}</div></div>
        <div class="pile"><div class="fan" id="fan">${fan}</div></div>
      </div>
      <button class="declare-btn${me && me.declared ? ' called' : ''}" id="declare" ${view.canDeclare ? '' : 'disabled'}>Last Cards!</button>
      <div class="dir-arrows" aria-hidden="true">${dirArrowsHtml(view.direction)}</div>
    </div>
    <div class="meta-row">
      <span class="chip turn">${turnName}</span>
      <button class="hint-btn${hintVisible ? ' active' : ''}" id="hintbtn" type="button" aria-label="Show hint" title="Hint" ${guidance ? '' : 'disabled'}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg></button>
    </div>
    ${banner}
    <div class="handzone" id="handzone">
      <div class="hand" id="hand">${handHtml}</div>
      <div class="selrow${selected.length ? '' : ' empty'}" id="selrow">${selHtml}</div>
    </div>
    <div class="hint ${check.ok ? 'ok' : 'err'}" id="hint">${
      selected.length
        ? check.msg || `Playing: ${selCards.map((c) => `${c.rank}${SYM[c.suit]}`).join(' → ')}`
        : me && me.declared
          ? 'You have called last cards.'
          : ''
    }</div>
    <div class="controls">
      <button class="warn" id="pickup" ${ctx !== 'none' ? '' : 'disabled'}>${pickupLabel}</button>
      <button class="primary" id="play" ${check.ok ? '' : 'disabled'}>Play${selected.length ? ` (${selected.length})` : ''}</button>
      <button class="ghost" id="clear" ${selected.length ? '' : 'disabled'}>Clear</button>
    </div>
    <div class="log" id="log">${view.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>
    ${overHtml}
    <div id="suit-modal"></div>`;

  // wire up
  document.querySelectorAll('#hand .card').forEach((el) => {
    el.addEventListener('pointerdown', onHandPointerDown);
  });
  document.querySelectorAll('#selrow .card').forEach((el) => {
    el.addEventListener('pointerdown', onSelPointerDown);
  });
  positionHand();
  positionSelRow();
  const hintBtn = document.getElementById('hintbtn');
  if (hintBtn)
    hintBtn.onclick = () => {
      if (hintVisible) {
        hideHint();
        render();
      } else {
        showHint();
      }
    };
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

/* Selecting never checks legality: any card can be tapped into the
   selected row in any order, and the row can be rearranged freely.
   The server remains the authority — it validates the whole sequence
   when Play is pressed and rejects an illegal one. */
function selectCard(id) {
  if (!selected.includes(id)) selected.push(id);
  render();
}

function deselectCard(id) {
  const i = selected.indexOf(id);
  if (i >= 0) selected.splice(i, 1);
  render();
}

// ------------------------------------------------------------- hand fan & drag reorder

/* Keep handOrder in step with the server's hand: cards no longer held
   drop out (relative order of the rest is preserved), cards newly held
   append at the end in server order. */
function syncHandOrder(hand) {
  const held = new Set(hand.map((c) => c.id));
  handOrder = handOrder.filter((id) => held.has(id));
  const known = new Set(handOrder);
  for (const c of hand) {
    if (!known.has(c.id)) handOrder.push(c.id);
  }
}

/* The fan shows only unselected cards; handOrder remains the master
   display order for the whole hand (selected cards keep their slots
   in it, so a card sent back from the selected row lands where it
   was). */
function fanOrder() {
  return handOrder.filter((id) => !selected.includes(id));
}

/* Card size steps down as the hand grows, so a big hand still fits
   the screen: full size up to 12 cards, then progressively smaller.
   The sizes are applied as CSS variables on the hand zone (fan +
   selected row), so corner indices shrink with the cards but stay
   legible. */
function handTier(total) {
  if (total <= 12) return { w: 54, h: 76, cidx: 13, main: 21, suit: 19 };
  if (total <= 18) return { w: 48, h: 68, cidx: 12, main: 19, suit: 17 };
  if (total <= 24) return { w: 42, h: 60, cidx: 11, main: 17, suit: 15 };
  return { w: 36, h: 52, cidx: 10, main: 15, suit: 13 };
}

function applyHandTier() {
  const total = state && state.yourHand ? state.yourHand.length : 0;
  const T = handTier(total);
  const zone = document.getElementById('handzone');
  if (zone) {
    zone.style.setProperty('--card-w', `${T.w}px`);
    zone.style.setProperty('--card-h', `${T.h}px`);
    zone.style.setProperty('--cidx', `${T.cidx}px`);
    zone.style.setProperty('--hmain', `${T.main}px`);
    zone.style.setProperty('--hsuit', `${T.suit}px`);
  }
  return T;
}

/* Fan geometry for n cards in a strip `availW` wide with cards `cardW`
   wide. The step is derived from the actual strip width, so the fan
   (cardW + (n−1) × step) can never exceed the strip: at ~59% overlap
   for a normal hand, tightening as the hand grows. Edge cards rotate
   a few degrees each around a pivot below the card and droop along a
   shallow arc. */
function handLayout(n, cardW, availW) {
  let step = 0;
  if (n > 1) step = Math.min(22, Math.max(4, (availW - cardW) / (n - 1)));
  const perDeg = n > 1 ? Math.min(4.2, 46 / (n - 1)) : 0;
  return { step, perDeg };
}

function cardPos(i, n, L) {
  const mid = (n - 1) / 2;
  const off = i - mid;
  const droop = mid > 0 ? 12 * Math.pow(Math.abs(off) / mid, 2) : 0;
  return { x: off * L.step, rot: off * L.perDeg, droop };
}

function previewFanOrder() {
  const arr = fanOrder().filter((id) => id !== drag.id);
  arr.splice(drag.targetIdx, 0, drag.id);
  return arr;
}

/* Fold a reordered fan back into handOrder: the unselected slots are
   refilled in the new fan order; selected cards keep their slots. */
function commitFanOrder(newFan) {
  const sel = new Set(selected);
  let fi = 0;
  handOrder = handOrder.map((id) => (sel.has(id) ? id : newFan[fi++]));
}

/* Lay out the fanned hand. Cards are absolutely positioned in the .hand
   strip; this sets each card's transform/z-index from the fan order
   (or the drag preview order mid-drag). Z-index is strictly the fan
   position, left to right, like a real fanned hand — a playable card
   no longer jumps a layer band above its neighbours (that covering
   made runs hard to plan). The dragged card follows the pointer. */
function positionHand() {
  const handEl = document.getElementById('hand');
  if (!handEl || !state || state.screen !== 'game') return;
  const T = applyHandTier();
  const order = drag && drag.moved ? previewFanOrder() : fanOrder();
  const n = order.length;
  if (!n) return;
  const L = handLayout(n, T.w, handEl.clientWidth || 320);
  handEl.querySelectorAll('.card').forEach((el) => {
    const id = el.dataset.card;
    const i = order.indexOf(id);
    if (i < 0) return;
    const p = cardPos(i, n, L);
    let transform = `translate(${p.x}px, ${p.droop}px) rotate(${p.rot}deg)`;
    let z = i + 1;
    if (drag && drag.moved && drag.el === el) {
      const p0 = cardPos(drag.origIdx, n, L);
      transform = `translate(${p0.x + drag.lastDx}px, ${p0.droop - 10}px) rotate(${p.rot * 0.3}deg)`;
      z = 300;
    }
    el.style.transform = transform;
    el.style.zIndex = z;
  });
}

function onHandPointerDown(e) {
  if (drag) return;
  const el = e.currentTarget;
  const fan = fanOrder();
  const idx = fan.indexOf(el.dataset.card);
  if (idx < 0) return;
  const handEl = document.getElementById('hand');
  const T = handTier(state && state.yourHand ? state.yourHand.length : fan.length);
  const L = handLayout(fan.length, T.w, handEl ? handEl.clientWidth || 320 : 320);
  drag = {
    id: el.dataset.card,
    el,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastDx: 0,
    origIdx: idx,
    step: L.step,
    n: fan.length,
    moved: false,
    targetIdx: idx,
  };
  try {
    el.setPointerCapture(e.pointerId);
  } catch {}
  el.addEventListener('pointermove', onHandPointerMove);
  el.addEventListener('pointerup', onHandPointerUp);
  el.addEventListener('pointercancel', onHandPointerCancel);
}

function onHandPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  drag.lastDx = dx;
  if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    drag.moved = true;
    drag.el.classList.add('dragging');
  }
  if (drag.moved) {
    e.preventDefault();
    const t = Math.round(drag.origIdx + dx / drag.step);
    drag.targetIdx = Math.max(0, Math.min(drag.n - 1, t));
    positionHand(); // other cards slide to open the gap at targetIdx
  }
}

function endDrag(commit) {
  const d = drag;
  if (!d) return null;
  d.el.removeEventListener('pointermove', onHandPointerMove);
  d.el.removeEventListener('pointerup', onHandPointerUp);
  d.el.removeEventListener('pointercancel', onHandPointerCancel);
  const preview = commit && d.moved ? previewFanOrder() : null;
  drag = null;
  if (preview) {
    commitFanOrder(preview);
    renderQueued = false;
    render(); // settles the card into its new slot
  } else if (renderQueued) {
    renderQueued = false;
    render();
  } else if (d.moved) {
    positionHand(); // cancelled drag: slide everything back
  }
  return d;
}

function onHandPointerUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const wasDrag = drag.moved;
  const d = endDrag(true);
  if (d && !wasDrag) selectCard(d.id); // a tap: press without real movement — into the selected row
}

function onHandPointerCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  endDrag(false);
}

// ------------------------------------------------------------- selected row

/* The selected row overlaps the bottom of the fan (CSS negative
   margin): the cards about to be played, left to right in play
   order, numbered by their order badges. Tap a
   row card to send it back to the hand; drag it sideways to slot it
   between its neighbours — order is fixed by rearranging here, never
   by having to tap cards in sequence. Same Pointer Events pattern as
   the hand drag. */
function selRowStep(n, cardW, availW) {
  if (n <= 1) return 0;
  return Math.min(cardW * 0.78, Math.max(10, (availW - cardW) / (n - 1)));
}

function previewSelOrder() {
  const arr = selected.filter((id) => id !== selDrag.id);
  arr.splice(selDrag.targetIdx, 0, selDrag.id);
  return arr;
}

function positionSelRow() {
  const rowEl = document.getElementById('selrow');
  if (!rowEl || !state || state.screen !== 'game') return;
  const T = handTier(state.yourHand ? state.yourHand.length : selected.length);
  const order = selDrag && selDrag.moved ? previewSelOrder() : selected;
  const n = order.length;
  if (!n) return;
  const step = selRowStep(n, T.w, rowEl.clientWidth || 320);
  rowEl.querySelectorAll('.card').forEach((el) => {
    const id = el.dataset.selcard;
    const i = order.indexOf(id);
    if (i < 0) return;
    const off = i - (n - 1) / 2;
    let transform = `translate(${off * step}px, 0px)`;
    let z = i + 1;
    if (selDrag && selDrag.moved && selDrag.el === el) {
      const o0 = selDrag.origIdx - (n - 1) / 2;
      transform = `translate(${o0 * step + selDrag.lastDx}px, -6px)`;
      z = 300;
    }
    el.style.transform = transform;
    el.style.zIndex = z;
  });
}

function onSelPointerDown(e) {
  if (selDrag) return;
  const el = e.currentTarget;
  const idx = selected.indexOf(el.dataset.selcard);
  if (idx < 0) return;
  const rowEl = document.getElementById('selrow');
  const T = handTier(state && state.yourHand ? state.yourHand.length : selected.length);
  const step = selRowStep(selected.length, T.w, rowEl ? rowEl.clientWidth || 320 : 320) || T.w;
  selDrag = {
    id: el.dataset.selcard,
    el,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastDx: 0,
    origIdx: idx,
    step,
    n: selected.length,
    moved: false,
    targetIdx: idx,
  };
  try {
    el.setPointerCapture(e.pointerId);
  } catch {}
  el.addEventListener('pointermove', onSelPointerMove);
  el.addEventListener('pointerup', onSelPointerUp);
  el.addEventListener('pointercancel', onSelPointerCancel);
}

function onSelPointerMove(e) {
  if (!selDrag || e.pointerId !== selDrag.pointerId) return;
  const dx = e.clientX - selDrag.startX;
  const dy = e.clientY - selDrag.startY;
  selDrag.lastDx = dx;
  if (!selDrag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    selDrag.moved = true;
    selDrag.el.classList.add('dragging');
  }
  if (selDrag.moved) {
    e.preventDefault();
    const t = Math.round(selDrag.origIdx + dx / selDrag.step);
    selDrag.targetIdx = Math.max(0, Math.min(selDrag.n - 1, t));
    positionSelRow(); // the other row cards slide to open the gap
  }
}

function endSelDrag(commit) {
  const d = selDrag;
  if (!d) return null;
  d.el.removeEventListener('pointermove', onSelPointerMove);
  d.el.removeEventListener('pointerup', onSelPointerUp);
  d.el.removeEventListener('pointercancel', onSelPointerCancel);
  const preview = commit && d.moved ? previewSelOrder() : null;
  selDrag = null;
  if (preview) {
    selected = preview;
    renderQueued = false;
    render(); // settles the card into its new position in the row
  } else if (renderQueued) {
    renderQueued = false;
    render();
  } else if (d.moved) {
    positionSelRow(); // cancelled drag: slide everything back
  }
  return d;
}

function onSelPointerUp(e) {
  if (!selDrag || e.pointerId !== selDrag.pointerId) return;
  const wasDrag = selDrag.moved;
  const d = endSelDrag(true);
  if (d && !wasDrag) deselectCard(d.id); // a tap sends the card back to the hand
}

function onSelPointerCancel(e) {
  if (!selDrag || e.pointerId !== selDrag.pointerId) return;
  endSelDrag(false);
}

window.addEventListener('resize', () => {
  positionHand();
  positionSelRow();
});

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
      (s) => `<button data-suit="${s}" style="color:${s === 'hearts' || s === 'diamonds' ? '#ff6a52' : '#2f353c'}">${SYM[s]}</button>`
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
  hideHint(); // stop the auto-hide timer; there is no turn any more
  state = null;
  selected = [];
  selDrag = null;
  renderedSeq = 0;
  renderedPickupSeq = 0;
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
    // Transform-only flight on a soft ease, with a small upward lift at
    // mid-flight so the card arcs onto the pile rather than sliding.
    inner.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        {
          transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 24}px) rotate(${((i % 3) - 1) * 0.6}deg)`,
          opacity: 1,
          offset: 0.55,
        },
        { transform: `translate(${dx}px, ${dy}px) rotate(${(i % 3) - 1}deg)`, opacity: 1 },
      ],
      { duration: 500, delay: i * 320, easing: 'cubic-bezier(.22,.9,.28,1)', fill: 'forwards' }
    );
    setTimeout(() => inner.remove(), i * 320 + 560);
  });
}

/* The reverse flight for pick ups: card-backs fly from the draw pile
   to the seat of the player who picked up — or, for the local player,
   down toward their hand. Capped at 5 backs however many were drawn;
   same WAAPI style as animatePlay, a slightly quicker stagger. */
function animatePickup(pu) {
  const table = document.getElementById('table');
  if (!table || !pu) return;
  const drawEl = table.querySelector('.draw-back');
  if (!drawEl) return;
  let targetEl = null;
  if (state && pu.playerIdx === state.yourIdx) {
    targetEl = document.getElementById('hand') || table;
  } else {
    targetEl = table.querySelector(`[data-seat="${pu.playerIdx}"]`) || table;
  }
  const from = drawEl.getBoundingClientRect();
  const to = targetEl.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const n = Math.max(0, Math.min(pu.count || 0, 5));
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'draw-back fly-card';
    el.style.left = `${from.left}px`;
    el.style.top = `${from.top}px`;
    el.style.margin = '0';
    document.body.appendChild(el);
    el.animate(
      [
        { transform: 'translate(0,0)', opacity: 1 },
        { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 24}px)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
      ],
      { duration: 480, delay: i * 140, easing: 'cubic-bezier(.22,.9,.28,1)', fill: 'forwards' }
    );
    setTimeout(() => el.remove(), i * 140 + 540);
  }
}

// ------------------------------------------------------------- main render

function render() {
  // Rebuilding the DOM mid-drag would destroy the card under the
  // pointer — defer until the drag ends (endDrag/endSelDrag flush this).
  if (drag || selDrag) {
    renderQueued = true;
    return;
  }
  if (!state) return renderHome();
  if (state.screen === 'lobby') return renderLobby();
  return renderGame();
}

socket.on('state', (s) => {
  const prevScreen = state && state.screen;
  state = s;
  // A shown hint belongs to the turn it was asked for: as soon as a
  // play or pick up lands (the turn stamp moves on), or the guidance
  // no longer applies, the box hides — the 10s timer is the backstop.
  if (hintVisible && (s.screen !== 'game' || !guidanceText(s) || turnStamp(s) !== hintStamp)) hideHint();
  if (s.screen === 'game') {
    // Keep only still-valid selections.
    if (selected.length) {
      const handIds = new Set(s.yourHand.map((c) => c.id));
      selected = selected.filter((id) => handIds.has(id));
      if (myTurnContext() === 'none') selected = [];
    }
    if (prevScreen !== 'game') {
      // Arriving on the game screen (start, join, reclaim): sync the
      // animation seqs to whatever already happened — never replay
      // stale play/pickup flights.
      displayedTop = s.topCards;
      renderedSeq = s.lastPlay ? s.lastPlay.seq : 0;
      renderedPickupSeq = s.lastPickup ? s.lastPickup.seq : 0;
      render();
      return;
    }
    const lp = s.lastPlay && s.lastPlay.seq > renderedSeq ? s.lastPlay : null;
    const pu = s.lastPickup && s.lastPickup.seq > renderedPickupSeq ? s.lastPickup : null;
    if (lp) renderedSeq = lp.seq;
    if (pu) renderedPickupSeq = pu.seq;
    if (lp) {
      render(); // render everything (hand, counts, log) first…
      animatePlay(lp); // …cards fly from the seat…
      // A penalty pick up can ride along with the same action (illegal
      // finish / no-call finish): fly those backs too.
      if (pu) animatePickup(pu);
      const total = (lp.cards.length - 1) * 320 + 540; // last card lands at (n-1)*320 + 500
      if (fanTimer) clearTimeout(fanTimer);
      fanTimer = setTimeout(() => {
        displayedTop = state.topCards; // …and only then appear in the fan
        const fan = document.getElementById('fan');
        if (fan && state.screen === 'game') fan.innerHTML = displayedTop.map((c) => cardEl(c)).join('');
      }, total);
      return;
    }
    displayedTop = s.topCards;
    render();
    if (pu) animatePickup(pu);
    return;
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
