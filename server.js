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
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ── Play validation ───────────────────────────────────────────────────────────
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
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = ranks.every((r, i) => i === 0 || r === ranks[i-1] + 1);

  // straight flush
  if (isFlush && isStraight)
    return { type: 'straightflush', value: cardValue(sorted[4]) };

  // four of a kind + 1
  const rankGroups = {};
  sorted.forEach(c => { rankGroups[c.rank] = (rankGroups[c.rank] || 0) + 1; });
  const counts = Object.values(rankGroups).sort((a,b) => b-a);
  if (counts[0] === 4) {
    const quadRank = Object.keys(rankGroups).find(r => rankGroups[r] === 4);
    return { type: 'fourkind', value: RANKS.indexOf(quadRank) * 4 + 3 };
  }

  // full house
  if (counts[0] === 3 && counts[1] === 2) {
    const tripRank = Object.keys(rankGroups).find(r => rankGroups[r] === 3);
    return { type: 'fullhouse', value: RANKS.indexOf(tripRank) * 4 + 3 };
  }

  // flush
  if (isFlush)
    return { type: 'flush', value: cardValue(sorted[4]) };

  // straight
  if (isStraight)
    return { type: 'straight', value: cardValue(sorted[4]) };

  return null;
}

// Five-card type rank order: straight < flush < fullhouse < fourkind < straightflush
const FIVE_RANK = ['straight','flush','fullhouse','fourkind','straightflush'];

function beats(play, current) {
  if (!current) return true; // leading

  const p = getPlayType(play);
  const c = getPlayType(current);
  if (!p || !c) return false;
  if (p.type !== c.type) {
    // five-card hands can beat each other by type
    if (play.length === 5 && current.length === 5) {
      return FIVE_RANK.indexOf(p.type) > FIVE_RANK.indexOf(c.type);
    }
    return false;
  }
  if (play.length !== current.length) return false;
  return p.value > c.value;
}

// ── Room management ──────────────────────────────────────────────────────────
const rooms = {};

function createRoom(code) {
  return {
    code,
    players: [],   // [{ ws, name, hand, id }]
    state: 'waiting', // waiting | playing | done
    currentTurn: 0,   // index into players
    currentPlay: null,
    currentPlayBy: null,
    passCount: 0,
    firstTurn: true,
  };
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

function sendTo(player, msg) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function gameState(room, forPlayerIdx) {
  const me = room.players[forPlayerIdx];
  const opp = room.players[1 - forPlayerIdx];
  return {
    type: 'state',
    myHand: sortCards(me.hand),
    oppCardCount: opp ? opp.hand.length : 0,
    oppName: opp ? opp.name : null,
    myName: me.name,
    myIdx: forPlayerIdx,
    currentTurn: room.currentTurn,
    currentPlay: room.currentPlay,
    currentPlayBy: room.currentPlayBy,
    passCount: room.passCount,
    firstTurn: room.firstTurn,
    gameOver: room.state === 'done',
    winner: room.winner || null,
  };
}

function broadcastState(room) {
  room.players.forEach((p, i) => sendTo(p, gameState(room, i)));
}

function startGame(room) {
  const deck = makeDeck();
  room.players[0].hand = deck.slice(0, 13);
  room.players[1].hand = deck.slice(13, 26);
  room.state = 'playing';
  room.currentPlay = null;
  room.currentPlayBy = null;
  room.passCount = 0;
  room.firstTurn = true;

  // player holding 3♦ goes first
  const starterIdx = room.players.findIndex(p =>
    p.hand.some(c => c.rank === '3' && c.suit === '♦')
  );
  room.currentTurn = starterIdx >= 0 ? starterIdx : 0;

  broadcastState(room);
  broadcast(room, { type: 'started', firstTurn: room.currentTurn });
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let myRoom = null;
  let myIdx  = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──
    if (msg.type === 'join') {
      const name = (msg.name || 'Player').slice(0, 16);
      let code = (msg.code || '').toUpperCase().trim();

      // find or create room
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
      myRoom.players.push({ ws, name, hand: [], id: myIdx });

      ws.send(JSON.stringify({ type: 'joined', code: myRoom.code, playerIdx: myIdx, name }));
      broadcast(myRoom, { type: 'lobby', players: myRoom.players.map(p => p.name), code: myRoom.code });

      if (myRoom.players.length === 2) startGame(myRoom);
      return;
    }

    if (!myRoom || myIdx === null) return;

    // ── PLAY ──
    if (msg.type === 'play') {
      if (myRoom.state !== 'playing') return;
      if (myRoom.currentTurn !== myIdx) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Not your turn.' }));
        return;
      }

      const me = myRoom.players[myIdx];
      const played = msg.cards; // [{ rank, suit }, ...]

      // verify player actually holds these cards
      const handCopy = [...me.hand];
      for (const pc of played) {
        const idx = handCopy.findIndex(c => c.rank === pc.rank && c.suit === pc.suit);
        if (idx === -1) { ws.send(JSON.stringify({ type: 'error', msg: 'Card not in hand.' })); return; }
        handCopy.splice(idx, 1);
      }

      // validate play type
      const playType = getPlayType(played);
      if (!playType) { ws.send(JSON.stringify({ type: 'error', msg: 'Invalid combination.' })); return; }

      // first turn must include 3♦
      if (myRoom.firstTurn) {
        const has3d = played.some(c => c.rank === '3' && c.suit === '♦');
        if (!has3d) { ws.send(JSON.stringify({ type: 'error', msg: 'First play must include 3♦.' })); return; }
      }

      // must beat current play (unless leading)
      if (myRoom.currentPlay && !beats(played, myRoom.currentPlay)) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Doesn\'t beat the current play.' }));
        return;
      }

      // commit
      me.hand = handCopy;
      myRoom.currentPlay = played;
      myRoom.currentPlayBy = myIdx;
      myRoom.passCount = 0;
      myRoom.firstTurn = false;

      broadcast(myRoom, { type: 'played', by: myIdx, byName: me.name, cards: played, playType: playType.type });

      // check win
      if (me.hand.length === 0) {
        myRoom.state = 'done';
        myRoom.winner = myIdx;
        broadcastState(myRoom);
        broadcast(myRoom, { type: 'gameover', winner: myIdx, winnerName: me.name });
        return;
      }

      myRoom.currentTurn = 1 - myIdx;
      broadcastState(myRoom);
      return;
    }

    // ── PASS ──
    if (msg.type === 'pass') {
      if (myRoom.state !== 'playing') return;
      if (myRoom.currentTurn !== myIdx) return;
      if (!myRoom.currentPlay) { ws.send(JSON.stringify({ type: 'error', msg: 'Cannot pass when leading.' })); return; }

      const me = myRoom.players[myIdx];
      myRoom.passCount++;
      broadcast(myRoom, { type: 'passed', by: myIdx, byName: me.name });

      // with 2 players, one pass = you led, opponent passed = you lead again
      if (myRoom.passCount >= 1 && myRoom.currentPlayBy !== null) {
        // opponent passed on your play — you lead freely
        myRoom.currentPlay = null;
        myRoom.currentPlayBy = null;
        myRoom.passCount = 0;
        myRoom.currentTurn = myRoom.currentPlayBy !== null
          ? (1 - myIdx)  // go back to who played last
          : myIdx;
        // simply: whoever's play was last leads again
        myRoom.currentTurn = 1 - myIdx; // the non-passer
        // correct: after a pass, the last player who played leads
        myRoom.currentTurn = myIdx === myRoom.currentPlayBy ? myIdx : 1 - myIdx;
        broadcastState(myRoom);
        broadcast(myRoom, { type: 'newlead', leader: myRoom.currentTurn });
      } else {
        myRoom.currentTurn = 1 - myIdx;
        broadcastState(myRoom);
      }
      return;
    }

    // ── REMATCH ──
    if (msg.type === 'rematch') {
      myRoom.rematchVotes = (myRoom.rematchVotes || 0) + 1;
      broadcast(myRoom, { type: 'rematchVote', votes: myRoom.rematchVotes });
      if (myRoom.rematchVotes >= 2) {
        myRoom.rematchVotes = 0;
        myRoom.state = 'playing';
        myRoom.winner = null;
        startGame(myRoom);
      }
    }
  });

  ws.on('close', () => {
    if (myRoom) {
      broadcast(myRoom, { type: 'disconnected', playerIdx: myIdx });
      // clean up room if empty
      setTimeout(() => {
        if (myRoom && myRoom.players.every(p => p.ws.readyState !== 1)) {
          delete rooms[myRoom.code];
        }
      }, 30000);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Big 2 server running on port ${PORT}`));
