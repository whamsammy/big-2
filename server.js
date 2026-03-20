const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Big 2 server is running');
});
const wss = new WebSocketServer({ server });

// ── Card helpers ──────────────────────────────────────────────────────────────
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS = ['♦','♣','♥','♠']; // ascending value

function cardValue(card) {
  return RANKS.indexOf(card.rank) * 4 + SUITS.indexOf(card.suit);
}

function sortCards(cards) {
  return [...cards].sort((a, b) => cardValue(a) - cardValue(b));
}

function makeDeck() {
  const deck = [];
  for (const rank of RANKS)
    for (const suit of SUITS)
      deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ── Play type detection ───────────────────────────────────────────────────────
function getPlayType(cards) {
  const n = cards.length;
  const sorted = sortCards(cards);

  if (n === 1) return { type: 'single', value: cardValue(sorted[0]) };

  if (n === 2) {
    if (sorted[0].rank === sorted[1].rank)
      return { type: 'pair', value: cardValue(sorted[1]) };
    return null;
  }

  if (n === 3) {
    if (sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank)
      return { type: 'triple', value: cardValue(sorted[2]) };
    return null;
  }

  if (n === 5) return getFiveCardType(sorted);

  return null;
}

function getFiveCardType(sorted) {
  const ranks = sorted.map(c => RANKS.indexOf(c.rank));
  const suits = sorted.map(c => c.suit);
  const isFlush    = suits.every(s => s === suits[0]);
  const isStraight = ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);

  if (isFlush && isStraight)
    return { type: 'straightflush', value: cardValue(sorted[4]) };

  const rankGroups = {};
  sorted.forEach(c => { rankGroups[c.rank] = (rankGroups[c.rank] || 0) + 1; });
  const counts = Object.values(rankGroups).sort((a, b) => b - a);

  if (counts[0] === 4) {
    const quadRank = Object.keys(rankGroups).find(r => rankGroups[r] === 4);
    return { type: 'fourkind', value: RANKS.indexOf(quadRank) * 4 + 3 };
  }

  if (counts[0] === 3 && counts[1] === 2) {
    const tripRank = Object.keys(rankGroups).find(r => rankGroups[r] === 3);
    return { type: 'fullhouse', value: RANKS.indexOf(tripRank) * 4 + 3 };
  }

  // House rule: flush winner decided by suit (♠ > ♥ > ♣ > ♦), not card values
  if (isFlush)
    return { type: 'flush', value: SUITS.indexOf(suits[0]) };

  if (isStraight)
    return { type: 'straight', value: cardValue(sorted[4]) };

  return null;
}

// Five-card hand hierarchy (lowest to highest)
const FIVE_RANK = ['straight', 'flush', 'fullhouse', 'fourkind', 'straightflush'];

function beats(play, current) {
  if (!current) return true; // leading, anything goes

  const p = getPlayType(play);
  const c = getPlayType(current);
  if (!p || !c) return false;
  if (play.length !== current.length) return false;

  // five-card hands: higher type wins; same type, higher value wins
  if (play.length === 5) {
    const pRank = FIVE_RANK.indexOf(p.type);
    const cRank = FIVE_RANK.indexOf(c.type);
    if (pRank !== cRank) return pRank > cRank;
    return p.value > c.value;
  }

  // singles, pairs, triples: must be same type, higher value wins
  if (p.type !== c.type) return false;
  return p.value > c.value;
}

// ── Room helpers ──────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(code) {
  return {
    code,
    players: [],
    state: 'waiting',
    currentTurn: 0,
    currentPlay: null,
    currentPlayBy: null,
    passCount: 0,
    firstTurn: true,
    lowestCard: null,
    winner: null,
    rematchVotes: 0,
  };
}

function sendTo(player, msg) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  room.players.forEach(p => sendTo(p, msg));
}

function buildState(room, forPlayerIdx) {
  const me  = room.players[forPlayerIdx];
  const opp = room.players[1 - forPlayerIdx];
  return {
    type:          'state',
    myHand:        sortCards(me.hand),
    oppCardCount:  opp ? opp.hand.length : 0,
    oppName:       opp ? opp.name : null,
    oppEmoji:      opp ? opp.emoji : null,
    myEmoji:       me.emoji,
    myName:        me.name,
    myIdx:         forPlayerIdx,
    currentTurn:   room.currentTurn,
    currentPlay:   room.currentPlay,
    currentPlayBy: room.currentPlayBy,
    passCount:     room.passCount,
    firstTurn:     room.firstTurn,
    lowestCard:    room.firstTurn ? room.lowestCard : null,
    gameOver:      room.state === 'done',
    winner:        room.winner,
    loserHand:     room.state === 'done' ? sortCards(room.players[1 - room.winner].hand) : null,
  };
}

function broadcastState(room) {
  room.players.forEach((p, i) => sendTo(p, buildState(room, i)));
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function startGame(room) {
  const deck = makeDeck();
  room.players[0].hand = deck.slice(0, 13);
  room.players[1].hand = deck.slice(13, 26);

  room.state        = 'playing';
  room.currentPlay  = null;
  room.currentPlayBy = null;
  room.passCount    = 0;
  room.firstTurn    = true;
  room.winner       = null;
  room.rematchVotes = 0;

  // whoever holds the single lowest card goes first
  let lowestValue = Infinity;
  let starterIdx  = 0;
  room.players.forEach((p, i) => {
    p.hand.forEach(c => {
      const v = cardValue(c);
      if (v < lowestValue) { lowestValue = v; starterIdx = i; }
    });
  });
  room.currentTurn = starterIdx;
  room.lowestCard  = room.players[starterIdx].hand.find(c => cardValue(c) === lowestValue);

  broadcastState(room);
  broadcast(room, { type: 'started' });
}

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let myRoom = null;
  let myIdx  = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ─────────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const name = (msg.name || 'Player').slice(0, 16);
      let code = (msg.code || '').toUpperCase().trim();

      if (code && rooms[code]) {
        myRoom = rooms[code];
      } else {
        code = genCode();
        while (rooms[code]) code = genCode();
        myRoom = createRoom(code);
        rooms[code] = myRoom;
      }

      if (myRoom.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Room is full.' }));
        return;
      }
      if (myRoom.state === 'playing') {
        ws.send(JSON.stringify({ type: 'error', msg: 'Game already started.' }));
        return;
      }

      myIdx = myRoom.players.length;
      myRoom.players.push({ ws, name, hand: [], id: myIdx, emoji: msg.emoji || '🎴' });

      ws.send(JSON.stringify({ type: 'joined', code: myRoom.code, playerIdx: myIdx, name }));
      broadcast(myRoom, {
        type:    'lobby',
        players: myRoom.players.map(p => p.name),
        emojis:  myRoom.players.map(p => p.emoji),
        code:    myRoom.code,
      });

      if (myRoom.players.length === 2) startGame(myRoom);
      return;
    }

    if (!myRoom || myIdx === null) return;

    // ── PLAY ─────────────────────────────────────────────────────────────────
    if (msg.type === 'play') {
      if (myRoom.state !== 'playing') return;
      if (myRoom.currentTurn !== myIdx) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Not your turn.' }));
        return;
      }

      const me     = myRoom.players[myIdx];
      const played = msg.cards;

      // verify all played cards are in hand
      const handCopy = [...me.hand];
      for (const pc of played) {
        const idx = handCopy.findIndex(c => c.rank === pc.rank && c.suit === pc.suit);
        if (idx === -1) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Card not in hand.' }));
          return;
        }
        handCopy.splice(idx, 1);
      }

      // validate combination
      const playType = getPlayType(played);
      if (!playType) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Invalid combination.' }));
        return;
      }

      // first play must include the lowest card
      if (myRoom.firstTurn) {
        const lc = myRoom.lowestCard;
        const hasLowest = played.some(c => c.rank === lc.rank && c.suit === lc.suit);
        if (!hasLowest) {
          ws.send(JSON.stringify({ type: 'error', msg: `First play must include ${lc.rank}${lc.suit}.` }));
          return;
        }
      }

      // must beat current play
      if (myRoom.currentPlay && !beats(played, myRoom.currentPlay)) {
        ws.send(JSON.stringify({ type: 'error', msg: "Doesn't beat the current play." }));
        return;
      }

      // commit play
      me.hand            = handCopy;
      myRoom.currentPlay  = played;
      myRoom.currentPlayBy = myIdx;
      myRoom.passCount   = 0;
      myRoom.firstTurn   = false;

      broadcast(myRoom, { type: 'played', by: myIdx, byName: me.name, cards: played, playType: playType.type });

      if (me.hand.length === 0) {
        myRoom.state  = 'done';
        myRoom.winner = myIdx;
        broadcastState(myRoom);
        broadcast(myRoom, { type: 'gameover', winner: myIdx, winnerName: me.name });
        return;
      }

      myRoom.currentTurn = 1 - myIdx;
      broadcastState(myRoom);
      return;
    }

    // ── PASS ─────────────────────────────────────────────────────────────────
    if (msg.type === 'pass') {
      if (myRoom.state !== 'playing') return;
      if (myRoom.currentTurn !== myIdx) return;
      if (!myRoom.currentPlay) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Cannot pass when leading.' }));
        return;
      }

      const me = myRoom.players[myIdx];
      broadcast(myRoom, { type: 'passed', by: myIdx, byName: me.name });

      // in 2-player: one pass means the other player led unchallenged — they lead again
      const lastPlayedBy = myRoom.currentPlayBy;
      myRoom.currentPlay  = null;
      myRoom.currentPlayBy = null;
      myRoom.passCount    = 0;
      myRoom.currentTurn  = lastPlayedBy;

      broadcastState(myRoom);
      broadcast(myRoom, { type: 'newlead', leader: lastPlayedBy });
      return;
    }

    // ── CHAT ─────────────────────────────────────────────────────────────────
    if (msg.type === 'chat') {
      if (!myRoom || myRoom.state !== 'playing') return;
      const text = (msg.text || '').slice(0, 120).trim();
      if (!text) return;
      broadcast(myRoom, { type: 'chat', from: myIdx, text });
      return;
    }

    // ── REMATCH ──────────────────────────────────────────────────────────────
    if (msg.type === 'rematch') {
      myRoom.rematchVotes++;
      broadcast(myRoom, { type: 'rematchVote', votes: myRoom.rematchVotes });
      if (myRoom.rematchVotes >= 2) startGame(myRoom);
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    broadcast(myRoom, { type: 'disconnected', playerIdx: myIdx });
    setTimeout(() => {
      if (myRoom.players.every(p => p.ws.readyState !== 1)) {
        delete rooms[myRoom.code];
      }
    }, 30000);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Big 2 server running on port ${PORT}`));
