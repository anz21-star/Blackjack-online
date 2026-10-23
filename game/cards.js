'use strict';

// Card model: { id: 'hearts-A', suit: 'hearts'|'diamonds'|'clubs'|'spades', rank: '2'..'10'|'J'|'Q'|'K'|'A' }

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const SUIT_SYMBOL = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SUIT_NAME = { spades: 'Spades', hearts: 'Hearts', diamonds: 'Diamonds', clubs: 'Clubs' };

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  return deck;
}

function shuffle(cards) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankValue(rank) {
  if (rank === 'A') return 14;
  if (rank === 'K') return 13;
  if (rank === 'Q') return 12;
  if (rank === 'J') return 11;
  return parseInt(rank, 10);
}

function isRed(card) {
  return card.suit === 'hearts' || card.suit === 'diamonds';
}

function isBlackJack(card) {
  return card.rank === 'J' && !isRed(card);
}

function isRedJack(card) {
  return card.rank === 'J' && isRed(card);
}

function cardStr(card) {
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

module.exports = {
  SUITS,
  RANKS,
  SUIT_SYMBOL,
  SUIT_NAME,
  buildDeck,
  shuffle,
  rankValue,
  isRed,
  isBlackJack,
  isRedJack,
  cardStr,
};
