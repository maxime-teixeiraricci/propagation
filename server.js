// Propagation : serveur de parties. Aucune dépendance, Node 18+ : `node server.js`
//
// Le serveur est l'arbitre : il connaît les comptes, vérifie chaque coup, surveille les délais des parties
// longues et calcule l'Élo. La page n'a qu'à afficher et animer.
//
// Stockage (au choix, par variables d'environnement) :
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN : base gratuite chez Upstash (recommandé en ligne)
//   DATA_DIR                                          : un dossier où écrire data.json (PC, ou disque persistant)
//   rien                                              : en local, les données vont dans le dossier ./data (conservées d'un redémarrage à l'autre) ;
//                                                       sur Render (disque effacé) ou en test, tout reste en mémoire
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine.js');
const Bot = require('./bot.js');

const PORT = process.env.PORT || 3000;
const TEST = process.env.PROPAGATION_TEST === '1';          // autorise des délais très courts (tests)
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
// En local, on garde les comptes et l'Élo dans ./data par défaut. Sur Render le disque gratuit est effacé : on ne fait pas semblant.
const DATA_DIR = process.env.DATA_DIR || (TEST || process.env.RENDER || (UP_URL && UP_TOKEN) ? '' : path.join(__dirname, 'data'));
const STORAGE = UP_URL && UP_TOKEN ? 'upstash' : DATA_DIR ? 'file' : 'memory';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PID_RE = /^[A-HJ-NP-Z2-9]{10}$/, SECRET_RE = /^[A-HJ-NP-Z2-9]{20}$/, CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const MAX_FRAME = 64 * 1024;
const KICK_LIVE_MS = Number(process.env.KICK_LIVE_MS) || 45 * 1000;   // partie rapide : un absent peut être éliminé après 45 s
const GRACE_MS = Number(process.env.GRACE_MS) || 30 * 60 * 1000;      // répit après un redémarrage du serveur
const DAY = 24 * 3600 * 1000;
const TURN_CHOICES_H = [12, 24, 48, 72];
const START_ELO = 1000, K_FACTOR = 32, MIN_ELO = 100;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/maxime-teixeiraricci/propagation';
const MAX_PUSH_PER_PLAYER = 5;
const BOT_FAST = TEST && process.env.BOT_FAST === '1';        // essais : les IA jouent presque tout de suite
const MAX_ACTIVE_PER_PLAYER = 12, MAX_GAMES = 4000, MAX_PLAYERS = 20000;

const players = new Map();   // pid -> { pid, h, name, elo, games, wins, created }
const games = new Map();     // code -> partie
const clients = new Set();
const meta = new Map();      // 'vapid' -> { jwk }

class Err extends Error { constructor(code) { super(code); this.code = code; } }
const rnd = k => crypto.randomInt(k);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ======================= stockage ======================= */
const dirty = new Set();          // 'g:CODE' ou 'p:PID'
let flushTimer = null, flushing = false, lastSaveOk = true, lastSaveError = '', loadOk = true;

async function up(cmd) {
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Upstash : ' + (j.error || r.status));
  return j.result;
}
async function loadAll() {
  if (STORAGE === 'file') {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data.json'), 'utf8'));
      (snap.players || []).forEach(p => players.set(p.pid, p));
      (snap.games || []).forEach(g => games.set(g.code, g));
      Object.entries(snap.meta || {}).forEach(([k, v]) => meta.set(k, v));
    } catch (e) { if (e.code !== 'ENOENT') { loadOk = false; log('lecture data.json impossible :', e.message); } }
  } else if (STORAGE === 'upstash') {
    try {
      const keys = [];
      let cursor = '0';
      do {
        const r = await up(['SCAN', cursor, 'MATCH', 'propagation:*', 'COUNT', '500']);
        cursor = String(r[0]); keys.push(...r[1]);
      } while (cursor !== '0');
      for (let i = 0; i < keys.length; i += 50) {
        const part = keys.slice(i, i + 50);
        const vals = await up(['MGET', ...part]);
        part.forEach((k, j) => {
          if (!vals[j]) return;
          const o = JSON.parse(vals[j]);
          if (k.startsWith('propagation:g:')) games.set(o.code, o); else if (k.startsWith('propagation:p:')) players.set(o.pid, o); else if (k.startsWith('propagation:m:')) meta.set(k.slice(14), o);
        });
      }
    } catch (e) { loadOk = false; lastSaveOk = false; lastSaveError = String(e.message || e); log('chargement Upstash impossible :', lastSaveError); }
  }
  log(`stockage : ${STORAGE}${loadOk ? '' : ' (ERREUR)'} · ${players.size} joueurs, ${games.size} parties chargés`);
}
function scheduleFlush(ms) { if (STORAGE === 'memory' || flushTimer) return; flushTimer = setTimeout(flush, ms || 800); }
function markG(g) { dirty.add('g:' + g.code); scheduleFlush(); }
function markP(pid) { dirty.add('p:' + pid); scheduleFlush(); }
function dropGame(code) { games.delete(code); dirty.add('g:' + code); scheduleFlush(); }
async function flush() {
  flushTimer = null;
  if (STORAGE === 'memory' || !dirty.size) return;
  if (flushing) { scheduleFlush(1500); return; }
  flushing = true;
  const batch = [...dirty]; dirty.clear();
  try {
    if (STORAGE === 'file') {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const f = path.join(DATA_DIR, 'data.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify({ players: [...players.values()], games: [...games.values()], meta: Object.fromEntries(meta) }));
      fs.renameSync(f + '.tmp', f);
    } else {
      for (const k of batch) {
        const id = k.slice(2), obj = k[0] === 'g' ? games.get(id) : k[0] === 'p' ? players.get(id) : meta.get(id);
        if (obj) await up(['SET', 'propagation:' + k, JSON.stringify(obj)]); else await up(['DEL', 'propagation:' + k]);
      }
    }
    lastSaveOk = true; lastSaveError = '';
  } catch (e) {
    lastSaveOk = false; lastSaveError = String(e.message || e); log('sauvegarde impossible :', lastSaveError);
    batch.forEach(k => dirty.add(k));
  } finally {
    flushing = false;
    if (dirty.size) scheduleFlush(lastSaveOk ? 800 : 5000);
  }
}
const durable = () => (STORAGE === 'upstash' || STORAGE === 'file') && loadOk && lastSaveOk;

/* ======================= parties ======================= */
const cellsOf = (g, s) => { let k = 0; for (let i = 0; i < g.c.length; i++) if (g.c[i] > 0 && g.o[i] === s) k++; return k; };
const aliveSeats = g => { const r = []; for (let s = 0; s < g.np; s++) if (g.players[s] && cellsOf(g, s) > 0) r.push(s); return r; };
const teamOf = (g, s) => (g.teams ? s % g.teams : s);
const teamArr = g => (g.teams ? Array.from({ length: g.np }, (_, s) => s % g.teams) : null);
const hostOf = g => (g.host && g.players.includes(g.host) ? g.host : g.players.find(p => p && !isBot(p)) || null);
function startTurnClock(g) {
  g.turnAt = Date.now();
  g.deadline = g.mode === 'long' ? g.turnAt + g.turnMs : null;
}
function startPlaying(g) { g.status = 'playing'; startTurnClock(g); }
function updateElim(g) {
  const done = new Set(g.elim.flat());
  const grp = [];
  for (let s = 0; s < g.np; s++) if (g.players[s] && !done.has(s) && cellsOf(g, s) === 0) grp.push(s);
  if (grp.length) g.elim.push(grp);
}
// Rang de chaque équipe : une équipe est battue quand son dernier joueur est éliminé ; celle qui reste est première.
function teamRanks(g) {
  const idx = new Map(); g.elim.forEach((grp, gi) => grp.forEach(x => idx.set(x, gi)));
  const key = [];
  for (let t = 0; t < g.teams; t++) {
    let k = -1, alive = false;
    for (let x = t; x < g.np; x += g.teams) { if (idx.has(x)) k = Math.max(k, idx.get(x)); else alive = true; }
    key.push(alive ? Infinity : k);
  }
  return key.map(k => 1 + key.filter(o => o > k).length);
}
function finish(g) {
  if (g.status === 'done') return;
  g.status = 'done'; g.deadline = null;
  const T = g.teams || 0;
  const tr = T ? teamRanks(g) : null;
  const ranks = T ? Array.from({ length: g.np }, (_, x) => tr[x % T]) : E.ranksFrom(g.np, g.winner, g.elim);
  const res = { ranks, ranked: false, before: null, after: null, delta: null };
  if (g.ranked && g.np >= 2 && g.players.every(Boolean) && new Set(g.players).size === g.np) {
    const ws = g.players.map(who);
    if (ws.every(Boolean) && ws.some(x => !x.bot)) {
      const before = ws.map(x => x.elo);
      let delta;
      if (T) {                                   // par équipes : Élo moyen de chaque équipe, même variation pour tous ses joueurs
        const avg = Array.from({ length: T }, (_, t) => { const m = before.filter((_, x) => x % T === t); return m.reduce((a, b) => a + b, 0) / m.length; });
        const d = E.eloDeltas(avg, tr, K_FACTOR);
        delta = before.map((_, x) => d[x % T]);
      } else delta = E.eloDeltas(before, ranks, K_FACTOR);
      const after = before.slice();
      ws.forEach((x, i) => {                    // les IA gardent leur Élo fixe ; seuls les humains bougent
        if (x.bot) return;
        const p = x.p;
        p.elo = Math.max(MIN_ELO, before[i] + delta[i]); p.games++;
        if (T ? tr[i % T] === 1 : g.winner === i) p.wins++;
        after[i] = p.elo; markP(p.pid);
      });
      res.ranked = true; res.before = before; res.after = after; res.delta = after.map((a, i) => a - before[i]);
    }
  }
  g.result = res;
  for (const pid of g.players) if (pid) pushProfile(pid);
}
/* ======================= joueurs IA ======================= */
// Un siège d'IA est repéré par un identifiant « bot:NIVEAU:SIÈGE » (impossible à confondre avec un compte).
const isBot = pid => typeof pid === 'string' && pid.startsWith('bot:');
const botLevel = pid => Number(pid.split(':')[1]) || 3;
function who(pid) {              // nom et Élo d'un siège, humain ou IA
  if (!pid) return null;
  if (isBot(pid)) { const l = Bot.byLevel(botLevel(pid)); return { name: 'IA ' + l.name, elo: l.elo, bot: true }; }
  const p = players.get(pid);
  return p ? { name: p.name, elo: p.elo, bot: false, p } : null;
}
const botTimers = new Map();
function scheduleBot(g) {
  if (g.status !== 'playing' || botTimers.has(g.code)) return;
  const pid = g.players[g.turn];
  if (!isBot(pid)) return;
  const seq = g.seq;
  // l'IA attend la fin de l'animation du coup précédent, pour que la partie reste lisible
  const wait = BOT_FAST ? 25 : Math.max(g.last ? 700 : 1300, g.botWait || 0);
  botTimers.set(g.code, setTimeout(() => { botTimers.delete(g.code); runBot(g.code, seq); }, wait));
}
function runBot(code, seq) {
  const g = games.get(code);
  if (!g || g.status !== 'playing' || g.seq !== seq || !isBot(g.players[g.turn])) return;
  try {
    const seat = g.turn;
    let i = Bot.choose(botLevel(g.players[seat]), { n: g.n, o: g.o, c: g.c, dead: g.dead || 0 }, seat, g.np, Math.random, null, g.teams || 0);
    if (!(Number.isInteger(i) && i >= 0 && i < g.c.length && g.o[i] === seat && g.c[i] > 0)) {    // garde-fou : coup toujours légal
      const own = []; for (let k = 0; k < g.c.length; k++) if (g.o[k] === seat && g.c[k] > 0) own.push(k);
      if (!own.length) return;
      i = own[rnd(own.length)];
    }
    applyMove(g, seat, i); pushGame(g);
  } catch (e) { console.error('IA :', e); }
}

// Après un changement de plateau : éliminations, victoire éventuelle, joueur suivant.
function settle(g, opt) {
  updateElim(g);
  const alive = aliveSeats(g);
  g.seq++; g.updated = Date.now();
  const aliveTeams = new Set(alive.map(x => teamOf(g, x)));
  const botsOnly = g.players.some(isBot) && aliveTeams.size > 1 && !alive.some(x => !isBot(g.players[x]));
  if (aliveTeams.size <= 1) {
    g.winner = alive.length ? alive[0] : -1;
    if (g.winner >= 0) g.turn = g.winner;
    finish(g);
  } else if (botsOnly) {                       // plus aucun humain en jeu : la partie s'arrête, les équipes (ou IA) restantes sont départagées au score
    const val = x => { let v = 0; for (let k = 0; k < g.c.length; k++) if (g.o[k] === x && g.c[k] > 0) v += 3 + g.c[k]; return v; };
    const tv = new Map(); alive.forEach(x => tv.set(teamOf(g, x), (tv.get(teamOf(g, x)) || 0) + val(x)));
    const bestTeam = [...tv].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const win = alive.find(x => teamOf(g, x) === bestTeam);
    g.elim.push(alive.filter(x => teamOf(g, x) !== bestTeam));
    g.winner = win; g.turn = win;
    finish(g);
  } else if (opt.advance) {
    g.turn = E.nextTurn(g.o, g.c, opt.from, g.np);
    startTurnClock(g);
  } else if (!alive.includes(g.turn)) {
    g.turn = E.nextTurn(g.o, g.c, g.turn, g.np);
    startTurnClock(g);
  }
  markG(g);
}
function applyMove(g, seat, i) {
  const r = E.step({ n: g.n, o: g.o, c: g.c, np: g.np, dead: g.dead || 0 }, i, seat, teamArr(g), !!g.sudden, g.round || 0);
  g.o = r.o; g.c = r.c; g.dead = r.dead; g.round = r.round; g.last = { i, p: seat };
  g.botWait = Math.min(6000, 450 + 380 * (r.frames.length - 1));      // durée de l'animation chez le joueur
  settle(g, { from: seat, advance: true });
}
function eliminate(g, seat) {              // abandon, absence ou délai dépassé
  for (let i = 0; i < g.c.length; i++) if (g.o[i] === seat) { g.o[i] = -1; g.c[i] = 0; }
  g.last = null;
  settle(g, { from: seat, advance: seat === g.turn });
}
function resetBoard(g, np) {
  const b = E.newBoard(g.n, np, rnd(np));
  g.np = np; g.o = b.o; g.c = b.c; g.dead = 0; g.round = 0; if (np <= 4) g.sudden = false; g.turn = rnd(np); g.last = null; g.winner = -1; g.elim = []; g.result = null;
}
function joinSeat(g, pid) {
  let idx = g.players.indexOf(pid);
  if (idx >= 0) return idx;
  if (g.status !== 'waiting') return -1;
  idx = g.players.indexOf(null);
  if (idx < 0) for (let k = g.players.length - 1; k >= 0; k--) if (isBot(g.players[k])) { idx = k; break; }   // une place tenue par une IA est cédée
  if (idx < 0) return -1;
  if (activeCount(pid) >= MAX_ACTIVE_PER_PLAYER) throw new Err('too_many');
  g.players[idx] = pid; g.updated = Date.now();
  markG(g);
  return idx;
}
const activeCount = pid => { let k = 0; for (const g of games.values()) if (g.status !== 'done' && g.players.includes(pid)) k++; return k; };

function viewFor(g, pid) {
  return {
    code: g.code, n: g.n, np: g.np, mode: g.mode, turnMs: g.turnMs, ranked: g.ranked, ai: g.ai || 0, status: g.status,
    o: g.o, c: g.c, turn: g.turn, seq: g.seq, last: g.last, winner: g.winner,
    teams: g.teams || 0, host: g.players.indexOf(hostOf(g)), sudden: !!g.sudden, dead: g.dead || 0, round: g.round || 0,
    seats: g.players.map((p, x) => { const w = who(p); return { filled: !!p, name: w ? w.name : '', rating: w ? w.elo : null, bot: !!(w && w.bot), team: g.teams ? x % g.teams : -1 }; }),
    me: g.players.indexOf(pid), turnAt: g.turnAt, deadline: g.deadline, elim: g.elim, result: g.result
  };
}
function summary(g, pid) {
  const me = g.players.indexOf(pid);
  return {
    code: g.code, n: g.n, np: g.np, mode: g.mode, turnMs: g.turnMs, ranked: g.ranked, ai: g.ai || 0, status: g.status, me,
    turn: g.turn, winner: g.winner, deadline: g.deadline, updated: g.updated,
    names: g.players.map(p => { const w = who(p); return w ? w.name : ''; }),
    filled: g.players.filter(Boolean).length, humans: g.players.filter(p => p && !isBot(p)).length, teams: g.teams || 0,
    result: g.result && me >= 0 ? { rank: g.result.ranks[me], delta: g.result.delta ? g.result.delta[me] : null, ranked: g.result.ranked } : null
  };
}

/* ======================= notifications (Web Push) ======================= */
// Notification sans contenu : le navigateur reçoit un simple signal, et son service worker demande
// ensuite au serveur (/api/due) quelles parties attendent le joueur. Pas de chiffrement de message nécessaire.
let vapid = null;
function ensureVapid() {
  let m = meta.get('vapid');
  const make = () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    m = { jwk: privateKey.export({ format: 'jwk' }) };
    meta.set('vapid', m); dirty.add('m:vapid'); scheduleFlush();
  };
  if (!m) make();
  let key;
  try { key = crypto.createPrivateKey({ key: m.jwk, format: 'jwk' }); } catch (e) { make(); key = crypto.createPrivateKey({ key: m.jwk, format: 'jwk' }); }
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(m.jwk.x, 'base64url'), Buffer.from(m.jwk.y, 'base64url')]).toString('base64url');
  vapid = { key, pub };
}
const PUSH_HOST = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
function pushUrlOk(s) {            // seuls les services de notification des navigateurs sont acceptés
  if (typeof s !== 'string' || s.length > 700) return false;
  let u; try { u = new URL(s); } catch (e) { return false; }
  if (u.username || u.password) return false;
  if (TEST && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
  return u.protocol === 'https:' && !u.port && PUSH_HOST.test(u.hostname);
}
function webPush(endpoint, ttl) {
  return new Promise(resolve => {
    try {
      const u = new URL(endpoint), exp = Math.floor(Date.now() / 1000) + 12 * 3600;
      const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = b({ typ: 'JWT', alg: 'ES256' }) + '.' + b({ aud: u.origin, exp, sub: VAPID_SUBJECT });
      const sig = crypto.sign('sha256', Buffer.from(head), { key: vapid.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const req = (u.protocol === 'http:' ? http : https).request(u, {
        method: 'POST', timeout: 10000,
        headers: { Authorization: `vapid t=${head}.${sig}, k=${vapid.pub}`, TTL: String(ttl), Urgency: 'high', 'Content-Length': '0' }
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve(0)); req.end();
    } catch (e) { resolve(0); }
  });
}
async function notifyPid(pid, ttl) {
  const p = players.get(pid);
  if (!p || !p.push || !p.push.length || !vapid) return;
  for (const s of [...p.push]) {
    const st = await webPush(s.endpoint, ttl);
    if (st === 404 || st === 410) { p.push = p.push.filter(x => x !== s); markP(pid); }
    else if (st < 200 || st >= 300) log(`notification refusée (${st}) pour ${pid}`);
  }
}
// Le joueur regarde déjà cette partie sur une page visible : inutile de le notifier.
const playerHere = (pid, code) => { for (const c of clients) if (c.pid === pid && c.subs.has(code) && c.visible !== false) return true; return false; };
function notifyTurn(g) {
  if (g.status !== 'playing' || g.notifiedAt === g.turnAt) return;
  g.notifiedAt = g.turnAt;
  const pid = g.players[g.turn];
  if (pid && !isBot(pid) && !playerHere(pid, g.code)) notifyPid(pid, g.mode === 'long' ? 86400 : 600).catch(() => {});
}
function remindTurns(now) {        // partie longue : rappel quand il reste peu de temps (3 h, ou 1/4 du délai si plus court)
  for (const g of games.values()) {
    if (g.status !== 'playing' || g.mode !== 'long' || !g.deadline || g.remindedAt === g.turnAt) continue;
    if (now < g.deadline - Math.min(3 * 3600 * 1000, g.turnMs / 4)) continue;
    g.remindedAt = g.turnAt; markG(g);
    const pid = g.players[g.turn];
    if (pid && !playerHere(pid, g.code)) notifyPid(pid, 3600).catch(() => {});
  }
}
function dueFor(endpoint) {
  const now = Date.now();
  if (typeof endpoint !== 'string') return [];
  for (const p of players.values()) {
    if (!p.push || !p.push.some(s => s.endpoint === endpoint)) continue;
    const list = [];
    for (const g of games.values()) if (g.status === 'playing' && g.players[g.turn] === p.pid) list.push({ code: g.code, mode: g.mode, np: g.np, left: g.deadline ? Math.max(0, g.deadline - now) : null });
    return list.sort((a, b) => (a.left == null) - (b.left == null) || a.left - b.left);
  }
  return [];
}

/* ======================= connexions ======================= */
const prof = p => ({ name: p.name, elo: p.elo, games: p.games, wins: p.wins });
function send(c, obj) { sendRaw(c, 1, Buffer.from(JSON.stringify(obj))); }
function pushGame(g) {
  for (const c of clients) if (c.pid && c.subs.has(g.code)) send(c, { t: 'game', code: g.code, g: viewFor(g, c.pid), now: Date.now() });
  notifyTurn(g);
  scheduleBot(g);
}
function pushProfile(pid) {
  const p = players.get(pid); if (!p) return;
  for (const c of clients) if (c.pid === pid) send(c, { t: 'profile', profile: prof(p) });
}

function lobbyOf(c, m) {                           // la salle d'attente de c, dont c est le créateur
  const g = games.get(String(m.code || '').toUpperCase());
  if (!g) throw new Err('not_found');
  if (g.status !== 'waiting' || hostOf(g) !== c.pid) throw new Err('forbidden');
  return g;
}

const OPS = {
  hello(c, m) {
    const pid = String(m.pid || ''), secret = String(m.secret || '');
    if (!PID_RE.test(pid) || !SECRET_RE.test(secret)) throw new Err('auth');
    const h = sha(pid + ':' + secret);
    let p = players.get(pid);
    if (p) { if (!safeEq(p.h, h)) throw new Err('auth'); }
    else {
      if (players.size >= MAX_PLAYERS) throw new Err('full');
      p = { pid, h, name: clean(m.name) || 'Joueur ' + pid.slice(0, 4), elo: START_ELO, games: 0, wins: 0, created: Date.now() };
      players.set(pid, p); markP(pid);
    }
    c.pid = pid;
    return { profile: prof(p), features: { durable: durable(), storage: STORAGE, test: TEST, turnChoicesH: TURN_CHOICES_H, vapid: vapid ? vapid.pub : null, bots: Bot.LEVELS } };
  },
  name(c, m) {
    const nm = clean(m.name); if (!nm) throw new Err('invalid');
    const p = players.get(c.pid); p.name = nm; markP(p.pid);
    for (const g of games.values()) if (g.players.includes(c.pid)) pushGame(g);
    return { profile: prof(p) };
  },
  create(c, m) {
    const np = Number(m.np);
    if (![2, 4, 6, 8].includes(np)) throw new Err('invalid');
    const sizes = E.SIZES[np], n = sizes.slice(0, 3).includes(Number(m.n)) ? Number(m.n) : sizes[3];
    const ai = m.ai && typeof m.ai === 'object' ? Math.min(Bot.LEVELS.length, Math.max(1, Math.floor(Number(m.ai.level)) || 3)) : 0;
    const mode = !ai && m.mode === 'long' ? 'long' : 'live';        // contre l'IA : toujours en direct, sans délai
    let turnMs = 0;
    if (mode === 'long') {
      const h = Number(m.hours);
      turnMs = TURN_CHOICES_H.includes(h) ? h * 3600 * 1000 : 24 * 3600 * 1000;
      if (TEST && Number(m.turnMs) >= 300) turnMs = Math.min(Number(m.turnMs), 7 * DAY);
    }
    if (activeCount(c.pid) >= MAX_ACTIVE_PER_PLAYER) throw new Err('too_many');
    if (games.size >= MAX_GAMES) throw new Err('full');
    let code = '';
    for (let t = 0; t < 50; t++) { let s = ''; for (let i = 0; i < 4; i++) s += ALPHABET[rnd(ALPHABET.length)]; if (!games.has(s)) { code = s; break; } }
    if (!code) throw new Err('full');
    const b = E.newBoard(n, np, rnd(np)), now = Date.now();
    const g = { code, n, np, mode, turnMs, ranked: m.ranked !== false, status: 'waiting', players: new Array(np).fill(null),
      o: b.o, c: b.c, turn: rnd(np), seq: 0, last: null, winner: -1, elim: [], result: null, turnAt: null, deadline: null, created: now, updated: now, host: c.pid, teams: 0,
      sudden: np > 4 && !!m.sudden, dead: 0, round: 0 };
    g.players[0] = c.pid;
    if (ai) { g.ai = ai; for (let k = 1; k < np; k++) g.players[k] = `bot:${ai}:${k}`; startPlaying(g); }
    games.set(code, g); markG(g);
    if (ai) scheduleBot(g);
    return { code };
  },
  join(c, m) {
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    const before = g.players.indexOf(c.pid);
    const idx = joinSeat(g, c.pid);
    if (idx >= 0) c.subs.add(g.code);               // rejoindre = regarder la partie (évite une notification inutile)
    if (idx !== before) pushGame(g);
    return { idx };
  },
  sub(c, m) {
    const code = String(m.code || '').toUpperCase();
    if (!CODE_RE.test(code)) throw new Err('invalid');
    c.subs.add(code);
    const g = games.get(code);
    send(c, { t: 'game', code, g: g ? viewFor(g, c.pid) : null, now: Date.now() });
    return {};
  },
  unsub(c, m) { c.subs.delete(String(m.code || '').toUpperCase()); return {}; },
  move(c, m) {
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    if (g.status !== 'playing') throw new Err('not_playing');
    const seat = g.players.indexOf(c.pid), i = m.i;
    if (seat < 0 || seat !== g.turn) throw new Err('not_your_turn');
    if (!Number.isInteger(i) || i < 0 || i >= g.n * g.n || g.o[i] !== seat || g.c[i] <= 0) throw new Err('invalid_move');
    applyMove(g, seat, i);
    pushGame(g);
    return {};
  },
  start(c, m) {                                   // le créateur de la salle lance la partie
    const g = lobbyOf(c, m);
    const filled = g.players.filter(Boolean);
    if (filled.length < 2) throw new Err('not_enough');
    if (g.teams && filled.length < g.np) throw new Err('not_full');      // en équipes, toutes les places doivent être prises
    if (filled.length < g.np) {                                           // sans équipes : les places vides sont retirées
      g.players = filled;
      const sizes = E.SIZES[filled.length];
      if (sizes && !sizes.slice(0, 3).includes(g.n)) g.n = sizes[3];
    }
    const bot = g.players.find(isBot);
    g.ai = bot ? botLevel(bot) : 0;
    resetBoard(g, g.players.length);
    g.seq++; g.updated = Date.now();
    startPlaying(g); markG(g); pushGame(g);
    return {};
  },
  cfg(c, m) {                                     // réglages de la salle (créateur)
    const g = lobbyOf(c, m);
    if (m.np !== undefined) {
      const np = Number(m.np);
      if (![2, 4, 6, 8].includes(np)) throw new Err('invalid');
      if (np < g.players.length) {
        const keep = g.players.slice(0, np), out = g.players.slice(np).filter(p => p && !isBot(p));
        for (const h of out) { const k = keep.findIndex(p => !p || isBot(p)); if (k < 0) throw new Err('too_many_players'); keep[k] = h; }
        g.players = keep;
      } else while (g.players.length < np) g.players.push(null);
      g.np = np;
      const sizes = E.SIZES[np];
      if (!sizes.slice(0, 3).includes(g.n)) g.n = sizes[3];
      if (g.teams && (np % g.teams || np / g.teams < 2)) g.teams = 0;
    }
    if (m.n !== undefined) { const sizes = E.SIZES[g.np]; if (!sizes.slice(0, 3).includes(Number(m.n))) throw new Err('invalid'); g.n = Number(m.n); }
    if (m.teams !== undefined) {
      const T = Number(m.teams);
      if (T !== 0 && !(T >= 2 && T <= 4 && g.np % T === 0 && g.np / T >= 2)) throw new Err('invalid');
      g.teams = T;
    }
    if (m.mode !== undefined) {
      g.mode = m.mode === 'long' ? 'long' : 'live';
      if (g.mode === 'long') {
        const h = Number(m.hours);
        g.turnMs = TURN_CHOICES_H.includes(h) ? h * 3600 * 1000 : (g.turnMs || 24 * 3600 * 1000);
        if (TEST && Number(m.turnMs) >= 300) g.turnMs = Math.min(Number(m.turnMs), 7 * DAY);
      } else g.turnMs = 0;
    }
    if (m.ranked !== undefined) g.ranked = !!m.ranked;
    if (m.sudden !== undefined) g.sudden = !!m.sudden;
    if (g.np <= 4) g.sudden = false;                  // la mort subite n'existe qu'à 6 et 8 joueurs
    g.updated = Date.now(); markG(g); pushGame(g);
    return {};
  },
  seatai(c, m) {                                  // met, change ou retire une IA sur une place (créateur)
    const g = lobbyOf(c, m);
    const seat = Number(m.seat), level = Math.floor(Number(m.level));
    if (!Number.isInteger(seat) || seat < 0 || seat >= g.np || !(level >= 0 && level <= Bot.LEVELS.length)) throw new Err('invalid');
    const cur = g.players[seat];
    if (cur && !isBot(cur)) throw new Err('forbidden');
    g.players[seat] = level ? `bot:${level}:${seat}` : null;
    g.updated = Date.now(); markG(g); pushGame(g);
    return {};
  },
  fill(c, m) {                                    // complète les places libres avec des IA (créateur)
    const g = lobbyOf(c, m);
    const level = Math.min(Bot.LEVELS.length, Math.max(1, Math.floor(Number(m.level)) || 4));
    for (let x = 0; x < g.np; x++) if (!g.players[x]) g.players[x] = `bot:${level}:${x}`;
    g.updated = Date.now(); markG(g); pushGame(g);
    return {};
  },
  kickseat(c, m) {                                // retire un joueur de la salle (créateur)
    const g = lobbyOf(c, m);
    const seat = Number(m.seat), p = g.players[seat];
    if (!p || isBot(p) || p === c.pid) throw new Err('forbidden');
    g.players[seat] = null; g.updated = Date.now(); markG(g); pushGame(g);
    return {};
  },
  sit(c, m) {                                     // change de place dans la salle (vers une place libre ou tenue par une IA)
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    const from = g.players.indexOf(c.pid), to = Number(m.seat);
    if (g.status !== 'waiting' || from < 0 || !Number.isInteger(to) || to < 0 || to >= g.np) throw new Err('forbidden');
    const cur = g.players[to];
    if (cur && !isBot(cur)) throw new Err('forbidden');
    g.players[from] = null; g.players[to] = c.pid;
    g.updated = Date.now(); markG(g); pushGame(g);
    return {};
  },
  leave(c, m) {                                   // quitter la salle
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    const seat = g.players.indexOf(c.pid);
    if (g.status !== 'waiting' || seat < 0) throw new Err('forbidden');
    g.players[seat] = null;
    if (!g.players.some(p => p && !isBot(p))) { dropGame(g.code); for (const cl of clients) cl.subs.delete(g.code); return {}; }
    if (g.host === c.pid) g.host = g.players.find(p => p && !isBot(p));
    g.updated = Date.now(); markG(g); pushGame(g);
    c.subs.delete(g.code);
    return {};
  },
  rematch(c, m) {
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    if (g.status !== 'done' || !g.players.includes(c.pid)) throw new Err('forbidden');
    resetBoard(g, g.np);
    g.seq++; g.updated = Date.now();
    startPlaying(g); markG(g); pushGame(g);
    return {};
  },
  resign(c, m) {
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    const seat = g.players.indexOf(c.pid);
    if (g.status !== 'playing' || seat < 0 || cellsOf(g, seat) === 0) throw new Err('forbidden');
    eliminate(g, seat); pushGame(g);
    return {};
  },
  kick(c, m) {                                    // partie rapide : éliminer un joueur qui ne répond plus
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    const seat = g.players.indexOf(c.pid);
    if (g.status !== 'playing' || g.mode !== 'live' || seat < 0 || seat === g.turn || isBot(g.players[g.turn])) throw new Err('forbidden');
    if (Date.now() - g.turnAt < KICK_LIVE_MS) throw new Err('too_soon');
    eliminate(g, g.turn); pushGame(g);
    return {};
  },
  push(c, m) {                                    // enregistre cet appareil pour les notifications
    const ep = m.endpoint;
    if (!vapid || !pushUrlOk(ep)) throw new Err('invalid');
    for (const q of players.values()) if (q.push && q.push.some(x => x.endpoint === ep) && q.pid !== c.pid) { q.push = q.push.filter(x => x.endpoint !== ep); markP(q.pid); }
    const p = players.get(c.pid);
    p.push = (p.push || []).filter(x => x.endpoint !== ep);
    p.push.push({ endpoint: ep, added: Date.now() });
    if (p.push.length > MAX_PUSH_PER_PLAYER) p.push = p.push.slice(-MAX_PUSH_PER_PLAYER);
    markP(p.pid);
    return {};
  },
  unpush(c, m) {
    const p = players.get(c.pid);
    if (p.push) { p.push = p.push.filter(x => x.endpoint !== m.endpoint); markP(p.pid); }
    return {};
  },
  vis(c, m) { c.visible = m.visible !== false; return {}; },
  mygames(c) {
    const now = Date.now(), list = [];
    for (const g of games.values()) {
      if (!g.players.includes(c.pid)) continue;
      if (g.status === 'done' && now - g.updated > 7 * DAY) continue;
      list.push(summary(g, c.pid));
    }
    const mine = x => (x.status === 'playing' && x.turn === x.me ? 1 : 0);
    list.sort((x, y) => mine(y) - mine(x) || y.updated - x.updated);
    return { games: list.slice(0, 40), profile: prof(players.get(c.pid)), now };
  },
  top(c) {
    const all = [...players.values()].filter(p => p.games > 0).sort((a, b) => b.elo - a.elo || b.games - a.games);
    const top = all.slice(0, 20).map(p => ({ name: p.name, elo: p.elo, games: p.games, wins: p.wins, me: p.pid === c.pid }));
    const rank = all.findIndex(p => p.pid === c.pid);
    return { top, myRank: rank >= 0 ? rank + 1 : null, total: all.length };
  }
};

function handle(c, raw, limited) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  const id = m.id;
  const reply = (ok, extra) => { if (id !== undefined) send(c, Object.assign({ t: 'res', id, ok }, extra)); };
  if (limited) { reply(false, { code: 'rate' }); return; }
  const fn = Object.prototype.hasOwnProperty.call(OPS, m.t) ? OPS[m.t] : null;
  if (!fn) { reply(false, { code: 'invalid' }); return; }
  if (m.t !== 'hello' && !c.pid) { reply(false, { code: 'auth' }); return; }
  try { reply(true, fn(c, m) || {}); }
  catch (e) {
    if (e instanceof Err) reply(false, { code: e.code });
    else { console.error(e); reply(false, { code: 'server' }); }
  }
}

/* ======================= délais et entretien ======================= */
function tick() {
  const now = Date.now();
  remindTurns(now);
  for (const g of [...games.values()]) {
    if (g.status === 'playing') scheduleBot(g);                // reprise après un redémarrage
    if (g.status === 'playing' && g.mode === 'long' && g.deadline && now > g.deadline) {
      log(`délai dépassé : partie ${g.code}, place ${g.turn} éliminée`);
      eliminate(g, g.turn); pushGame(g);
    }
    if (g.status === 'waiting' && now - g.created > 7 * DAY) dropGame(g.code);
    else if (g.status === 'done' && now - g.updated > 30 * DAY) dropGame(g.code);
    else if (g.status === 'playing' && g.mode === 'live' && now - g.updated > 3 * DAY) dropGame(g.code);
  }
}
function applyGrace() {   // après un redémarrage (ou un réveil), chacun garde au moins GRACE_MS pour jouer
  const now = Date.now();
  for (const g of games.values()) if (g.status === 'playing' && g.mode === 'long' && g.deadline && g.deadline < now + GRACE_MS) { g.deadline = now + GRACE_MS; markG(g); }
}

/* ======================= HTTP + WebSocket ======================= */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png']
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (FILES[url]) {
    fs.readFile(path.join(__dirname, FILES[url][0]), (err, buf) => {
      if (err) { res.writeHead(500); res.end('Fichier introuvable'); return; }
      res.writeHead(200, { 'content-type': FILES[url][1], 'cache-control': 'no-cache' }); res.end(buf);
    });
  } else if (url === '/api/due' && req.method === 'POST') {
    let body = '', big = false;
    req.on('data', d => { body += d; if (body.length > 2000) { big = true; req.destroy(); } });
    req.on('end', () => {
      if (big) return;
      let ep = ''; try { ep = JSON.parse(body).endpoint; } catch (e) {}
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ games: dueFor(ep) }));
    });
  } else if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, storage: STORAGE, durable: durable(), lastSaveOk, lastSaveError, players: players.size, games: games.size }));
  } else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Introuvable'); }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key || clients.size >= 1500) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { socket, pid: null, subs: new Set(), buf: Buffer.alloc(0), frag: [], fragLen: 0, rate: 0, rateAt: 0 };
  clients.add(c);
  socket.on('data', chunk => { c.buf = Buffer.concat([c.buf, chunk]); parse(c); });
  socket.on('close', () => clients.delete(c));
  socket.on('error', () => socket.destroy());
});
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  return Buffer.concat([head, payload]);
}
function sendRaw(c, op, payload) { if (!c.socket.destroyed && c.socket.writable) c.socket.write(frame(op, payload)); }
function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return;
      if (b.readUInt32BE(2) !== 0) { c.socket.destroy(); return; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > MAX_FRAME || !masked) { c.socket.destroy(); return; }
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) { sendRaw(c, 8, Buffer.alloc(0)); c.socket.end(); return; }
    if (op === 9) { sendRaw(c, 10, payload); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 0) {
      if (op === 1) { c.frag = []; c.fragLen = 0; }
      c.frag.push(payload); c.fragLen += payload.length;
      if (c.fragLen > MAX_FRAME) { c.socket.destroy(); return; }
      if (fin) {
        const msg = Buffer.concat(c.frag).toString('utf8'); c.frag = []; c.fragLen = 0;
        const now = Date.now();
        if (now - c.rateAt > 1000) { c.rateAt = now; c.rate = 0; }
        handle(c, msg, ++c.rate > 40);
      }
    }
  }
}

/* ======================= démarrage ======================= */
async function main() {
  await loadAll();
  ensureVapid();
  applyGrace();
  setInterval(() => { for (const c of clients) sendRaw(c, 9, Buffer.alloc(0)); }, 25000).unref();
  setInterval(tick, TEST ? 200 : 30000).unref();
  server.listen(PORT, '0.0.0.0', () => log('Propagation : http://localhost:' + PORT));
  const bye = async () => { try { if (dirty.size) await Promise.race([flush(), new Promise(r => setTimeout(r, 4000))]); } finally { process.exit(0); } };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
if (require.main === module) main();
module.exports = { main };
