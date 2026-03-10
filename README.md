# 大二 · Big 2

Multiplayer Big 2 card game for 2 players.

## Files

- `server.js` — Node.js WebSocket game server
- `index.html` — Game client (deploy to Vercel)
- `package.json` — Server dependencies

---

## Deployment

### Step 1 — Deploy the server to Railway

1. Go to [railway.app](https://railway.app) and create a new project
2. Choose **Deploy from GitHub repo**
3. Push this folder to a GitHub repo and connect it
4. Railway will auto-detect Node.js and run `npm start`
5. Once deployed, copy your Railway URL — it'll look like:
   `big2-server.up.railway.app`

### Step 2 — Update the client

In `index.html`, find this line near the bottom:

```js
: 'wss://YOUR_SERVER_URL_HERE';
```

Replace `YOUR_SERVER_URL_HERE` with your Railway URL:

```js
: 'wss://big2-server.up.railway.app';
```

### Step 3 — Deploy the frontend to Vercel

1. Push `index.html` to a GitHub repo (can be the same one)
2. Go to [vercel.com](https://vercel.com), import the repo
3. Deploy — done!

---

## How to play

1. Player 1 opens the site, enters their name, leaves room code blank, clicks **enter the room**
2. They get a 4-letter room code — share it with Player 2
3. Player 2 enters their name + the room code and joins
4. Game starts automatically

### Rules implemented

- Standard Big 2 ranking: 3 low → 2 high, suits ♦ ♣ ♥ ♠
- Valid plays: singles, pairs, triples, straights, flushes, full houses, four-of-a-kind, straight flushes
- First play of the game must include the **3♦**
- If your opponent passes on your play, you lead the next round freely
- First to empty their hand wins
