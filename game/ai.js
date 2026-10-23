'use strict';

// Simple CPU players: legal, sensible, not clever. They play a legal card
// when they have one (preferring runs and power cards), answer pick up
// chains with a 2 / black Jack or cancel with a red Jack, declare the suit
// they hold most of when they play an Ace, and avoid finishing illegally
// (they call "last cards" via the server's declare sweep when eligible).

const { isBlackJack, isRedJack } = require('./cards');
const engine = require('./engine');

function mostCommonSuit(cards, fallback) {
  const counts = {};
  for (const c of cards) counts[c.suit] = (counts[c.suit] || 0) + 1;
  let best = fallback || 'hearts';
  let bestN = -1;
  for (const s of Object.keys(counts)) {
    if (counts[s] > bestN) {
      bestN = counts[s];
      best = s;
    }
  }
  return best;
}

function greedyRun(state, hand, startCard) {
  const seq = [startCard];
  const remaining = hand.filter((c) => c.id !== startCard.id);
  for (;;) {
    const last = seq[seq.length - 1];
    const options = remaining.filter((c) => engine.linksTo(last, c));
    if (options.length === 0) break;
    // Prefer stacking same-rank power cards, then any power card, then others.
    // Never end the run on a Queen (only take one if another card can follow it,
    // and anything can follow a Queen).
    const pick =
      options.find((c) => c.rank === last.rank && ['2', 'J', '8', 'K'].includes(c.rank)) ||
      options.find((c) => c.rank !== 'Q') ||
      (remaining.length >= 2 ? options[0] : null);
    if (!pick) break;
    seq.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return seq;
}

function scorePlay(state, player, seq) {
  const final = seq[seq.length - 1];
  const empties = seq.length === player.hand.length;
  if (empties) {
    if (!player.declared) return -1; // would be a penalty finish — don't
    if (!engine.isLegalFinishCard(final)) return -1;
    return 100 + seq.length;
  }
  const isPowerFinal =
    final.rank === '2' || isBlackJack(final) || final.rank === '8' || final.rank === 'K' || final.rank === 'A';
  if (isPowerFinal) return 50 + seq.length;
  if (seq.length >= 3) return 40 + seq.length;
  if (seq.length === 2) return 25;
  return 10;
}

function chooseAction(state, idx) {
  const player = state.players[idx];
  const hand = player.hand;

  // ---- bring-back window
  if (state.phase === 'bringback') {
    const bb = state.bringBack;
    if (!bb || bb.actor !== idx) return { type: 'pickup' };
    const reds = hand.filter(isRedJack);
    const adds = hand.filter((c) => c.rank === '2' || isBlackJack(c));
    if (bb.total > 0 && reds.length > 0) return { type: 'play', cardIds: [reds[0].id] };
    if (adds.length > 0) return { type: 'play', cardIds: [adds[0].id] };
    return { type: 'pickup' }; // pass (total 0) or swallow the total
  }

  if (state.phase !== 'playing' || state.current !== idx) return { type: 'pickup' };

  // ---- facing a pick up chain
  if (state.chain) {
    const reds = hand.filter(isRedJack);
    if (reds.length > 0) return { type: 'play', cardIds: [reds[0].id] };
    const bj = hand.find(isBlackJack);
    if (bj) return { type: 'play', cardIds: [bj.id] };
    const two = hand.find((c) => c.rank === '2');
    if (two) return { type: 'play', cardIds: [two.id] };
    return { type: 'pickup' };
  }

  // ---- normal turn: build candidate plays
  const firsts = hand.filter((c) => engine.firstCardLegal(state, c));
  let best = null;
  let bestScore = -1;
  for (const start of firsts) {
    const run = greedyRun(state, hand, start);
    if (run[run.length - 1].rank === 'Q') run.pop(); // never end on a Queen
    if (run.length === 0) continue;
    const s = scorePlay(state, player, run);
    if (s > bestScore) {
      bestScore = s;
      best = run;
    }
    // Also consider just the single card (sometimes better than a long plain run).
    if (start.rank !== 'Q') {
      const s1 = scorePlay(state, player, [start]);
      if (s1 > bestScore) {
        bestScore = s1;
        best = [start];
      }
    }
  }
  if (!best) return { type: 'pickup' };

  const final = best[best.length - 1];
  const action = { type: 'play', cardIds: best.map((c) => c.id) };
  if (final.rank === 'A') {
    const playedIds = new Set(action.cardIds);
    const remaining = hand.filter((c) => !playedIds.has(c.id));
    action.declaredSuit = mostCommonSuit(remaining.length ? remaining : hand, final.suit);
  }
  return action;
}

module.exports = { chooseAction };
