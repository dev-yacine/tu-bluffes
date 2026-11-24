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

const VERSION = 'v10-jokers-option';
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
const CHAT_MAX = 100;                 // longueur max d'un message (au-delà : coupé avec « … »)
const BOT_SPEED = Number(process.env.BOT_SPEED) || 1; // >1 = bots plus rapides (utile pour les tests)
const BOT_NAMES = ['Robin', 'Zoé', 'Karim', 'Léa', 'Max', 'Nina', 'Yanis', 'Inès', 'Hugo', 'Sara'];

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
function makeDeck(withJokers = true) {
  const d = [];
  let id = 0;
  for (const s of SUITS) for (const r of RANKS) d.push({ id: id++, rank: r, suit: s });
  if (withJokers) {
    d.push({ id: id++, rank: 'JOKER', suit: '' });
    d.push({ id: id++, rank: 'JOKER', suit: '' });
  }
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
    turnIdx: 0, currentRank: null, pile: [], lastPlay: null, lastPlacerId: null, passed: [], roundCount: 0, discarded: 0,
    jokers: true, log: [], seq: 0, reveal: null, revealAt: 0, winnerId: null, ranking: [], touched: Date.now(),
    chat: [], chatSeq: 0, ver: 0, botTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}
function deleteRoom(room) {
  clearTimeout(room.botTimer);
  room.players.forEach((p) => clearTimeout(p.dropTimer));
  rooms.delete(room.code);
}
const plain = (n) => String(n).replace(/^🤖\s*/, '').toLowerCase();
function nameTaken(room, name, exceptId) {
  return room.players.some((p) => p.id !== exceptId && plain(p.name) === plain(name));
}
/** Nom choisi par l'hôte (ou nom par défaut si vide). */
function botName(room, raw, exceptId) {
  const wanted = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 18);
  if (wanted) {
    if (nameTaken(room, wanted, exceptId)) fail(`Le nom « ${wanted} » est déjà pris.`);
    return wanted;
  }
  const free = BOT_NAMES.find((n) => !nameTaken(room, n, exceptId));
  return `🤖 ${free || 'Bot ' + (room.players.length + 1)}`;
}
function addBot(room, rawName) {
  const name = botName(room, rawName);
  const p = { id: uid(), name, hand: [], ws: null, dropTimer: null, bot: true };
  room.players.push(p);
  return p;
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
  if (!room.players.some((p) => !p.bot)) { deleteRoom(room); return; }
  if (room.hostId === id) room.hostId = (room.players.find((p) => !p.bot && p.ws) || room.players.find((p) => !p.bot)).id;
  broadcast(room);
}
const addLog = (room, t) => { room.log.push(t); if (room.log.length > 60) room.log.shift(); };

/* ---------- logique de jeu ---------- */
function startGame(room) {
  room.players = room.players.filter((p) => p.ws || p.bot);
  if (room.players.length < MIN_PLAYERS) fail('Il faut au moins 2 joueurs (ajoute un bot si tu es seul).');
  if (!room.players.some((p) => p.id === room.hostId)) room.hostId = (room.players.find((p) => !p.bot) || room.players[0]).id;
  const deck = shuffle(makeDeck(room.jokers));
  room.players.forEach((p) => { p.hand = []; p.finished = false; p.left = false; });
  room.ranking = [];
  deck.forEach((c, i) => room.players[i % room.players.length].hand.push(c));
  room.phase = 'playing';
  room.currentRank = null;
  room.pile = [];
  room.lastPlay = null;
  room.roundCount = 0;
  room.lastPlacerId = null;
  room.passed = [];
  room.discarded = 0;
  room.winnerId = null;
  room.reveal = null;
  room.log = [];
  room.turnIdx = crypto.randomInt(room.players.length);
  addLog(room, `La partie commence ! ${deck.length} cartes (${room.jokers ? 'dont 2 jokers' : 'sans jokers'}) distribuées à ${room.players.length} joueurs.`);
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
  room.passed = [];
  room.lastPlay = null;
  room.roundCount = 0;
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

const allPassed = (room) => !!room.lastPlacerId
  && room.players.every((q) => q.finished || q.id === room.lastPlacerId || room.passed.includes(q.id));

/** Un joueur quitte en pleine partie : ses cartes sont réparties entre les joueurs restants. */
function leaveMidGame(room, p, kicked) {
  const idx = idxOf(room, p.id);
  const wasFinished = p.finished;
  const wasCurrent = room.turnIdx === idx;
  const wasLastPlacer = room.lastPlacerId === p.id;
  p.left = true;
  p.finished = true; // sort de la rotation des tours
  addLog(room, kicked ? `🥾 ${p.name} a été expulsé par l'hôte.` : `🚪 ${p.name} a quitté la partie.`);
  if (wasFinished) return;

  const rest = room.players.filter((q) => !q.finished);
  if (p.hand.length && rest.length) {
    p.hand.forEach((c, i) => rest[i % rest.length].hand.push(c));
    addLog(room, `Ses ${p.hand.length} cartes sont réparties entre les autres joueurs.`);
  }
  p.hand = [];

  if (rest.length <= 1) { // plus assez de joueurs : fin de partie
    if (rest.length === 1) room.ranking.push(rest[0].id);
    room.phase = 'ended';
    room.winnerId = room.ranking[0] || null;
    return;
  }
  if (wasLastPlacer) {
    // celui à accuser est parti : le joueur suivant relance, le tapis reste en place
    const next = room.players[nextActiveIdx(room, idx)];
    newRoundFor(room, next);
    addLog(room, `${next.name} relance un nouveau tour avec le chiffre de son choix.`);
  } else if (wasCurrent) {
    room.turnIdx = nextActiveIdx(room, idx);
    if (allPassed(room)) endRound(room);
  } else if (allPassed(room)) {
    endRound(room);
  }
}

function act(room, p, msg) {
  if (room.phase !== 'playing') fail('La partie n\'est pas en cours.');
  const last = room.lastPlacerId ? byId(room, room.lastPlacerId) : null;
  const lastEmpty = last && last.hand.length === 0;
  if (msg.type !== 'accuse') {
    const cur = room.players[room.turnIdx];
    if (cur.id !== p.id) fail('Ce n\'est pas ton tour.');
  }

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
    room.roundCount += cards.length;
    room.lastPlay = { playerId: p.id, cards };
    room.lastPlacerId = p.id;
    room.passed = [];
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
    room.passed.push(p.id);
    addLog(room, `${p.name} passe.`);
    if (allPassed(room)) endRound(room);
    else room.turnIdx = nextActiveIdx(room, room.turnIdx);
    return;
  }

  if (msg.type === 'accuse') {
    if (p.finished) fail('Tu as déjà fini : tu ne peux plus accuser.');
    if (!room.lastPlay || !last) fail('Il n\'y a personne à accuser (quelqu\'un a peut-être accusé avant toi).');
    if (last.id === p.id) fail('Tu ne peux pas t\'accuser toi-même.');
    const cards = room.lastPlay.cards;
    const bluff = cards.some((c) => c.rank !== room.currentRank); // un joker est toujours un bluff
    const loser = bluff ? last : p;      // celui qui ramasse
    const starter = bluff ? p : last;    // celui qui NE ramasse PAS relance
    const n = room.pile.length;
    room.seq++;
    room.revealAt = Date.now();
    room.reveal = {
      seq: room.seq, played: cards.length, claimed: room.currentRank, bluff,
      accuserId: p.id, accusedId: last.id, loserId: loser.id, count: n,
    };
    addLog(room, `${p.name} accuse ${last.name} : « Tu bluffes ! »`);
    addLog(room, bluff
      ? `C'était un bluff ! ${loser.name} ramasse ${n > 1 ? `les ${n} cartes` : 'la carte'}.`
      : `Pas de bluff ! ${loser.name} ramasse ${n > 1 ? `les ${n} cartes` : 'la carte'}.`);
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
    jokers: room.jokers,
    youId: p.id,
    players: room.players.map((q) => ({ id: q.id, name: q.name, count: q.hand.length, connected: !!q.ws || !!q.bot, bot: !!q.bot, left: !!q.left, finished: !!q.finished, place: room.ranking.indexOf(q.id) + 1 || null })),
    ranking: room.ranking,
    turnId: cur ? cur.id : null,
    currentRank: room.currentRank,
    rankLabel: room.currentRank ? LABELS[room.currentRank] : null,
    pileCount: room.pile.length,
    roundCount: room.roundCount,
    lastCount: room.lastPlay ? room.lastPlay.cards.length : 0,
    discarded: room.discarded,
    lastPlacerId: room.lastPlacerId,
    skips: room.passed.length,
    hand: p.hand.slice().sort((a, b) => ORDER[a.rank] - ORDER[b.rank] || a.suit.localeCompare(b.suit)),
    can: {
      play: myTurn && p.hand.length > 0 && !lastEmpty,
      skip: myTurn && hasPile,
      accuse: playing && !p.finished && !!last && last.id !== p.id && !!room.lastPlay,
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
  scheduleBots(room);
}

/* ---------- chat ---------- */
function say(room, p, raw, isBot) {
  let text = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (!isBot) {
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter((t) => now - t < 6000);
    if (p.chatTimes.length >= 5) fail('Doucement ! Trop de messages d\'un coup.');
    p.chatTimes.push(now);
  }
  if (text.length > CHAT_MAX) text = text.slice(0, CHAT_MAX - 1).trimEnd() + '…';
  const m = { id: ++room.chatSeq, pid: p.id, name: p.name, text };
  room.chat.push(m);
  if (room.chat.length > 60) room.chat.shift();
  room.touched = Date.now();
  for (const q of room.players) send(q.ws, { type: 'chat', m });
}

/* ---------- bots ---------- */
const rnd = (n) => crypto.randomInt(n);
const chance = (p) => Math.random() < p;
const SAY = {
  accuse: ['Tu bluffes !', 'Je ne te crois pas 😏', 'Menteur !', 'Bluff !', 'Hmm… non.'],
  caught: ['Aïe 😅', 'Bien joué…', 'Raté !'],
  win: ['Facile 😎', 'GG !', 'Merci la compagnie !'],
};
const pickOne = (a) => a[rnd(a.length)];

function accuseProb(room, b) {
  const last = byId(room, room.lastPlacerId);
  const rank = room.currentRank;
  const mine = b.hand.filter((c) => c.rank === rank).length;
  const n = room.lastPlay.cards.length;
  if (last.hand.length === 0) return 0.92;           // il va gagner : il faut l'arrêter
  if (n + mine > 4) return 0.93;                     // impossible : au moins une carte fausse
  let pr = 0.05 + 0.06 * (n - 1) + 0.05 * mine;
  if (room.roundCount + mine > 4) pr += 0.25;
  if (last.hand.length <= 2) pr += 0.12;
  return Math.min(pr, 0.7);
}
function botDecide(room, b) {
  const rank = room.currentRank;
  const last = room.lastPlacerId ? byId(room, room.lastPlacerId) : null;
  const canAccuse = !!(room.lastPlay && last && last.id !== b.id);
  const canSkip = rank !== null && room.pile.length > 0;
  const hand = b.hand;
  if (canAccuse && last.hand.length === 0) return chance(0.9) ? { type: 'accuse' } : { type: 'skip' };
  if (canAccuse && chance(accuseProb(room, b))) return { type: 'accuse' };
  if (!hand.length) return canSkip ? { type: 'skip' } : null;
  const jokers = hand.filter((c) => c.rank === 'JOKER');
  const normal = hand.filter((c) => c.rank !== 'JOKER');
  const pick = (arr, n) => shuffle(arr.slice()).slice(0, n);
  const play = (cards, r) => ({ type: 'play', cardIds: cards.map((c) => c.id), rank: r });

  if (rank === null) { // à moi de lancer
    if (!normal.length) return play(jokers.slice(0, 1 + rnd(Math.min(2, jokers.length))), RANKS[rnd(13)]);
    const groups = {};
    normal.forEach((c) => { (groups[c.rank] = groups[c.rank] || []).push(c); });
    const best = Math.max(...Object.values(groups).map((g) => g.length));
    const rk = pickOne(Object.keys(groups).filter((r) => groups[r].length === best));
    const g = groups[rk];
    const take = pick(g, Math.min(MAX_PER_TURN, 1 + rnd(g.length)));
    if (jokers.length && take.length < MAX_PER_TURN && chance(0.7)) take.push(jokers[0]);
    return play(take, rk);
  }
  const real = normal.filter((c) => c.rank === rank);
  if (real.length) {
    const k = real.length >= 3 && chance(0.6) ? real.length : 1 + rnd(real.length);
    const take = pick(real, Math.min(MAX_PER_TURN, k));
    if (jokers.length && take.length < MAX_PER_TURN && chance(0.5)) take.push(jokers[0]);
    return play(take, rank);
  }
  let bluffP = hand.length <= 3 ? 0.85 : 0.4;
  if (jokers.length) bluffP = 0.85;
  if (room.roundCount >= 6) bluffP -= 0.2;
  if (!canSkip) bluffP = 1;
  if (chance(bluffP)) {
    const n = Math.min(MAX_PER_TURN, hand.length >= 6 && chance(0.25) ? 2 : 1);
    let take = jokers.slice(0, n);
    if (take.length < n) take = take.concat(pick(normal, n - take.length));
    return play(take, rank);
  }
  return { type: 'skip' };
}
function botAct(room, b, msg) {
  act(room, b, msg);
  if (msg.type === 'accuse' && chance(0.35)) say(room, b, pickOne(SAY.accuse), true);
  if (room.phase === 'ended' && room.winnerId === b.id && chance(0.6)) say(room, b, pickOne(SAY.win), true);
  broadcast(room);
}
function botTurn(room, b) {
  if (room.phase !== 'playing' || room.players[room.turnIdx] !== b || b.finished) return;
  try { botAct(room, b, botDecide(room, b) || { type: 'skip' }); }
  catch (e) {
    if (!(e instanceof GameError)) console.error(e);
    try { botAct(room, b, { type: 'skip' }); } catch (e2) { broadcast(room); }
  }
}
function botAccuse(room, b) {
  if (room.phase !== 'playing' || b.finished || !room.lastPlay || room.lastPlacerId === b.id) return;
  try { botAct(room, b, { type: 'accuse' }); } catch (e) { if (!(e instanceof GameError)) console.error(e); broadcast(room); }
}
function scheduleBots(room) {
  clearTimeout(room.botTimer);
  room.botTimer = null;
  const ver = ++room.ver;
  if (room.phase !== 'playing') return;
  if (!room.players.some((p) => !p.bot && p.ws)) return;   // plus personne ne regarde : on met en pause
  const cur = room.players[room.turnIdx];
  const events = [];
  if (cur && cur.bot && !cur.finished) events.push({ d: 1100 + rnd(1500), fn: () => botTurn(room, cur) });
  if (room.lastPlay) {
    for (const b of room.players) {
      if (!b.bot || b.finished || b === cur || b.id === room.lastPlacerId) continue;
      if (chance(accuseProb(room, b))) events.push({ d: 1600 + rnd(2600), fn: () => botAccuse(room, b) });
    }
  }
  if (!events.length) return;
  events.sort((a, b) => a.d - b.d);
  const ev = events[0];
  // on laisse le temps de voir le verdict d'une accusation avant que les bots rejouent
  const wait = Math.max(0, room.revealAt + 4000 - Date.now());
  room.botTimer = setTimeout(() => { if (room.ver === ver) ev.fn(); }, (ev.d + wait) / BOT_SPEED);
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
    send(ws, { type: 'chat_history', msgs: room.chat });
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
    send(ws, { type: 'chat_history', msgs: room.chat });
    return broadcast(room);
  }
  if (msg.type === 'rejoin') {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const p = room && room.players.find((q) => q.id === msg.playerId);
    if (!p || p.left || p.bot) return send(ws, { type: 'rejoin_failed' });
    attach(ws, room, p);
    send(ws, { type: 'joined', playerId: p.id, code: room.code, name: p.name });
    send(ws, { type: 'chat_history', msgs: room.chat });
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
    case 'chat':
      say(room, p, msg.text, false);
      return;
    case 'set_jokers':
      if (room.hostId !== p.id) fail('Seul l\'hôte peut changer cette option.');
      if (room.phase !== 'lobby') fail('Les options se règlent avant le début de la partie.');
      room.jokers = !!msg.value;
      break;
    case 'add_bot':
      if (room.hostId !== p.id) fail('Seul l\'hôte peut ajouter un bot.');
      if (room.phase !== 'lobby') fail('Les bots s\'ajoutent avant le début de la partie.');
      if (room.players.length >= MAX_PLAYERS) fail('Le salon est plein.');
      addBot(room, msg.name);
      break;
    case 'rename_bot': {
      if (room.hostId !== p.id) fail('Seul l\'hôte peut renommer un bot.');
      if (room.phase !== 'lobby') fail('Les bots se renomment avant le début de la partie.');
      const t = byId(room, msg.playerId);
      if (!t || !t.bot) fail('Bot introuvable.');
      if (!String(msg.name || '').trim()) fail('Donne un nom au bot.');
      t.name = botName(room, msg.name, t.id);
      break;
    }
    case 'kick': {
      if (room.hostId !== p.id) fail('Seul l\'hôte peut expulser un joueur.');
      const t = byId(room, msg.playerId);
      if (!t) fail('Joueur introuvable.');
      if (t.id === p.id) fail('Tu ne peux pas t\'expulser toi-même (utilise Quitter).');
      if (t.left) fail('Ce joueur est déjà parti.');
      if (t.ws) { send(t.ws, { type: 'kicked' }); t.ws.ctx = null; t.ws = null; }
      clearTimeout(t.dropTimer);
      if (room.phase === 'lobby') return removePlayer(room, t.id);
      if (room.phase === 'playing') leaveMidGame(room, t, true);
      else t.left = true;
      break;
    }
    case 'leave':
      ws.ctx = null;
      p.ws = null;
      clearTimeout(p.dropTimer);
      if (room.phase === 'lobby') removePlayer(room, p.id);
      else {
        if (room.phase === 'playing') leaveMidGame(room, p);
        else p.left = true;
        if (room.hostId === p.id) {
          const h = room.players.find((q) => q.ws && !q.left);
          if (h) room.hostId = h.id;
        }
        if (room.players.every((q) => q.left || q.bot)) deleteRoom(room);
        else broadcast(room);
      }
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
  if (url === '/version') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end(VERSION); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
    if (now - room.touched > 3 * 3600 * 1000 && !room.players.some((p) => p.ws)) deleteRoom(room);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Tu bluffes ! → http://localhost:${PORT}`));
