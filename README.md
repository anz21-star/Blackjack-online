# Blackjack Online

The British card game **Blackjack** — the Crazy 8s-style shedding game played
across the UK, *not* casino blackjack — as a standalone online multiplayer
web app. This is the multiplayer sibling of the solo version (you vs 3
computer players): here, friends join a room with a short code and play each
other in real time, with computer players filling any empty seats.

## The game in brief

- 2–4 humans per room; every game has 4 seats, and the host can choose to
  fill empty seats with simple CPU players (with fill off, a game is
  humans-only and needs at least 2).
- 7 cards each. Play a card matching the top card's suit or rank — or pick
  up 1 instead; playing is never forced, and any pick up ends your turn.
- **2s** = pick up 2, **black Jacks** = pick up 5 — they stack into a
  pending chain the next player must add to, cancel, or swallow.
  **Red Jacks** cancel the whole chain.
- **8s** skip the next player (stackable), **Kings** reverse direction,
  **Aces** played first in a turn go on anything and name the next suit.
- **Queens** must always be covered: anything can be played on a Queen,
  but a play can never end on one.
- **Runs**: several cards in one turn, each linking from the last (same
  rank, or same suit and consecutive; Aces inside a run must be same-suit
  consecutive, wrapping K-A-2, and a mid-run Ace's power is ignored). Only
  the final card's power takes effect.
- Call **"last cards"** any time before your next turn once you could
  finish on it — go out without ever calling and you pick up 1 instead.
  A red Jack is the only power card you can legally finish on.
- A player who has just gone out can be **brought back in** if a pick up
  chain reaches them with no gaps. Placements run 1st to last, then the
  room can play again.
- If a player disconnects mid-game, a CPU quietly takes over their seat so
  the game continues.

The server is authoritative: it holds each room's full game state,
enforces the rules, and each player is only ever sent their own hand —
opponents appear as card counts.

## Run it locally

```bash
npm install
npm start
```

The server listens on **port 3000** by default (set the `PORT` environment
variable to change it). Open `http://localhost:3000` in a browser:

1. Enter your name and **Create a room** — you get a 4-letter room code.
2. Friends open the same address (on the same network, for local play),
   enter their name and the code, and join.
3. The host picks whether empty seats are filled with CPU players and
   starts the game.

To play across the internet rather than one network, the server needs to
be reachable — see Deployment below.

## Test it

```bash
npm test
```

This starts the server on a scratch port, connects two automated socket
clients, creates and joins a room, starts a game with CPU-filled seats,
plays a series of legal moves (including power cards), checks that an
illegal play is rejected, that neither client can see the other's hand,
that both clients' public state stays in sync, and that a mid-game
disconnect converts the seat to a CPU. It stops the server when done.

## File layout

```
server.js          Express + Socket.IO server: rooms, lobby, wiring
game/cards.js      Deck, suits, card helpers
game/engine.js     The authoritative rules engine (pure state machine)
game/ai.js         The simple CPU player brain
public/            The browser client (single page: table, hand, log)
test/test-client.js  Automated two-client end-to-end test
```

## Deployment (later, not set up yet)

The app is a plain Node.js server with no build step and no database —
rooms live in memory. Deploying it means:

1. Push this folder to a free Node-capable host (for example Render,
   Railway, Fly.io, or Glitch free tiers).
2. Set the start command to `npm start` and let the host provide `PORT`
   (the server already reads it from the environment).
3. Share the host's URL; room codes work exactly as they do locally.

Notes for that step: free tiers often sleep when idle (the first load
after a nap is slow), and because rooms are in-memory, a server restart
clears any rooms in progress. No accounts or sign-ups are needed by
players either way — just the room code.
