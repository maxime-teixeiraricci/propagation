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
const Conq = require('./conquest.js');

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
const START_ELO = 1000, MIN_ELO = E.ELO_MIN, ELO_SCALE = E.ELO_SCALE, K_FACTOR = Math.round(32 * ELO_SCALE);
// Passage de l'ancienne échelle (100–1960) à la nouvelle (700–3500) : même droite que les IA.
const oldToNew = e => Math.max(E.ELO_MIN, Math.round(E.ELO_MIN + (e - 100) * ELO_SCALE));
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
function migrateElo() {
  if (!loadOk) return;
  let n = 0;
  for (const p of players.values()) {
    if (p.sv >= 2) continue;
    p.elo = p.games > 0 ? oldToNew(p.elo) : START_ELO; p.sv = 2; markP(p.pid); n++;
  }
  for (const g of games.values()) {
    const r = g.result;
    if (!r || !r.ranked || g.sv >= 2) continue;
    r.before = r.before.map(oldToNew); r.after = r.after.map(oldToNew); g.sv = 2; markG(g);
  }
  if (n) log(`Élo converti vers l'échelle 700–3500 pour ${n} joueurs`);
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
  migrateElo();
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

/* ======================= conquête ======================= */
// Le monde (zones, scores, journal, saisons passées) tient dans une seule entrée « conquest » ; ce que chaque joueur a fait
// (camp, victoires) est dans sa fiche : p.cq = { s: numéro de saison, team, hits, caps }.
let world = null, cqCache = { t: 0 };
function markM(k) { dirty.add('m:' + k); scheduleFlush(); }
const cqOf = (p, w) => (p && p.cq && p.cq.s === w.id ? p.cq : null);
function cqPlayers(id) {            // joueurs d'une saison : effectif de chaque camp et meilleurs combattants
  const members = { eau: 0, feu: 0, air: 0, terre: 0 }, list = [];
  for (const q of players.values()) if (q.cq && q.cq.s === id && members[q.cq.team] !== undefined) { members[q.cq.team]++; list.push({ pid: q.pid, name: q.name, team: q.cq.team, hits: q.cq.hits || 0, caps: q.cq.caps || 0 }); }
  list.sort((a, b) => b.caps - a.caps || b.hits - a.hits || (a.name < b.name ? -1 : 1));
  return { members, list };
}
// Le monde à l'instant now : change de saison si besoin et verse les points des heures écoulées.
function getWorld(now) {
  now = now || Date.now();
  if (!world) {
    const saved = meta.get('conquest');
    world = saved && Array.isArray(saved.zones) ? saved : null;
    if (!world) { world = Conq.newWorld(now); meta.set('conquest', world); markM('conquest'); }
  }
  if (now >= world.end) {
    const top = cqPlayers(world.id).list.slice(0, 3).map(x => ({ name: x.name, team: x.team, hits: x.hits, caps: x.caps }));
    log(`conquête : fin de la saison ${world.id}`);
    world = Conq.rollover(world, now, top); meta.set('conquest', world); markM('conquest'); cqCache = { t: 0 };
  }
  Conq.settle(world, now);
  return world;
}
// Fin d'un combat de conquête : si l'attaquant a gagné, la zone perd un point de vie (et change peut-être de camp).
function conquestResolve(g) {
  if (g.cq.result) return;
  const now = Date.now(), w = getWorld(now), p = players.get(g.cq.pid);
  const won = g.winner >= 0 && g.players[g.winner] === g.cq.pid;
  if (g.cq.season !== w.id) { g.cq.result = { kind: 'late' }; return; }          // la saison s'est terminée pendant le combat
  if (!won) { g.cq.result = { kind: 'lost' }; return; }
  const r = Conq.hit(w, g.cq.zone, g.cq.team, now, p ? p.name : '');
  g.cq.result = r;
  const me = cqOf(p, w);
  if (me && (r.kind === 'hit' || r.kind === 'capture')) { me.hits = (me.hits || 0) + 1; if (r.kind === 'capture') me.caps = (me.caps || 0) + 1; markP(p.pid); }
  cqCache = { t: 0 };
  markM('conquest');
}

/* ======================= parties ======================= */
const cellsOf = (g, s) => { let k = 0; for (let i = 0; i < g.c.length; i++) if (g.c[i] > 0 && g.o[i] === s) k++; return k; };
const aliveSeats = g => { const r = []; for (let s = 0; s < g.np; s++) if (g.players[s] && cellsOf(g, s) > 0) r.push(s); return r; };
const teamOf = (g, s) => (g.teams ? s % g.teams : s);
const teamArr = g => (g.teams ? Array.from({ length: g.np }, (_, s) => s % g.teams) : null);
const hostOf = g => (g.host && g.players.includes(g.host) ? g.host : g.players.find(p => p && !isAuto(p)) || null);
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
    if (ws.every(Boolean) && ws.some(x => !x.bot && !x.res)) {          // au moins un humain : jamais de partie classée entre IA et [BOT] seuls
      const before = ws.map(x => x.elo);
      let delta;
      if (T) {                                   // par équipes : Élo moyen de chaque équipe, même variation pour tous ses joueurs
        const avg = Array.from({ length: T }, (_, t) => { const m = before.filter((_, x) => x % T === t); return m.reduce((a, b) => a + b, 0) / m.length; });
        const d = E.eloDeltas(avg, tr, K_FACTOR, ELO_SCALE);
        delta = before.map((_, x) => d[x % T]);
      } else delta = E.eloDeltas(before, ranks, K_FACTOR, ELO_SCALE);
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
  if (g.cq) conquestResolve(g);
  if (g.tour) tourReport(g);
  for (const pid of g.players) if (pid) pushProfile(pid);
}
/* ======================= joueurs IA ======================= */
// Un siège d'IA est repéré par un identifiant « bot:NIVEAU:SIÈGE » (impossible à confondre avec un compte).
const isBot = pid => typeof pid === 'string' && pid.startsWith('bot:');
// Un joueur « résident » [BOT] a un vrai compte (nom, Élo, statistiques) mais joue tout seul : identifiant « rb:N », impossible à confondre avec un compte humain.
const isRes = pid => typeof pid === 'string' && pid.startsWith('rb:');
const isAuto = pid => isBot(pid) || isRes(pid);              // un siège qui joue sans humain derrière
const botLevel = pid => (isRes(pid) ? ((players.get(pid) || {}).lvl || 3) : Number(pid.split(':')[1]) || 3);
function who(pid) {              // nom et Élo d'un siège, humain ou IA
  if (!pid) return null;
  if (isBot(pid)) { const l = Bot.byLevel(botLevel(pid)); return { name: 'IA ' + l.name, elo: l.elo, bot: true }; }
  const p = players.get(pid);
  return p ? { name: p.name, elo: p.elo, bot: false, res: !!p.res, p } : null;
}
const botTimers = new Map();
function scheduleBot(g) {
  if (g.status !== 'playing' || botTimers.has(g.code)) return;
  const pid = g.players[g.turn];
  if (!isAuto(pid)) return;
  const seq = g.seq;
  // l'IA attend la fin de l'animation du coup précédent, pour que la partie reste lisible ; un [BOT] réfléchit comme une personne
  const wait = BOT_FAST ? 25 : isRes(pid) && !g.sim ? resDelay(g, pid) : Math.max(g.last ? 700 : 1300, g.botWait || 0);
  botTimers.set(g.code, setTimeout(() => { botTimers.delete(g.code); runBot(g.code, seq); }, wait));
}
function runBot(code, seq) {
  const g = games.get(code);
  if (!g || g.status !== 'playing' || g.seq !== seq || !isAuto(g.players[g.turn])) return;
  try {
    const seat = g.turn, i = botPick(g, seat);
    if (i < 0) return;
    applyMove(g, seat, i); pushGame(g);
  } catch (e) { console.error('IA :', e); }
}
function botPick(g, seat) {
  let i = Bot.choose(botLevel(g.players[seat]), { n: g.n, h: g.h, o: g.o, c: g.c, dead: g.dead || 0 }, seat, g.np, Math.random, null, g.teams || 0);
  if (!(Number.isInteger(i) && i >= 0 && i < g.c.length && g.o[i] === seat && g.c[i] > 0)) {    // garde-fou : coup toujours légal
    const own = []; for (let k = 0; k < g.c.length; k++) if (g.o[k] === seat && g.c[k] > 0) own.push(k);
    if (!own.length) return -1;
    i = own[rnd(own.length)];
  }
  return i;
}

// Après un changement de plateau : éliminations, victoire éventuelle, joueur suivant.
function settle(g, opt) {
  updateElim(g);
  const alive = aliveSeats(g);
  g.seq++; g.updated = Date.now();
  const aliveTeams = new Set(alive.map(x => teamOf(g, x)));
  const botsOnly = !g.sim && g.players.some(isAuto) && aliveTeams.size > 1 && !alive.some(x => !isAuto(g.players[x]));
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
  const r = E.step({ n: g.n, h: g.h, o: g.o, c: g.c, np: g.np, dead: g.dead || 0 }, i, seat, teamArr(g), !!g.sudden, g.round || 0);
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
  const b = E.newBoard(g.n, np, rnd(np), g.h);
  g.np = np; g.o = b.o; g.c = b.c; g.dead = 0; g.round = 0; g.seen = []; if (np <= 4) g.sudden = false; g.turn = rnd(np); g.last = null; g.winner = -1; g.elim = []; g.result = null;
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

// Combat de conquête : la défense de la zone porte le nom du camp qui la tient.
const cqDefName = g => (g.cq.def ? 'Défense ' + Conq.TEAM_NAMES[g.cq.def] : 'Garnison');
function cqView(g) {
  const Z = Conq.ZONE[g.cq.zone], w = getWorld(), z = g.cq.season === w.id ? Conq.zoneOf(w, Z.id) : null;
  return { zone: Z.id, name: Z.name, a: Z.a, b: Z.b, team: g.cq.team, def: g.cq.def, lvl: Z.lvl, income: Z.income, bonus: Z.bonus,
    hp: z ? z.hp : null, maxHp: Z.pv, owner: z ? z.owner : null, result: g.cq.result || null };
}
function viewFor(g, pid) {
  return {
    code: g.code, n: g.n, h: g.h || g.n, np: g.np, mode: g.mode, turnMs: g.turnMs, ranked: g.ranked, ai: g.ai || 0, status: g.status,
    o: g.o, c: g.c, turn: g.turn, seq: g.seq, last: g.last, winner: g.winner,
    teams: g.teams || 0, host: g.players.indexOf(hostOf(g)), sudden: !!g.sudden, dead: g.dead || 0, round: g.round || 0, public: !!g.public, auto: !!g.auto,
    seats: g.players.map((p, x) => {
      const w = who(p), cq = g.cq && w;
      return { filled: !!p, name: cq && w.bot ? cqDefName(g) : w ? w.name : '', rating: cq ? null : w ? w.elo : null, bot: !!(w && w.bot), auto: isAuto(p), team: g.teams ? x % g.teams : -1,
        el: cq ? (w.bot ? g.cq.def : g.cq.team) : undefined };
    }),
    me: g.players.indexOf(pid), turnAt: g.turnAt, deadline: g.deadline, elim: g.elim, result: g.result, cq: g.cq ? cqView(g) : null, tour: g.tour ? tourBrief(g) : null
  };
}
function summary(g, pid) {
  const me = g.players.indexOf(pid);
  return {
    code: g.code, n: g.n, h: g.h || g.n, np: g.np, mode: g.mode, turnMs: g.turnMs, ranked: g.ranked, ai: g.ai || 0, status: g.status, me,
    turn: g.turn, winner: g.winner, deadline: g.deadline, updated: g.updated,
    names: g.players.map(p => { const w = who(p); return w ? (g.cq && w.bot ? cqDefName(g) : w.name) : ''; }),
    cq: g.cq ? { name: Conq.ZONE[g.cq.zone].name, team: g.cq.team } : null, tour: g.tour ? tourBrief(g) : null,
    filled: g.players.filter(Boolean).length, humans: g.players.filter(p => p && !isAuto(p)).length, teams: g.teams || 0,
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
  if (pid && !isAuto(pid)) {                    // page ouverte ailleurs (accueil, autre partie) : un petit bandeau « à toi de jouer »
    const label = g.cq ? 'Conquête · ' + Conq.ZONE[g.cq.zone].name : 'Partie ' + g.code;
    for (const c of clients) if (c.pid === pid && !c.subs.has(g.code)) send(c, { t: 'turn', code: g.code, label });
  }
  if (pid && !isAuto(pid) && !playerHere(pid, g.code)) notifyPid(pid, g.mode === 'long' ? 86400 : 600).catch(() => {});
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
// Une partie terminée disparaît de « Mes parties » dès que le joueur en a vu le résultat.
function markSeen(g, pid) {
  if (g.status !== 'done' || !pid || !g.players.includes(pid)) return;
  g.seen = g.seen || [];
  if (!g.seen.includes(pid)) { g.seen.push(pid); markG(g); }
}
function pushGame(g) {
  for (const c of clients) if (c.pid && c.subs.has(g.code)) { markSeen(g, c.pid); send(c, { t: 'game', code: g.code, g: viewFor(g, c.pid), now: Date.now() }); }
  notifyTurn(g);
  scheduleBot(g);
}
function pushProfile(pid) {
  const p = players.get(pid); if (!p) return;
  for (const c of clients) if (c.pid === pid) send(c, { t: 'profile', profile: prof(p) });
}

function startGame(g) {
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
}
// Option « lancer dès que toutes les places sont prises » (cochée par défaut à la création).
function maybeAutoStart(g) {
  if (g.status === 'waiting' && g.auto && g.players.length >= 2 && g.players.every(Boolean)) startGame(g);
}

/* ======================= Tournois ======================= */
// Élimination directe sur plusieurs jours : des duels 1 contre 1, un tour après l'autre. Les places vides sont prises par des IA.
// Un tournoi tient dans une entrée « t:CODE » ; chaque match est une vraie partie (g.tour = { code, round, i }).
const TOUR_SIZES = [4, 8, 16], TOUR_ROUND_H = [24, 48, 72], TCODE_RE = /^T[A-HJ-NP-Z2-9]{4}$/;
const TOUR_ROUND_TEST = TEST && Number(process.env.TOUR_ROUND_MS) >= 300 ? Number(process.env.TOUR_ROUND_MS) : 0;
const tourOf = code => meta.get('t:' + String(code || '').toUpperCase());
const allTours = () => { const r = []; for (const [k, v] of meta) if (k.startsWith('t:')) r.push(v); return r; };
const saveT = t => markM('t:' + t.code);
const tourStage = (t, r) => { const left = Math.log2(t.size) - r; return left <= 1 ? 'Finale' : left === 2 ? 'Demi-finales' : left === 3 ? 'Quarts de finale' : 'Huitièmes de finale'; };
const tourElo = e => { const w = who(e); return w ? w.elo : 0; };
function tourBrief(g) { const t = tourOf(g.tour.code); return t ? { code: t.code, name: t.name, round: g.tour.round, stage: tourStage(t, g.tour.round), deadline: t.deadline || null, status: t.status } : null; }
function tourCreate(c, m) {
  const size = Number(m.size);
  if (!TOUR_SIZES.includes(size)) throw new Err('invalid');
  const h = Number(m.hours), roundMs = TOUR_ROUND_TEST || (TOUR_ROUND_H.includes(h) ? h : 48) * 3600000;
  const n = E.SIZES[2].slice(0, 3).includes(Number(m.n)) ? Number(m.n) : E.SIZES[2][3];
  const ai = Math.min(Bot.LEVELS.length, Math.max(1, Math.floor(Number(m.ai)) || 4));
  if (allTours().filter(t => t.status !== 'done' && (t.entrants.includes(c.pid) || t.host === c.pid)).length >= 5) throw new Err('too_many');
  if (allTours().length >= 600) throw new Err('full');
  let code = '';
  for (let k = 0; k < 50; k++) { let x = 'T'; for (let i = 0; i < 4; i++) x += ALPHABET[rnd(ALPHABET.length)]; if (!meta.has('t:' + x)) { code = x; break; } }
  if (!code) throw new Err('full');
  const p = players.get(c.pid);
  const t = { code, name: clean(m.name) || 'Tournoi de ' + p.name, host: c.pid, size, roundMs, n, ai, public: m.public !== false, status: 'open',
    created: Date.now(), entrants: [c.pid], bracket: null, round: 0, deadline: null, champion: null };
  meta.set('t:' + code, t); saveT(t);
  return { code };
}
function tourStart(t) {
  if (t.status !== 'open') throw new Err('forbidden');
  const ents = t.entrants.slice();
  for (let k = 0; ents.length < t.size; k++) ents.push(`bot:${Math.min(Bot.LEVELS.length, Math.max(1, t.ai + (k % 3) - 1))}:${k}`);   // IA de niveaux voisins
  for (let k = ents.length - 1; k > 0; k--) { const j = rnd(k + 1); [ents[k], ents[j]] = [ents[j], ents[k]]; }
  t.status = 'running'; t.startedAt = Date.now(); t.round = 0; t.bracket = [pairUp(ents)];
  tourLaunch(t);
}
const pairUp = list => { const r = []; for (let i = 0; i < list.length; i += 2) r.push({ a: list[i], b: list[i + 1], code: null, w: null }); return r; };
function botDuel(a, b) {                                  // deux IA : le résultat est tiré au sort d'après leurs Élo
  const pa = 1 / (1 + Math.pow(10, (tourElo(b) - tourElo(a)) / (400 * ELO_SCALE)));
  return rnd(100000) / 100000 < pa ? a : b;
}
function tourLaunch(t) {                                  // crée les parties du tour courant
  const r = t.round, rd = t.bracket[r];
  t.deadline = Date.now() + t.roundMs;
  rd.forEach((m, i) => {
    if (m.w) return;
    if (isAuto(m.a) && isAuto(m.b)) { m.w = botDuel(m.a, m.b); return; }
    tourGame(t, r, i, m);
  });
  saveT(t); tourCheck(t);
}
function tourGame(t, r, i, m) {
  let code = '';
  for (let k = 0; k < 50; k++) { let s2 = ''; for (let q = 0; q < 4; q++) s2 += ALPHABET[rnd(ALPHABET.length)]; if (!games.has(s2)) { code = s2; break; } }
  if (!code) return;
  const auto = [m.a, m.b].find(isAuto), ai = auto && isBot(auto) ? botLevel(auto) : 0, b = E.newBoard(t.n, 2, rnd(2)), now = Date.now();
  const g = { code, n: t.n, np: 2, mode: auto ? 'live' : 'long', turnMs: auto ? 0 : Math.min(DAY, t.roundMs), ranked: false, status: 'waiting', players: [m.a, m.b],
    o: b.o, c: b.c, turn: rnd(2), seq: 0, last: null, winner: -1, elim: [], result: null, turnAt: null, deadline: null, created: now, updated: now,
    host: [m.a, m.b].find(x => !isAuto(x)), teams: 0, sudden: false, dead: 0, round: 0, public: false, auto: false, ai, tour: { code: t.code, round: r, i } };
  startPlaying(g); games.set(code, g); markG(g); m.code = code;
  pushGame(g);
  for (const pid of [m.a, m.b]) if (!isAuto(pid) && g.players[g.turn] !== pid && !playerHere(pid, code)) notifyPid(pid, 3600).catch(() => {});
}
// Un match terminé : le vainqueur avance. Quand tout le tour est joué, le suivant commence ; après la finale, le tournoi est fini.
function tourReport(g) {
  const t = tourOf(g.tour.code); if (!t || t.status !== 'running') return;
  const m = t.bracket[g.tour.round] && t.bracket[g.tour.round][g.tour.i];
  if (!m || m.w || g.winner < 0) return;
  m.w = g.players[g.winner]; saveT(t); tourCheck(t);
}
function tourCheck(t) {
  if (t.status !== 'running') return;
  const rd = t.bracket[t.round];
  if (rd.some(m => !m.w)) return;
  if (rd.length === 1) {
    t.champion = rd[0].w; t.status = 'done'; t.finished = Date.now(); t.deadline = null;
    const p = players.get(t.champion);
    if (p) { p.trophies = (p.trophies || 0) + 1; markP(p.pid); pushProfile(p.pid); }
    saveT(t);
    for (const pid of t.entrants) if (!playerHere(pid, t.code)) notifyPid(pid, 86400).catch(() => {});
    return;
  }
  t.round++; t.bracket.push(pairUp(rd.map(m => m.w)));
  tourLaunch(t);
}
function tourDeadline(t) {                                // échéance du tour : les matchs non finis sont décidés aux points
  const rd = t.bracket[t.round];
  rd.forEach(m => {
    if (m.w) return;
    const g = m.code ? games.get(m.code) : null;
    if (!g || g.status === 'done') { m.w = g && g.winner >= 0 ? g.players[g.winner] : tourElo(m.a) >= tourElo(m.b) ? m.a : m.b; return; }
    const val = x => { let v = 0; for (let k = 0; k < g.c.length; k++) if (g.o[k] === x && g.c[k] > 0) v += 3 + g.c[k]; return v; };
    const v0 = val(0), v1 = val(1);
    const loser = v0 < v1 ? 0 : v1 < v0 ? 1 : tourElo(g.players[0]) >= tourElo(g.players[1]) ? 1 : 0;     // à égalité : le mieux classé passe
    eliminate(g, loser); pushGame(g);
  });
  saveT(t); tourCheck(t);
}
function tourTick(now) {
  for (const t of allTours()) {
    if (t.status === 'running' && t.deadline && now > t.deadline) { log(`tournoi ${t.code} : échéance du tour ${t.round + 1}`); try { tourDeadline(t); } catch (e) { console.error('tournoi :', e); } }
    else if (t.status === 'open' && now - t.created > 7 * DAY) { meta.delete('t:' + t.code); saveT(t); }
    else if (t.status === 'done' && now - (t.finished || t.created) > 30 * DAY) { meta.delete('t:' + t.code); saveT(t); }
  }
}
function tourNm(e, pid) { if (!e) return null; const w = who(e); return w ? { name: w.name, elo: w.elo, bot: w.bot, me: e === pid } : { name: '?', elo: 0, bot: false, me: false }; }
function tourMyMatch(t, pid) {
  if (t.status !== 'running') return null;
  const rd = t.bracket[t.round];
  for (let i = 0; i < rd.length; i++) { const m = rd[i]; if (!m.w && (m.a === pid || m.b === pid) && m.code) { const g = games.get(m.code); return { code: m.code, round: t.round, i, turn: !!(g && g.status === 'playing' && g.players[g.turn] === pid), deadline: g ? g.deadline : null }; } }
  return null;
}
function tourView(t, pid) {
  const total = Math.log2(t.size), rounds = [];
  for (let r = 0; r < total; r++) {
    const rd = t.bracket && t.bracket[r];
    rounds.push({ stage: tourStage(t, r), matches: rd ? rd.map(m => ({ a: tourNm(m.a, pid), b: tourNm(m.b, pid), w: m.w ? (m.w === m.a ? 0 : 1) : null, mine: m.a === pid || m.b === pid, code: (m.a === pid || m.b === pid) && !m.w ? m.code : null })) : [] });
  }
  return { code: t.code, name: t.name, status: t.status, size: t.size, n: t.n, roundMs: t.roundMs, ai: t.ai, public: t.public, host: t.host === pid, hostName: (who(t.host) || {}).name || '',
    entrants: t.entrants.map(e => tourNm(e, pid)), inside: t.entrants.includes(pid), round: t.round, stage: t.bracket ? tourStage(t, t.round) : null, rounds,
    deadline: t.deadline, champion: t.champion ? tourNm(t.champion, pid) : null, my: tourMyMatch(t, pid), created: t.created, now: Date.now() };
}
function tourSummary(t, pid) {
  const my = tourMyMatch(t, pid);
  return { code: t.code, name: t.name, size: t.size, filled: t.entrants.length, status: t.status, hours: Math.round(t.roundMs / 3600000), n: t.n,
    host: (who(t.host) || {}).name || '', stage: t.bracket ? tourStage(t, t.round) : null, deadline: t.deadline, turn: !!(my && my.turn), playing: !!my,
    champion: t.champion ? tourNm(t.champion, pid) : null, inside: t.entrants.includes(pid), created: t.created };
}
/* ======================= joueurs [BOT] résidents ======================= */
// Des comptes permanents, marqués « [BOT] », qui vivent comme des joueurs : un profil (nom, Élo, parties, victoires),
// des heures de réveil et de coucher, des salles qu'ils rejoignent ou créent, des tournois, un camp en Conquête.
// Ils jouent au niveau de leur IA (donc leur Élo se stabilise à leur vrai niveau), avec des délais de réflexion humains.
// Ils n'ont aucun accès au réseau : le serveur agit pour eux en appelant les mêmes opérations que les joueurs.
const RES_COUNT = process.env.RESIDENTS !== undefined ? Math.max(0, Math.min(60, Math.floor(Number(process.env.RESIDENTS)) || 0)) : 0;                    // par défaut : aucun [BOT] (à activer avec RESIDENTS)
const RES_FAST = TEST && process.env.RES_FAST === '1';          // essais : horloge accélérée, pas de nuit
const RES_TAG = '[BOT] ';
const RES_NAMES = ['Léa', 'Hugo', 'Inès', 'Théo', 'Zoé', 'Nolan', 'Sacha', 'Maëlys', 'Yanis', 'Lucie', 'Mehdi', 'Jade', 'Anaïs', 'Tom', 'Clara', 'Elias', 'Manon', 'Kylian', 'Nina', 'Ravi', 'Éva', 'Axel', 'Lola', 'Noé',
  'Louis', 'Alice', 'Gabin', 'Romane', 'Adam', 'Chloé', 'Enzo', 'Camille', 'Ethan', 'Margaux', 'Léo', 'Sarah', 'Paul', 'Julia', 'Arthur', 'Louna', 'Victor', 'Emma'];
const RES_LVL = [2, 3, 1, 4, 3, 5, 2, 6, 4, 3, 7, 5, 2, 4, 6, 3, 5, 8, 2, 4, 3, 5, 6, 4,
  3, 5, 2, 4, 6, 3, 7, 4, 2, 5, 3, 6, 4, 2, 5, 3, 4, 8];
const RES_MAX_ACTIVE = 3;
const humanName = s => { const n = clean(s); return n.replace(/^\[\s*bot\s*\]\s*/i, ''); };      // personne ne peut se faire passer pour un [BOT]
function ensureResidents() {
  if (!RES_COUNT || !loadOk) return;
  for (let k = 0; k < RES_COUNT; k++) {
    const pid = 'rb:' + (k + 1);
    if (players.has(pid)) continue;
    const lvl = RES_LVL[k], L = Bot.byLevel(lvl), games = 24 + rnd(150), wr = Math.min(0.8, 0.15 + 0.065 * lvl);
    players.set(pid, { pid, h: '', name: RES_TAG + RES_NAMES[k], elo: Math.max(MIN_ELO, L.elo + rnd(81) - 40), games, wins: Math.round(games * wr), sv: 2,
      created: Date.now() - rnd(40 * DAY), res: 1, lvl, wake: 6.5 + rnd(30) / 10, bed: 22 + rnd(36) / 10 });
    markP(pid);
  }
}
const resHour = t => ((t / 3600000) + 2) % 24;                    // heure de Paris (été), au quart près
function resAwake(p, t) {
  if (RES_FAST) return true;
  const h = resHour(t);
  return h >= p.wake && (h < p.bed || h < p.bed - 24);
}
// Délai de réflexion d'un [BOT] avant son coup.
function resDelay(g, pid) {
  const p = players.get(pid), now = Date.now();
  if (RES_FAST) return 40 + rnd(60);
  if (g.mode !== 'long') return Math.max(g.last ? 700 : 1300, g.botWait || 0) + 2000 + rnd(9000) + (rnd(100) < 12 ? rnd(25000) : 0);
  // longue durée : quelques minutes à quelques heures, et pas pendant la nuit du joueur
  let t = now + 3 * 60000 + Math.round(-Math.log(1 - rnd(1000) / 1001) * 40 * 60000);
  for (let k = 0; k < 120 && p && !resAwake(p, t); k++) t += 600000;
  t += rnd(30 * 60000);
  const limit = g.deadline ? g.deadline - 10 * 60000 : now + 0.6 * (g.turnMs || DAY);       // jamais éliminé par le délai
  return Math.max(30000, Math.min(t, limit) - now);
}
const resRt = new Map();
function residentTick(now) {
  if (!RES_COUNT) return;
  for (const p of players.values()) {
    if (!p.res) continue;
    let rt = resRt.get(p.pid);
    if (!rt) { rt = { next: now + (RES_FAST ? rnd(500) : (1 + rnd(8)) * 60000) }; resRt.set(p.pid, rt); }
    if (now < rt.next) continue;
    rt.next = now + (RES_FAST ? 300 + rnd(300) : (4 + rnd(14)) * 60000);
    if (!resAwake(p, now)) continue;
    try { resAct(p, now); } catch (e) { if (!(e instanceof Err)) console.error('[BOT] :', e); }
  }
}
function resAct(p, now) {
  const fc = { pid: p.pid, subs: new Set() };
  let active = 0;
  for (const g of [...games.values()]) {                              // 1. ses parties en cours
    if (g.status === 'done' || !g.players.includes(p.pid)) continue;
    active++;
    const idle = now - g.updated, humans = g.players.some(x => x && !isAuto(x));
    try {
      if (g.status === 'waiting') {
        const mine = g.host === p.pid, wait = RES_FAST ? 2500 : g.mode === 'long' ? 3 * 3600000 : 12 * 60000;
        if (!humans && idle > wait) { OPS.leave(fc, { code: g.code }); active--; }                                   // personne n'est venu
        else if (!mine && idle > (RES_FAST ? 8000 : 15 * 60000)) { OPS.leave(fc, { code: g.code }); active--; }      // le créateur ne lance pas
        else if (mine && humans && g.np > 2 && idle > (RES_FAST ? 1500 : 90000)) OPS.fill(fc, { code: g.code, level: Math.min(Bot.LEVELS.length, Math.max(1, p.lvl + rnd(3) - 1)) });   // complète avec des IA
      } else if (g.mode === 'live' && g.players[g.turn] !== p.pid && !isAuto(g.players[g.turn]) && now - g.turnAt > KICK_LIVE_MS + (RES_FAST ? 500 : 60000)) {
        OPS.kick(fc, { code: g.code });                                // un adversaire parti en pleine partie rapide
      }
    } catch (e) { if (!(e instanceof Err)) throw e; }
  }
  if (active >= RES_MAX_ACTIVE) return;
  const todo = [resJoinRoom, resJoinRoom, resJoinTour, resConquest, resConquest, resCreateRoom];          // 2. une envie, tirée au sort
  for (let k = todo.length - 1; k > 0; k--) { const j = rnd(k + 1); [todo[k], todo[j]] = [todo[j], todo[k]]; }
  for (const f of todo.slice(0, 3)) { try { if (f(p, fc, now)) return; } catch (e) { if (!(e instanceof Err)) throw e; } }
}
function resJoinRoom(p, fc, now) {
  const pool = [];
  for (const g of games.values()) {
    if (g.status !== 'waiting' || !g.public || g.teams || g.np > 4 || g.players.includes(p.pid) || !g.players.includes(null)) continue;
    if (g.players.some(isRes) || !g.players.some(x => x && !isAuto(x))) continue;
    if (now - g.updated < (RES_FAST ? 0 : 20000 + rnd(70000))) continue;                           // le temps de remarquer la salle
    const h = who(hostOf(g)); if (g.ranked && h && Math.abs(h.elo - p.elo) > 900) continue;
    pool.push(g);
  }
  if (!pool.length) return false;
  OPS.join(fc, { code: pool[rnd(pool.length)].code }); return true;
}
function resCreateRoom(p, fc, now) {
  let theirs = 0; for (const g of games.values()) if (g.status === 'waiting' && isRes(g.host)) theirs++;
  if (theirs >= Math.min(3, Math.ceil(RES_COUNT / 14))) return false;
  const np = rnd(100) < 75 ? 2 : 4, long = rnd(100) < 30;
  OPS.create(fc, { np, mode: long ? 'long' : 'live', hours: [24, 48][rnd(2)], ranked: rnd(100) < 85, public: true, auto: true }); return true;
}
function resJoinTour(p, fc) {
  const pool = allTours().filter(t => t.status === 'open' && t.public && t.entrants.length < t.size && !t.entrants.includes(p.pid)
    && t.entrants.some(x => !isAuto(x)) && t.entrants.filter(isRes).length < t.size / 2);
  if (!pool.length) return false;
  OPS.tjoin(fc, { code: pool[rnd(pool.length)].code }); return true;
}
function resConquest(p, fc, now) {
  const w = getWorld(now); let me = cqOf(p, w);
  if (!me) {
    const mem = cqPlayers(w.id).members, low = Math.min(...Conq.TEAMS.map(t => mem[t])), pick = Conq.TEAMS.filter(t => mem[t] === low);
    OPS.conqteam(fc, { team: pick[rnd(pick.length)] }); return true;
  }
  Conq.syncAttacks(me, now);
  if (me.atk < 1 || (me.atk < 3 && rnd(100) < 60)) return false;                      // il garde de la réserve, comme un joueur prudent
  let zs = Conq.ZONES.filter(Z => !Conq.whyNot(w, me.team, Z.id));
  const easy = zs.filter(Z => Z.lvl <= p.lvl + 1); if (easy.length) zs = easy; else zs.sort((a, b) => a.lvl - b.lvl).splice(2);
  if (!zs.length) return false;
  const r = OPS.conqatk(fc, { zone: zs[rnd(zs.length)].id }), g = games.get(r.code);
  if (!g) return true;
  g.sim = true; const tm = botTimers.get(g.code); if (tm) { clearTimeout(tm); botTimers.delete(g.code); }
  for (let k = 0; k < 3000 && g.status === 'playing'; k++) { const seat = g.turn, i = botPick(g, seat); if (i < 0) break; applyMove(g, seat, i); }       // le combat est joué d'un trait
  if (g.status === 'done') dropGame(g.code);
  return true;
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
      p = { pid, h, name: humanName(m.name) || 'Joueur ' + pid.slice(0, 4), elo: START_ELO, games: 0, wins: 0, sv: 2, created: Date.now() };
      players.set(pid, p); markP(pid);
    }
    c.pid = pid;
    return { profile: prof(p), features: { durable: durable(), storage: STORAGE, test: TEST, turnChoicesH: TURN_CHOICES_H, conquest: true, tournament: true, vapid: vapid ? vapid.pub : null, bots: Bot.LEVELS } };
  },
  name(c, m) {
    const nm = humanName(m.name); if (!nm) throw new Err('invalid');
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
      sudden: np > 4 && !!m.sudden, dead: 0, round: 0, public: !ai && m.public !== false, auto: m.auto !== false };
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
    if (idx !== before) { pushGame(g); maybeAutoStart(g); }
    return { idx };
  },
  sub(c, m) {
    const code = String(m.code || '').toUpperCase();
    if (!CODE_RE.test(code)) throw new Err('invalid');
    c.subs.add(code);
    const g = games.get(code);
    if (g) markSeen(g, c.pid);
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
    if (!Number.isInteger(i) || i < 0 || i >= g.n * (g.h || g.n) || g.o[i] !== seat || g.c[i] <= 0) throw new Err('invalid_move');
    applyMove(g, seat, i);
    pushGame(g);
    return {};
  },
  start(c, m) {                                   // le créateur de la salle lance la partie
    startGame(lobbyOf(c, m));
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
    if (m.public !== undefined) g.public = !!m.public;
    if (m.auto !== undefined) g.auto = !!m.auto;
    if (g.np <= 4) g.sudden = false;                  // la mort subite n'existe qu'à 6 et 8 joueurs
    g.updated = Date.now(); markG(g); pushGame(g); maybeAutoStart(g);
    return {};
  },
  seatai(c, m) {                                  // met, change ou retire une IA sur une place (créateur)
    const g = lobbyOf(c, m);
    const seat = Number(m.seat), level = Math.floor(Number(m.level));
    if (!Number.isInteger(seat) || seat < 0 || seat >= g.np || !(level >= 0 && level <= Bot.LEVELS.length)) throw new Err('invalid');
    const cur = g.players[seat];
    if (cur && !isBot(cur)) throw new Err('forbidden');
    g.players[seat] = level ? `bot:${level}:${seat}` : null;
    g.updated = Date.now(); markG(g); pushGame(g); maybeAutoStart(g);
    return {};
  },
  fill(c, m) {                                    // complète les places libres avec des IA (créateur)
    const g = lobbyOf(c, m);
    const level = Math.min(Bot.LEVELS.length, Math.max(1, Math.floor(Number(m.level)) || 4));
    for (let x = 0; x < g.np; x++) if (!g.players[x]) g.players[x] = `bot:${level}:${x}`;
    g.updated = Date.now(); markG(g); pushGame(g); maybeAutoStart(g);
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
    if (!g.players.some(p => p && !isAuto(p))) { dropGame(g.code); for (const cl of clients) cl.subs.delete(g.code); return {}; }
    if (g.host === c.pid) g.host = g.players.find(p => p && !isAuto(p));
    g.updated = Date.now(); markG(g); pushGame(g);
    c.subs.delete(g.code);
    return {};
  },
  rematch(c, m) {
    const g = games.get(String(m.code || '').toUpperCase());
    if (!g) throw new Err('not_found');
    if (g.status !== 'done' || !g.players.includes(c.pid) || g.cq || g.tour) throw new Err('forbidden');
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
    if (g.status !== 'playing' || g.mode !== 'live' || seat < 0 || seat === g.turn || isAuto(g.players[g.turn])) throw new Err('forbidden');
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
      if (g.status === 'done') continue;               // « Mes parties » ne montre que les parties à reprendre
      list.push(summary(g, c.pid));
    }
    const mine = x => (x.status === 'playing' && x.turn === x.me ? 1 : 0);
    list.sort((x, y) => mine(y) - mine(x) || y.updated - x.updated);
    return { games: list.slice(0, 40), profile: prof(players.get(c.pid)), now };
  },
  rooms(c) {                                      // salles d'attente publiques où il reste une place
    const now = Date.now(), list = [];
    for (const g of games.values()) {
      if (g.status !== 'waiting' || !g.public || g.players.includes(c.pid)) continue;
      if (!g.players.some(p => !p || isBot(p))) continue;
      const host = hostOf(g), hw = who(host); if (!hw) continue;
      const here = isRes(host) || [...clients].some(cl => cl.pid === host && cl.subs.has(g.code));
      if (g.mode === 'long' ? now - g.updated > 2 * DAY : !here) continue;      // en direct : le créateur doit être dans la salle
      list.push({ code: g.code, host: hw.name, hostElo: hw.elo, filled: g.players.filter(Boolean).length, np: g.np, n: g.n,
        mode: g.mode, hours: g.turnMs ? Math.round(g.turnMs / 3600000) : 0, teams: g.teams || 0, ranked: !!g.ranked, sudden: !!g.sudden, updated: g.updated });
    }
    list.sort((x, y) => y.updated - x.updated);
    return { rooms: list.slice(0, 20) };
  },
  conq(c) {                                       // l'état du monde de conquête
    const now = Date.now(), w = getWorld(now), p = players.get(c.pid), mine = cqOf(p, w);
    if (now - cqCache.t > 15000 || cqCache.id !== w.id) { const r = cqPlayers(w.id); cqCache = { t: now, id: w.id, members: r.members, top: r.list.slice(0, 10).map(x => ({ pid: x.pid, name: x.name, team: x.team, hits: x.hits, caps: x.caps })) }; }
    if (mine && typeof mine.atk !== 'number') { Conq.syncAttacks(mine, now); markP(p.pid); }
    const snap = Conq.snapshot(w, mine ? mine.team : null, now);
    for (const z of snap.zones) { const l = Bot.byLevel(z.lvl); z.ai = { name: l.name, elo: l.elo }; }
    let busy = null;
    for (const g of games.values()) if (g.cq && g.cq.pid === c.pid && g.status === 'playing' && g.cq.season === w.id) { busy = { code: g.code, zone: g.cq.zone }; break; }
    return Object.assign(snap, { now, members: cqCache.members, top: cqCache.top.map(x => ({ name: x.name, team: x.team, hits: x.hits, caps: x.caps, me: x.pid === c.pid })),
      me: mine ? { team: mine.team, hits: mine.hits || 0, caps: mine.caps || 0, attacks: Conq.attacksView(mine, now) } : null, busy, payMin: Conq.PAY_MS / 60000, atkEveryH: Conq.ATK_EVERY / 3600000 });
  },
  conqteam(c, m) {                                // choisir son camp pour la saison (définitif jusqu'au lundi)
    const now0 = Date.now(), w = getWorld(now0), p = players.get(c.pid), team = String(m.team || '');
    if (!Conq.TEAMS.includes(team)) throw new Err('invalid');
    if (cqOf(p, w)) throw new Err('locked');
    p.cq = { s: w.id, team, hits: 0, caps: 0, atk: TEST && Number(process.env.CQ_ATK_START) ? Math.min(Conq.ATK_MAX, Number(process.env.CQ_ATK_START)) : Conq.ATK_START, t: now0 }; markP(p.pid); cqCache = { t: 0 };
    return {};
  },
  conqatk(c, m) {                                 // attaquer une zone : un combat contre l'IA qui la défend
    const now = Date.now(), w = getWorld(now), p = players.get(c.pid), me = cqOf(p, w);
    if (!me) throw new Err('no_team');
    const Z = Conq.ZONE[String(m.zone || '')];
    if (!Z) throw new Err('invalid');
    for (const g of games.values()) if (g.cq && g.cq.pid === c.pid && g.status === 'playing') {
      if (g.cq.zone === Z.id && g.cq.season === w.id) return { code: g.code };      // le combat est déjà lancé : on le reprend
      throw new Err('busy');
    }
    const why = Conq.whyNot(w, me.team, Z.id);
    if (why) throw new Err(why === 'own' ? 'own' : 'far');
    if (activeCount(c.pid) >= MAX_ACTIVE_PER_PLAYER) throw new Err('too_many');
    if (games.size >= MAX_GAMES) throw new Err('full');
    let code = '';
    for (let t = 0; t < 50; t++) { let s2 = ''; for (let i = 0; i < 4; i++) s2 += ALPHABET[rnd(ALPHABET.length)]; if (!games.has(s2)) { code = s2; break; } }
    if (!code) throw new Err('full');
    if (!Conq.spendAttack(me, now)) throw new Err('no_attack');          // lancer un combat coûte une attaque (réserve : 3 au départ, 5 au maximum, +1 toutes les 3 h)
    markP(p.pid);
    const z = Conq.zoneOf(w, Z.id), b = E.newBoard(Z.a, 2, rnd(2), Z.b);
    const g = { code, n: Z.a, h: Z.b, np: 2, mode: 'live', turnMs: 0, ranked: false, status: 'waiting', players: [c.pid, `bot:${Z.lvl}:1`],
      o: b.o, c: b.c, turn: rnd(2), seq: 0, last: null, winner: -1, elim: [], result: null, turnAt: null, deadline: null, created: now, updated: now, host: c.pid, teams: 0,
      sudden: false, dead: 0, round: 0, public: false, ai: Z.lvl, cq: { zone: Z.id, team: me.team, pid: c.pid, def: z.owner, season: w.id, result: null } };
    startPlaying(g); games.set(code, g); markG(g); scheduleBot(g);
    return { code };
  },
  tcreate(c, m) { return tourCreate(c, m); },
  tjoin(c, m) {
    const t = tourOf(m.code); if (!t) throw new Err('not_found');
    if (t.status !== 'open') throw new Err('forbidden');
    if (!t.entrants.includes(c.pid)) {
      if (t.entrants.length >= t.size) throw new Err('full');
      if (allTours().filter(x => x.status !== 'done' && x.entrants.includes(c.pid)).length >= 5) throw new Err('too_many');
      t.entrants.push(c.pid); saveT(t);
      if (t.entrants.length === t.size) tourStart(t);
    }
    return {};
  },
  tleave(c, m) {
    const t = tourOf(m.code); if (!t) throw new Err('not_found');
    if (t.status !== 'open' || !t.entrants.includes(c.pid)) throw new Err('forbidden');
    t.entrants = t.entrants.filter(x => x !== c.pid);
    if (!t.entrants.length) { meta.delete('t:' + t.code); saveT(t); return {}; }
    if (t.host === c.pid) t.host = t.entrants[0];
    saveT(t); return {};
  },
  tstart(c, m) {
    const t = tourOf(m.code); if (!t) throw new Err('not_found');
    if (t.host !== c.pid || t.status !== 'open') throw new Err('forbidden');
    tourStart(t); return {};
  },
  tview(c, m) {
    const t = tourOf(m.code); if (!t) throw new Err('not_found');
    return { tour: tourView(t, c.pid) };
  },
  tlist(c) {
    const mine = [], open = [], p = players.get(c.pid), now = Date.now();
    for (const t of allTours()) {
      const inside = t.entrants.includes(c.pid);
      if (inside) { if (t.status !== 'done' || now - (t.finished || 0) < 3 * DAY) mine.push(tourSummary(t, c.pid)); }
      else if (t.status === 'open' && t.public && t.entrants.length < t.size) open.push(tourSummary(t, c.pid));
    }
    mine.sort((a, b) => (b.turn - a.turn) || (b.playing - a.playing) || b.created - a.created);
    open.sort((a, b) => b.created - a.created);
    return { mine, open: open.slice(0, 20), trophies: p.trophies || 0 };
  },
  top(c) {
    const all = [...players.values()].filter(p => p.games > 0).sort((a, b) => b.elo - a.elo || b.games - a.games);
    const top = all.slice(0, 20).map(p => ({ name: p.name, elo: p.elo, games: p.games, wins: p.wins, me: p.pid === c.pid, bot: !!p.res }));
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
  try { getWorld(now); } catch (e) { console.error('conquête :', e); }
  remindTurns(now);
  tourTick(now);
  residentTick(now);
  for (const g of [...games.values()]) {
    if (g.status === 'playing') scheduleBot(g);                // reprise après un redémarrage
    if (g.status === 'playing' && g.mode === 'long' && g.deadline && now > g.deadline) {
      log(`délai dépassé : partie ${g.code}, place ${g.turn} éliminée`);
      eliminate(g, g.turn); pushGame(g);
    }
    if (g.status === 'waiting' && now - g.created > 7 * DAY) dropGame(g.code);
    else if (g.status === 'done' && now - g.updated > 30 * DAY) dropGame(g.code);
    else if (g.status === 'playing' && g.mode === 'live' && !g.tour && now - g.updated > 3 * DAY) dropGame(g.code);
  }
}
function applyGrace() {   // après un redémarrage (ou un réveil), chacun garde au moins GRACE_MS pour jouer
  const now = Date.now();
  for (const t of allTours()) if (t.status === 'running' && t.deadline && t.deadline < now + GRACE_MS) { t.deadline = now + GRACE_MS; saveT(t); }
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

/* ======================= remise à zéro ponctuelle ======================= */
// Exécutée une seule fois (le drapeau est gardé dans la base) au premier démarrage qui suit la mise en ligne :
// retire les joueurs [BOT] et leurs parties, réinitialise la Conquête (carte, scores, saisons passées, camps) et efface les tournois.
const RESET_ID = 'reset-2026-10-28';
function runResets() {
  if (!loadOk || meta.get(RESET_ID) || (TEST && process.env.SKIP_RESET === '1')) return;
  let nb = 0, nt = 0, ng = 0;
  const resIds = new Set([...players.values()].filter(p => p.res).map(p => p.pid));
  for (const g of [...games.values()]) if (g.tour || g.cq || g.players.some(x => resIds.has(x))) { dropGame(g.code); ng++; }
  for (const pid of resIds) { players.delete(pid); markP(pid); nb++; }
  for (const t of allTours()) { meta.delete('t:' + t.code); saveT(t); nt++; }
  for (const p of players.values()) {
    if (p.cq || p.trophies) { delete p.cq; delete p.trophies; markP(p.pid); }
  }
  meta.delete('conquest'); markM('conquest'); world = null; cqCache = { t: 0 };
  meta.set(RESET_ID, { at: Date.now() }); markM(RESET_ID);
  log(`remise à zéro : ${nb} [BOT] retirés, ${nt} tournois effacés, ${ng} parties supprimées, Conquête réinitialisée`);
}

/* ======================= démarrage ======================= */
async function main() {
  await loadAll();
  runResets();
  ensureResidents();
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
