'use strict';

// Authoritative rules engine for British "Blackjack" (the Crazy 8s-style
// shedding game, NOT casino blackjack). Pure state machine: no sockets,
// no timers. The server wraps this; the AI and the tests drive it too.
//
// Rules implemented (the user's house rules, as corrected across the
// solo-game builds):
//  - 7 cards each; match suit or rank on the top card; playing is never
//    forced (pick up 1 instead, turn ends). Any pick up ends the turn.
//  - 2 = pick up 2, black Jack = pick up 5; they stack into a pending
//    chain. During a chain only 2s / black Jacks (add) or red Jacks
//    (cancel the whole chain) can be played; suit is irrelevant.
//  - Red Jack cancels the entire pending pick up. One or more red Jacks
//    played together still cancel.
//  - 8 skips the next player (stackable), King reverses direction
//    (two Kings cancel out), Ace played as the first card of a turn goes
//    on anything and names the next suit.
//  - Queen must always be covered: anything can be played on a Queen,
//    but a play can never END on a Queen.
//  - Runs: several cards in one turn, each next card links from the
//    previous one by same rank, or same suit + consecutive rank. Only
//    the final card's power takes effect (plus stacked same-rank power
//    cards at the end of the play). An Ace inside a run must follow the
//    run rules (same suit and consecutive, wrapping K-A-2); a mid-run
//    Ace's power is ignored. A suit is declared only when an Ace is the
//    only card played or the final card of a run.
//  - "Last cards" can be called at any time before your next turn —
//    and never during your own turn — once your hand could be shed in
//    one internally legal play. Eligibility is judged on the hand
//    alone, since the pile may change before your turn comes round. A call covers only that one
//    next turn: if the turn ends without you going out (you played but
//    didn't finish, picked up voluntarily, or were made to pick up),
//    the call resets and may be made again later in the game. Going out
//    without an active call = pick up 1 and stay in.
//  - A red Jack is the ONLY power card you can legally finish on.
//    Finishing on an Ace, 2, black Jack, 8 or King = pick up 1, stay in.
//  - Bring-backs: when a player goes out, if every remaining player in
//    turn order consecutively adds pick up cards (2s / black Jacks)
//    with no gap, the chain "reaches" the finisher: they come back in
//    and pick up the total. A red Jack cancels the attempt; a player who
//    can't (or won't, before the chain has started) breaks it.
//  - Play continues until one player is left holding cards; placements
//    are 1st, 2nd, 3rd, last.

const {
  SUITS,
  buildDeck,
  shuffle,
  rankValue,
  isBlackJack,
  isRedJack,
  cardStr,
} = require('./cards');

const HAND_SIZE = 7;

// ---------------------------------------------------------------- state

function createGame(seats, startSeat) {
  // seats: [{ key, name, isCPU }] in seat order. key identifies the human
  // connection (socket id) or is null for CPU seats.
  const deck = shuffle(buildDeck());
  const players = seats.map((s) => ({
    key: s.key || null,
    name: s.name,
    isCPU: !!s.isCPU,
    // Server-only: the reclaim token of the human this seat belongs to
    // while a CPU is minding it (null for connected humans and pure CPU
    // fill seats). Never exposed by buildView.
    humanToken: s.humanToken || null,
    hand: [],
    out: false,
    place: null,
    declared: false,
  }));
  for (let r = 0; r < HAND_SIZE; r++) {
    for (const p of players) p.hand.push(deck.pop());
  }
  const startCard = deck.pop();
  const state = {
    players,
    deck,
    discard: [startCard],
    direction: 1,
    current: startSeat % players.length,
    pending: 0,
    chain: false,
    requiredSuit: null,
    suitDeclarer: null, // seat index that named requiredSuit (null when none in force)
    phase: 'playing', // 'playing' | 'bringback' | 'over'
    bringBack: null, // { finisher, total, actor, contributors }
    placements: [], // player indices in finishing order
    log: [`Game started. ${cardStr(startCard)} is flipped to start.`],
    playSeq: 0,
    lastPlay: null, // { seq, playerIdx, cards }
    pickupSeq: 0,
    lastPickup: null, // { seq, playerIdx, count } — public (counts are public)
  };
  // The flipped card's power applies immediately.
  if (startCard.rank === 'K') {
    state.direction = -1;
    state.log.push('Flipped King — direction starts reversed.');
  }
  if (startCard.rank === '2') {
    state.pending = 2;
    state.chain = true;
    state.log.push('Flipped 2 — pick up 2 is pending.');
  }
  if (isBlackJack(startCard)) {
    state.pending = 5;
    state.chain = true;
    state.log.push('Flipped black Jack — pick up 5 is pending.');
  }
  if (startCard.rank === '8') {
    state.log.push(`${players[state.current].name} is skipped by the flipped 8.`);
    advance(state, 1);
  }
  return state;
}

// ---------------------------------------------------------------- helpers

function topCard(state) {
  return state.discard[state.discard.length - 1];
}

function activeIndices(state) {
  const out = [];
  state.players.forEach((p, i) => {
    if (!p.out) out.push(i);
  });
  return out;
}

function nextActiveFrom(state, fromIdx) {
  const n = state.players.length;
  let i = fromIdx;
  do {
    i = (i + state.direction + n) % n;
  } while (state.players[i].out);
  return i;
}

function advance(state, steps) {
  let idx = state.current;
  for (let s = 0; s < steps; s++) idx = nextActiveFrom(state, idx);
  state.current = idx;
}

function ranksAdjacent(a, b) {
  const va = rankValue(a);
  const vb = rankValue(b);
  if (Math.abs(va - vb) === 1) return true;
  // Ace wraps: A next to 2.
  if ((a === 'A' && b === '2') || (a === '2' && b === 'A')) return true;
  return false;
}

// Can `next` be played on `prev` inside a run?
function linksTo(prev, next) {
  if (prev.rank === 'Q') return true; // anything can cover a Queen
  if (prev.rank === next.rank) return true; // same-rank link
  if (prev.suit !== next.suit) return false;
  return ranksAdjacent(prev.rank, next.rank);
}

// Is `card` a legal FIRST card of a play for the current top state?
// (Chain responses are validated separately.)
function firstCardLegal(state, card) {
  const top = topCard(state);
  if (top.rank === 'Q') return true; // a Queen on top (the flipped card) can be covered by anything
  if (state.requiredSuit) {
    return card.suit === state.requiredSuit || card.rank === 'A';
  }
  if (card.rank === 'A') return true; // an Ace as first card goes on anything
  return card.suit === top.suit || card.rank === top.rank;
}

function isLegalFinishCard(card) {
  // A red Jack is the only power card you can legally finish on.
  if (isRedJack(card)) return true;
  if (card.rank === 'A' || card.rank === '2' || card.rank === '8' || card.rank === 'K' || card.rank === 'Q') return false;
  if (isBlackJack(card)) return false;
  return true;
}

function drawCards(state, idx, n) {
  const p = state.players[idx];
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      if (state.discard.length > 1) {
        const top = state.discard.pop();
        state.deck = shuffle(state.discard);
        state.discard = [top];
      } else {
        break; // nothing left anywhere to draw
      }
    }
    p.hand.push(state.deck.pop());
    drawn++;
  }
  if (drawn > 0) p.declared = false; // no longer on last cards once the hand grows
  return drawn;
}

function pushLog(state, line) {
  state.log.push(line);
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

function recordPlay(state, idx, cards) {
  state.playSeq += 1;
  state.lastPlay = {
    seq: state.playSeq,
    playerIdx: idx,
    cards: cards.map((c) => ({ id: c.id, suit: c.suit, rank: c.rank })),
  };
}

// Mirror of recordPlay for pick ups, so clients can animate cards
// flying from the draw pile to the player who picked up. Call with the
// number ACTUALLY drawn (drawCards' return value, so reshuffles and
// the nothing-left edge are handled); zero draws record nothing.
function recordPickup(state, idx, drawn) {
  if (!drawn || drawn <= 0) return;
  state.pickupSeq += 1;
  state.lastPickup = { seq: state.pickupSeq, playerIdx: idx, count: drawn };
}

function ordinal(n) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[n] || `${n}th`;
}

// ------------------------------------------------------- last cards call

// Could this player shed their whole hand in one internally legal play?
// Declare eligibility (Anisah's ruling): the hand ALONE is judged —
// some ordering of it where consecutive cards link by the run rules,
// every Queen is covered within the play, and the final card is a legal
// finish card. The current top card, any named/required suit and any
// pending pick up chain are deliberately ignored: other players may
// discard something that makes the run playable before the caller's
// next turn. This is NOT a play-legality check — validatePlay still
// requires a legal first card on the then-current top card, and
// nothing in play execution or the AI's play choice consults this.
// (DFS over play sequences; bounded to hands of 8 or fewer.)
function canShedAll(state, idx) {
  const hand = state.players[idx].hand;
  if (hand.length < 2 || hand.length > 8) return false;
  const used = new Array(hand.length).fill(false);
  function dfs(lastCard, count) {
    if (count === hand.length) return isLegalFinishCard(lastCard);
    for (let i = 0; i < hand.length; i++) {
      if (used[i]) continue;
      const c = hand[i];
      if (count > 0 && !linksTo(lastCard, c)) continue;
      if (c.rank === 'Q' && count === hand.length - 1) continue; // a Queen must be covered within the play
      used[i] = true;
      if (dfs(c, count + 1)) return true;
      used[i] = false;
    }
    return false;
  }
  return dfs(null, 0);
}

function canDeclare(state, idx) {
  const p = state.players[idx];
  if (!p || p.out || p.declared) return false;
  if (state.phase !== 'playing') return false;
  // Anisah's ruling (23 Oct 2026): "Last cards must be called before
  // your next turn" — calling during your own turn is not legal, even
  // moments before playing the hand. (She caught the game letting her
  // declare on her final turn and finish on that same turn.) The
  // server's CPU declare sweep goes through this function too, so a
  // CPU likewise never declares on its own turn.
  if (state.current === idx) return false;
  if (p.hand.length === 1) return true;
  return canShedAll(state, idx);
}

function applyDeclare(state, idx) {
  if (state.phase === 'playing' && state.current === idx) {
    return { ok: false, error: "Last cards must be called before your turn — you can't call it during your own turn." };
  }
  if (!canDeclare(state, idx)) {
    return { ok: false, error: 'You can only call last cards when you could finish on your next turn.' };
  }
  state.players[idx].declared = true;
  pushLog(state, `${state.players[idx].name}: "Last cards!"`);
  return { ok: true };
}

// ---------------------------------------------------------------- plays

function resolveCards(state, idx, cardIds) {
  const p = state.players[idx];
  if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: 'Select at least one card.' };
  if (new Set(cardIds).size !== cardIds.length) return { error: 'Duplicate cards in that play.' };
  const cards = [];
  for (const id of cardIds) {
    const c = p.hand.find((h) => h.id === id);
    if (!c) return { error: 'One of those cards is not in your hand.' };
    cards.push(c);
  }
  return { cards };
}

function validatePlay(state, idx, cardIds, declaredSuit) {
  if (state.phase === 'over') return 'The game is over.';
  if (state.phase === 'bringback') return validateBringBackPlay(state, idx, cardIds);
  if (idx !== state.current) return 'Not your turn.';
  const { cards, error } = resolveCards(state, idx, cardIds);
  if (error) return error;
  const first = cards[0];
  const final = cards[cards.length - 1];

  if (state.chain) {
    if (!cards.every((c) => c.rank === '2' || c.rank === 'J')) {
      return 'A pick up is pending — only a 2, a black Jack, or a red Jack to cancel can be played.';
    }
    if (cards.some(isRedJack) && !cards.every(isRedJack)) {
      return 'Red Jacks cancel on their own — play them without other cards.';
    }
    return null;
  }

  if (!firstCardLegal(state, first)) {
    if (state.requiredSuit) return `That can't open your play — the suit to follow is ${state.requiredSuit}, or play an Ace.`;
    return `That can't open your play on ${cardStr(topCard(state))} — match the suit or rank, or lead an Ace.`;
  }
  for (let i = 1; i < cards.length; i++) {
    if (!linksTo(cards[i - 1], cards[i])) {
      return 'In a run, each next card must link from the last: same rank, or same suit and consecutive (an Ace in a run must be same suit and consecutive, wrapping K-A-2; anything can cover a Queen).';
    }
  }
  if (final.rank === 'Q') return 'A Queen must be covered — a play can never end on a Queen.';
  // Note: a play that empties the hand on an illegal finish card (Ace,
  // 2, black Jack, 8, King) is NOT rejected here. Per Anisah's ruling
  // it lands, and applyPlay's going-out path deals the penalty: the
  // cards stay on the pile and the player picks up 1 and stays in.
  if (final.rank === 'A' && !SUITS.includes(declaredSuit)) return 'Choose a suit for the Ace to declare.';
  if (final.rank !== 'A' && declaredSuit) return null; // ignored harmlessly
  return null;
}

function applyPlay(state, idx, cardIds, declaredSuit) {
  const err = validatePlay(state, idx, cardIds, declaredSuit);
  if (err) return { ok: false, error: err };
  if (state.phase === 'bringback') return applyBringBackPlay(state, idx, cardIds);

  const p = state.players[idx];
  const { cards } = resolveCards(state, idx, cardIds);
  const ids = new Set(cardIds);
  p.hand = p.hand.filter((c) => !ids.has(c.id));
  state.discard.push(...cards);
  recordPlay(state, idx, cards);
  pushLog(state, `${p.name} played ${cards.map(cardStr).join(' → ')}.`);
  const final = cards[cards.length - 1];
  const wasChain = state.chain;

  // ---- going out?
  // An illegal finish (final card not a legal finish card) is not
  // rejected: the played cards stay on the pile and the player picks
  // up 1 and stays in — for declared and undeclared players alike. The
  // same penalty covers a finish on a legal card made without an
  // active "last cards" call.
  if (p.hand.length === 0 && (!isLegalFinishCard(final) || !p.declared)) {
    const reason = !isLegalFinishCard(final)
      ? `can't finish on ${cardStr(final)} — a red Jack is the only power card you can finish on`
      : 'forgot to call last cards';
    p.declared = false; // their turn has ended; any call is spent
    recordPickup(state, idx, drawCards(state, idx, 1));
    pushLog(state, `${p.name} ${reason} — picks up 1 and stays in.`);
    // Anisah's ruling (23 Oct 2026): "the power of the card played
    // should still stand". An illegal finish does NOT swallow the
    // final card's power, and a chain the player was answering is
    // consumed exactly as normal — so there is deliberately no return
    // here: play falls through to the ordinary end-of-turn effects
    // below, which pass a black Jack's +5 / a 2's +2 on to the next
    // player, apply an 8's skip or a King's reversal, and let an
    // Ace's named suit stand. (Before this ruling the +5 was dropped:
    // she finished Q♠ → J♣, drew her penalty card, and the next player
    // wrongly picked up only 1.) An uncovered Queen ending has no
    // power to pass on — validatePlay rejects those plays anyway.
    // A clean finish (legal final card + active call) is the only
    // way out, and it is handled just below.
  } else if (p.hand.length === 0) {
    // A clean finish.
    p.out = true;
    p.place = state.placements.length + 1;
    state.placements.push(idx);
    if (wasChain) {
      state.chain = false;
      state.pending = 0;
    }
    state.requiredSuit = null;
    state.suitDeclarer = null;
    pushLog(state, `${p.name} is out — ${ordinal(p.place)} place!`);
    const active = activeIndices(state);
    if (active.length === 1) {
      const lastIdx = active[0];
      state.players[lastIdx].place = state.placements.length + 1;
      state.placements.push(lastIdx);
      state.phase = 'over';
      pushLog(state, `${state.players[lastIdx].name} is left holding cards — ${ordinal(state.players[lastIdx].place)} place. Game over.`);
    } else {
      state.phase = 'bringback';
      state.bringBack = {
        finisher: idx,
        total: 0,
        actor: nextActiveFrom(state, idx),
        contributors: 0,
      };
      pushLog(state, `Can anyone bring ${p.name} back? ${state.players[state.bringBack.actor].name} to act.`);
    }
    return { ok: true };
  }

  // ---- end-of-turn reset for "last cards"
  // The player played but did not go out, and every path below advances
  // play to someone else: their turn is over, so a "last cards" call
  // (which covers only this one turn) resets and can be called again.
  p.declared = false;

  // ---- ordinary play effects
  if (wasChain) {
    // The chain answer lands on top of whatever was there (including a
    // suit-naming Ace): any named suit stops being in force.
    state.requiredSuit = null;
    state.suitDeclarer = null;
    if (cards.every(isRedJack)) {
      state.chain = false;
      state.pending = 0;
      pushLog(state, `Red Jack — the pick up is cancelled.`);
    } else {
      const add = cards.reduce((sum, c) => sum + (c.rank === '2' ? 2 : 5), 0);
      state.pending += add;
      pushLog(state, `Pick up grows — ${state.pending} now pending.`);
    }
    advance(state, 1);
    return { ok: true };
  }

  // Trailing group of same-rank cards (stacked power cards take effect together).
  let trailing = 1;
  for (let i = cards.length - 2; i >= 0 && cards[i].rank === final.rank; i--) trailing++;
  state.requiredSuit = null;
  state.suitDeclarer = null;

  if (final.rank === '2') {
    state.pending = 2 * trailing;
    state.chain = true;
    pushLog(state, `Pick up ${state.pending} pending.`);
    advance(state, 1);
  } else if (final.rank === 'J') {
    const group = cards.slice(cards.length - trailing);
    const blacks = group.filter(isBlackJack).length;
    const reds = group.filter(isRedJack).length;
    if (blacks > 0 && reds === 0) {
      state.pending = 5 * blacks;
      state.chain = true;
      pushLog(state, `Pick up ${state.pending} pending.`);
    }
    // red Jack(s) with no chain to cancel simply land on top.
    advance(state, 1);
  } else if (final.rank === '8') {
    const skipped = [];
    let probe = state.current;
    for (let s = 0; s < trailing; s++) {
      probe = nextActiveFrom(state, probe);
      skipped.push(state.players[probe].name);
    }
    pushLog(state, `${skipped.join(' and ')} ${trailing > 1 ? 'are' : 'is'} skipped.`);
    advance(state, 1 + trailing);
  } else if (final.rank === 'K') {
    if (trailing % 2 === 1) {
      state.direction *= -1;
      pushLog(state, `King played — direction is now ${state.direction === 1 ? 'clockwise' : 'counter-clockwise'}.`);
    } else {
      pushLog(state, `Two Kings — direction stays ${state.direction === 1 ? 'clockwise' : 'counter-clockwise'}.`);
    }
    advance(state, 1);
  } else if (final.rank === 'A') {
    state.requiredSuit = declaredSuit;
    state.suitDeclarer = idx;
    pushLog(state, `${p.name} named ${declaredSuit} to follow.`);
    advance(state, 1);
  } else {
    advance(state, 1);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- pick up

function applyPickup(state, idx) {
  if (state.phase === 'over') return { ok: false, error: 'The game is over.' };
  if (state.phase === 'bringback') return applyBringBackPickup(state, idx);
  if (idx !== state.current) return { ok: false, error: 'Not your turn.' };
  const p = state.players[idx];
  if (state.chain) {
    const n = state.pending;
    state.chain = false;
    state.pending = 0;
    recordPickup(state, idx, drawCards(state, idx, n));
    pushLog(state, `${p.name} picked up ${n}.`);
  } else {
    recordPickup(state, idx, drawCards(state, idx, 1));
    pushLog(state, `${p.name} picked up 1.`);
  }
  // Picking up ends the player's turn, so a "last cards" call covering
  // this turn resets (drawCards already clears it when cards are drawn;
  // this keeps the rule explicit and covers the nothing-to-draw edge).
  p.declared = false;
  advance(state, 1);
  return { ok: true };
}

// ------------------------------------------------------------- bring-back

function validateBringBackPlay(state, idx, cardIds) {
  const bb = state.bringBack;
  if (!bb || idx !== bb.actor) return 'Not your turn.';
  const { cards, error } = resolveCards(state, idx, cardIds);
  if (error) return error;
  if (cards.every(isRedJack)) return null;
  if (cards.every((c) => c.rank === '2' || isBlackJack(c))) return null;
  return 'Only pick up cards (2s and black Jacks) can bring a player back — or a red Jack to cancel.';
}

function applyBringBackPlay(state, idx, cardIds) {
  const err = validateBringBackPlay(state, idx, cardIds);
  if (err) return { ok: false, error: err };
  const bb = state.bringBack;
  const p = state.players[idx];
  const { cards } = resolveCards(state, idx, cardIds);
  const ids = new Set(cardIds);
  p.hand = p.hand.filter((c) => !ids.has(c.id));
  state.discard.push(...cards);
  recordPlay(state, idx, cards);
  const finisherName = state.players[bb.finisher].name;

  if (cards.every(isRedJack)) {
    pushLog(state, `${p.name} played ${cards.map(cardStr).join(' → ')} — red Jack cancels the bring-back. ${finisherName} stays out.`);
    state.phase = 'playing';
    state.bringBack = null;
    state.current = nextActiveFrom(state, idx);
    return { ok: true };
  }

  const add = cards.reduce((sum, c) => sum + (c.rank === '2' ? 2 : 5), 0);
  bb.total += add;
  bb.contributors += 1;
  pushLog(state, `${p.name} played ${cards.map(cardStr).join(' → ')} — bring-back chain at ${bb.total}.`);

  const activeCount = activeIndices(state).length;
  if (bb.contributors >= activeCount) {
    // The chain reached the finisher with no gaps: they are back in.
    const f = state.players[bb.finisher];
    f.out = false;
    f.place = null;
    state.placements.splice(state.placements.indexOf(bb.finisher), 1);
    const total = bb.total;
    state.phase = 'playing';
    state.bringBack = null;
    recordPickup(state, bb.finisher, drawCards(state, bb.finisher, total));
    pushLog(state, `${f.name} is brought back in and picks up ${total}!`);
    state.current = nextActiveFrom(state, bb.finisher);
    return { ok: true };
  }
  bb.actor = nextActiveFrom(state, idx);
  pushLog(state, `${state.players[bb.actor].name} to act on the bring-back.`);
  return { ok: true };
}

function applyBringBackPickup(state, idx) {
  const bb = state.bringBack;
  if (!bb || idx !== bb.actor) return { ok: false, error: 'Not your turn.' };
  const p = state.players[idx];
  const finisherName = state.players[bb.finisher].name;
  if (bb.total > 0) {
    const n = bb.total;
    recordPickup(state, idx, drawCards(state, idx, n));
    pushLog(state, `${p.name} can't add to the bring-back — picks up ${n}. ${finisherName} stays out.`);
    state.phase = 'playing';
    state.bringBack = null;
    state.current = nextActiveFrom(state, idx);
  } else {
    pushLog(state, `${p.name} doesn't bring ${finisherName} back.`);
    state.phase = 'playing';
    state.bringBack = null;
    state.current = idx; // the actor simply takes their normal turn now
  }
  return { ok: true };
}

// ------------------------------------------------------------------ views

// Personalised public view: the viewer sees their own hand in full; every
// other player is a card count only. CPU hands are never included.
function buildView(state, viewerIdx) {
  const topCards = state.discard.slice(-3).map((c) => ({ id: c.id, suit: c.suit, rank: c.rank }));
  return {
    screen: 'game',
    phase: state.phase,
    direction: state.direction,
    currentIdx: state.current,
    pending: state.pending,
    chain: state.chain,
    requiredSuit: state.requiredSuit,
    suitDeclarerIdx: state.requiredSuit ? state.suitDeclarer : null,
    drawCount: state.deck.length,
    topCards,
    lastPlay: state.lastPlay,
    lastPickup: state.lastPickup,
    log: state.log.slice(-40),
    bringBack: state.bringBack
      ? {
          finisherIdx: state.bringBack.finisher,
          actorIdx: state.bringBack.actor,
          total: state.bringBack.total,
        }
      : null,
    players: state.players.map((p, i) => ({
      idx: i,
      name: p.name,
      isCPU: p.isCPU,
      connected: !!p.key,
      cardCount: p.hand.length,
      out: p.out,
      place: p.place,
      declared: p.declared && !p.out,
      isYou: i === viewerIdx,
    })),
    yourIdx: viewerIdx,
    yourHand:
      viewerIdx >= 0
        ? state.players[viewerIdx].hand.map((c) => ({ id: c.id, suit: c.suit, rank: c.rank }))
        : [],
    canDeclare: viewerIdx >= 0 ? canDeclare(state, viewerIdx) : false,
    placements:
      state.phase === 'over'
        ? state.placements.map((pi) => ({ name: state.players[pi].name, place: state.players[pi].place }))
        : null,
  };
}

module.exports = {
  createGame,
  validatePlay,
  applyPlay,
  applyPickup,
  applyDeclare,
  canDeclare,
  canShedAll,
  buildView,
  firstCardLegal,
  linksTo,
  isLegalFinishCard,
  topCard,
  activeIndices,
  nextActiveFrom,
};
