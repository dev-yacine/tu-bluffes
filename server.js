'use strict';
/**
 * TU BLUFFES — serveur de jeu (Node.js + ws)
 * Le serveur est l'unique source de vérité : les clients ne voient que leur propre main.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const ORDER = {};
RANKS.forEach((r, i) => (ORDER[r] = i));
ORDER.JOKER = 99;
const LABELS = {
  A: 'un as', 2: 'un deux', 3: 'un trois', 4: 'un quatre', 5: 'un cinq', 6: 'un six',
  7: 'un sept', 8: 'un huit', 9: 'un neuf', 10: 'un dix', J: 'un valet', Q: 'une dame', K: 'un roi',
};
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const MAX_PER_TURN = 4;
// false : la partie continue après la 1re victoire (classement) ; true : elle s'arrête au 1er qui finit
const STOP_AT_FIRST_WINNER = false;

const rooms = new Map();

class GameError extends Error {}
const fail = (m) => { throw new GameError(m); };

/* ---------- utilitaires ---------- */
const uid = () => crypto.randomBytes(12).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeDeck() {
  const d = [];
  let id = 0;
  for (const s of SUITS) for (const r of RANKS) d.push({ id: id++, rank: r, suit: s });
  d.push({ id: id++, rank: 'JOKER', suit: '' });
  d.push({ id: id++, rank: 'JOKER', suit: '' });
  return d;
}
const cardLabel = (c) => (c.rank === 'JOKER' ? 'un Joker' : `${c.rank}${c.suit}`);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 18) || 'Joueur';
const byId = (room, id) => room.players.find((p) => p.id === id);
const idxOf = (room, id) => room.players.findIndex((p) => p.id === id);

/* ---------- salons ---------- */
function createRoom() {
  const room = {
    code: newCode(), players: [], hostId: null, phase: 'lobby',
    turnIdx: 0, currentRank: null, pile: [], lastPlay: null, lastPlacerId: null, skips: 0, discarded: 0,
    log: [], seq: 0, reveal: null, winnerId: null, ranking: [], touched: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name) {
  const p = { id: uid(), name: cleanName(name), hand: [], ws: null, dropTimer: null };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}
function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch (e) { /* ignore */ } }
  p.ws = ws;
  clearTimeout(p.dropTimer);
  ws.ctx = { code: room.code, playerId: p.id };
  room.touched = Date.now();
}
function removePlayer(room, id) {
  const i = idxOf(room, id);
  if (i < 0) return;
  clearTimeout(room.players[i].dropTimer);
  room.players.splice(i, 1);
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.hostId === id) room.hostId = (room.players.find((p) => p.ws) || room.players[0]).id;
  broadcast(room);
}
const addLog = (room, t) => { room.log.push(t); if (room.log.length > 60) room.log.shift(); };

/* ---------- logique de jeu ---------- */
function startGame(room) {
  room.players = room.players.filter((p) => p.ws);
  if (room.players.length < MIN_PLAYERS) fail('Il faut au moins 2 joueurs connectés.');
  if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0].id;
  const deck = shuffle(makeDeck());
  room.players.forEach((p) => { p.hand = []; p.finished = false; });
  room.ranking = [];
  deck.forEach((c, i) => room.players[i % room.players.length].hand.push(c));
  room.phase = 'playing';
  room.currentRank = null;
  room.pile = [];
  room.lastPlay = null;
  room.lastPlacerId = null;
  room.skips = 0;
  room.discarded = 0;
  room.winnerId = null;
  room.reveal = null;
  room.log = [];
  room.turnIdx = crypto.randomInt(room.players.length);
  addLog(room, `La partie commence ! 54 cartes (dont 2 jokers) distribuées à ${room.players.length} joueurs.`);
  addLog(room, `${room.players[room.turnIdx].name} commence et choisit le premier chiffre.`);
}
function nextActiveIdx(room, from) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n;
    if (!room.players[j].finished) return j;
  }
  return from;
}
const activeCount = (room) => room.players.filter((p) => !p.finished).length;
function newRoundFor(room, p) {
  // le tapis (room.pile) n'est PAS vidé ici : il ne l'est que lorsqu'un joueur le ramasse
  room.currentRank = null;
  room.skips = 0;
  room.lastPlay = null;
  room.lastPlacerId = null;
  room.turnIdx = idxOf(room, p.id);
}
function finishPlayer(room, p) {
  p.finished = true;
  room.ranking.push(p.id);
  const place = room.ranking.length;
  addLog(room, place === 1
    ? `🏆 ${p.name} a posé toutes ses cartes : victoire !`
    : `🏁 ${p.name} a posé toutes ses cartes : ${place}e place.`);
  const left = room.players.filter((q) => !q.finished);
  if (STOP_AT_FIRST_WINNER || left.length <= 1) {
    if (left.length === 1) room.ranking.push(left[0].id);
    room.phase = 'ended';
    room.winnerId = room.ranking[0];
    return;
  }
  // le joueur suivant relance avec le chiffre de son choix
  const next = room.players[nextActiveIdx(room, idxOf(room, p.id))];
  newRoundFor(room, next);
  addLog(room, `${next.name} (joueur suivant) relance un nouveau tour avec le chiffre de son choix.`);
}
function endRound(room) {
  const last = byId(room, room.lastPlacerId);
  addLog(room, `Tout le monde a passé : le tapis reste en place (${room.pile.length} cartes).`);
  if (last.hand.length === 0) return finishPlayer(room, last);
  newRoundFor(room, last);
  addLog(room, `${last.name} relance un nouveau tour avec le chiffre de son choix.`);
}

function act(room, p, msg) {
  if (room.phase !== 'playing') fail('La partie n\'est pas en cours.');
  const cur = room.players[room.turnIdx];
  if (cur.id !== p.id) fail('Ce n\'est pas ton tour.');
  const last = room.lastPlacerId ? byId(room, room.lastPlacerId) : null;
  const lastEmpty = last && last.hand.length === 0;

  if (msg.type === 'play') {
    if (lastEmpty) fail('Le joueur précédent n\'a plus de cartes : accuse-le ou passe.');
    let rank = room.currentRank;
    if (rank === null) {
      rank = msg.rank;
      if (!RANKS.includes(rank)) fail('Choisis le chiffre à annoncer.');
    }
    const ids = Array.isArray(msg.cardIds) ? msg.cardIds : [];
    if (ids.length < 1 || ids.length > MAX_PER_TURN) fail(`Pose entre 1 et ${MAX_PER_TURN} cartes.`);
    if (new Set(ids).size !== ids.length) fail('Cartes en double.');
    const cards = ids.map((id) => p.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) fail('Carte introuvable dans ta main.');
    const starting = room.currentRank === null;
    p.hand = p.hand.filter((c) => !ids.includes(c.id));
    room.currentRank = rank;
    cards.forEach((card) => room.pile.push({ playerId: p.id, card }));
    room.lastPlay = { playerId: p.id, cards };
    room.lastPlacerId = p.id;
    room.skips = 0;
    const n = cards.length;
    const what = `${n} carte${n > 1 ? 's' : ''}`;
    addLog(room, starting
      ? `${p.name} pose ${what} face cachée et annonce : « ${LABELS[rank]} ».`
      : `${p.name} pose ${what} (« ${LABELS[rank]} »).`);
    if (p.hand.length === 0) addLog(room, `⚠️ ${p.name} a posé sa dernière carte ! Accusez-le, sinon il gagne.`);
    room.turnIdx = nextActiveIdx(room, room.turnIdx);
    return;
  }

  if (msg.type === 'skip') {
    if (room.currentRank === null || !room.pile.length) fail('Tu dois poser une carte pour lancer le tour.');
    room.skips++;
    addLog(room, `${p.name} passe.`);
    if (room.skips >= activeCount(room) - 1) endRound(room);
    else room.turnIdx = nextActiveIdx(room, room.turnIdx);
    return;
  }

  if (msg.type === 'accuse') {
    if (!room.pile.length || !last) fail('Il n\'y a personne à accuser.');
    const cards = room.lastPlay.cards;
    const bluff = cards.some((c) => c.rank !== room.currentRank); // un joker est toujours un bluff
    const loser = bluff ? last : p;      // celui qui ramasse
    const starter = bluff ? p : last;    // celui qui NE ramasse PAS relance
    const n = room.pile.length;
    const shownCards = cards.map(cardLabel).join(', ');
    room.seq++;
    room.reveal = {
      seq: room.seq, cards, claimed: room.currentRank, bluff,
      accuserId: p.id, accusedId: last.id, loserId: loser.id, count: n,
    };
    addLog(room, `${p.name} accuse ${last.name} : « Tu bluffes ! »`);
    addLog(room, bluff
      ? `Cartes retournées : ${shownCards} → c'était un bluff ! ${loser.name} ramasse les ${n} cartes.`
      : `Cartes retournées : ${shownCards} → pas de bluff ! ${loser.name} ramasse les ${n} cartes.`);
    loser.hand.push(...room.pile.map((e) => e.card));
    room.pile = [];
    if (!bluff && last.hand.length === 0) return finishPlayer(room, last);
    newRoundFor(room, starter);
    addLog(room, `${starter.name} relance un nouveau tour avec le chiffre de son choix.`);
    return;
  }
}

/* ---------- vue envoyée à chaque joueur ---------- */
function viewFor(room, p) {
  const playing = room.phase === 'playing';
  const cur = playing ? room.players[room.turnIdx] : null;
  const last = room.lastPlacerId ? byId(room, room.lastPlacerId) : null;
  const myTurn = !!cur && cur.id === p.id;
  const lastEmpty = !!last && last.hand.length === 0;
  const hasPile = room.pile.length > 0 && room.currentRank !== null;
  return {
    type: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    youId: p.id,
    players: room.players.map((q) => ({ id: q.id, name: q.name, count: q.hand.length, connected: !!q.ws, finished: !!q.finished, place: room.ranking.indexOf(q.id) + 1 || null })),
    ranking: room.ranking,
    turnId: cur ? cur.id : null,
    currentRank: room.currentRank,
    rankLabel: room.currentRank ? LABELS[room.currentRank] : null,
    pileCount: room.pile.length,
    discarded: room.discarded,
    lastPlacerId: room.lastPlacerId,
    skips: room.skips,
    hand: p.hand.slice().sort((a, b) => ORDER[a.rank] - ORDER[b.rank] || a.suit.localeCompare(b.suit)),
    can: {
      play: myTurn && p.hand.length > 0 && !lastEmpty,
      skip: myTurn && hasPile,
      accuse: myTurn && hasPile,
      chooseRank: myTurn && room.currentRank === null,
    },
    labels: LABELS,
    maxPerTurn: MAX_PER_TURN,
    log: room.log.slice(-40),
    winnerId: room.winnerId,
    reveal: room.reveal,
  };
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players) send(p.ws, viewFor(room, p));
}

/* ---------- messages ---------- */
function handle(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'create') {
    detach(ws);
    const room = createRoom();
    const p = addPlayer(room, msg.name);
    attach(ws, room, p);
    send(ws, { type: 'joined', playerId: p.id, code: room.code, name: p.name });
    return broadcast(room);
  }
  if (msg.type === 'join') {
    detach(ws);
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) fail('Salon introuvable. Vérifie le code.');
    if (room.phase !== 'lobby') fail('La partie a déjà commencé.');
    if (room.players.length >= MAX_PLAYERS) fail('Le salon est plein.');
    const p = addPlayer(room, msg.name);
    attach(ws, room, p);
    send(ws, { type: 'joined', playerId: p.id, code: room.code, name: p.name });
    return broadcast(room);
  }
  if (msg.type === 'rejoin') {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const p = room && room.players.find((q) => q.id === msg.playerId);
    if (!p) return send(ws, { type: 'rejoin_failed' });
    attach(ws, room, p);
    send(ws, { type: 'joined', playerId: p.id, code: room.code, name: p.name });
    return broadcast(room);
  }

  const ctx = ws.ctx;
  if (!ctx) fail('Pas connecté à un salon.');
  const room = rooms.get(ctx.code);
  const p = room && byId(room, ctx.playerId);
  if (!p) fail('Salon introuvable.');

  switch (msg.type) {
    case 'start':
      if (room.hostId !== p.id) fail('Seul l\'hôte peut lancer la partie.');
      if (room.phase !== 'lobby') fail('Déjà lancée.');
      startGame(room);
      break;
    case 'again':
      if (room.hostId !== p.id) fail('Seul l\'hôte peut relancer.');
      if (room.phase !== 'ended') fail('La partie n\'est pas terminée.');
      startGame(room);
      break;
    case 'play': case 'skip': case 'accuse':
      act(room, p, msg);
      break;
    case 'leave':
      if (room.phase === 'playing') fail('Tu ne peux pas quitter en pleine partie.');
      ws.ctx = null;
      p.ws = null;
      removePlayer(room, p.id);
      return send(ws, { type: 'left' });
    default:
      return;
  }
  broadcast(room);
}

function detach(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const room = rooms.get(ctx.code);
  const p = room && byId(room, ctx.playerId);
  if (p && p.ws === ws) {
    p.ws = null;
    if (room.phase === 'lobby') removePlayer(room, p.id);
    else broadcast(room);
  }
}
function onClose(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  const room = rooms.get(ctx.code);
  const p = room && byId(room, ctx.playerId);
  if (!p || p.ws !== ws) return;
  p.ws = null;
  if (room.phase === 'lobby') {
    // délai de grâce (rafraîchissement de page, coupure réseau brève)
    p.dropTimer = setTimeout(() => { if (!p.ws && room.phase === 'lobby') removePlayer(room, p.id); }, 30000);
  }
  broadcast(room);
}

/* ---------- serveur HTTP + WebSocket ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) {
      if (e instanceof GameError) send(ws, { type: 'error', message: e.message });
      else console.error(e);
    }
  });
  ws.on('close', () => onClose(ws));
});
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > 3 * 3600 * 1000 && !room.players.some((p) => p.ws)) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Tu bluffes ! → http://localhost:${PORT}`));
