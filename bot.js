/* Joueurs IA de Propagation. Aucun apprentissage : une évaluation de position et une recherche en profondeur.
   Les niveaux se distinguent par la profondeur de réflexion et une part de hasard.
   L'Élo de chaque niveau est mesuré par des parties entre les IA (voir BOT_ELO) : il sert de référence fixe. */
'use strict';
const E = require('./engine.js');

// Élo fixe de chaque niveau, mesuré par des parties entre les IA (2 joueurs, grille 8×8, places et premier joueur tirés au sort,
// 250 parties entre niveaux voisins, ajustement de type Bradley-Terry). L'échelle est calée en donnant 1000 au niveau « Amateur » :
// ce sont des repères entre IA, pas une mesure sur de vrais joueurs. Le Novice joue au hasard (mesuré à environ 30, plancher des Élo : 100).
const LEVELS = [
  { level: 1,  name: 'Novice',        elo: 100 },
  { level: 2,  name: 'Apprenti',      elo: 620 },
  { level: 3,  name: 'Débutant',      elo: 810 },
  { level: 4,  name: 'Amateur',       elo: 1000 },
  { level: 5,  name: 'Régulier',      elo: 1100 },
  { level: 6,  name: 'Intermédiaire', elo: 1230 },
  { level: 7,  name: 'Avancé',        elo: 1290 },
  { level: 8,  name: 'Confirmé',      elo: 1400 },
  { level: 9,  name: 'Expert',        elo: 1680 },
  { level: 10, name: 'Maître',        elo: 1800 },
  { level: 11, name: 'Grand maître',  elo: 1960 }
];

const NB = new Map();
function nbTable(n, dead, h) {         // dead : anneaux disparus (mort subite) ; h : hauteur (grille rectangulaire)
  h = h || n;
  const key = n + 'x' + h + ':' + (dead || 0);
  let t = NB.get(key);
  if (!t) { t = []; for (let i = 0; i < n * h; i++) t.push(Int16Array.from(E.neighbors(n, i, dead || 0, h))); NB.set(key, t); }
  return t;
}
const clone = st => ({ n: st.n, h: st.h, dead: st.dead || 0, o: Int8Array.from(st.o), c: Int8Array.from(st.c) });

// Joue le coup du joueur p en i, sur place. Mêmes règles que Engine.simulate. Renvoie le gagnant (ou -1).
function play(st, i, p, TM) {
  const n = st.n, o = st.o, c = st.c, T = nbTable(n, st.dead, st.h);
  c[i] += 1; o[i] = p;
  if (c[i] < 4) return -1;
  let hot = [i];
  for (let w = 0; w < 3000 && hot.length; w++) {
    for (const k of hot) c[k] -= 4;
    const touched = [];
    for (const k of hot) { const nb = T[k]; for (let j = 0; j < nb.length; j++) { const m = nb[j]; const ally = TM && c[m] > 0 && o[m] >= 0 && TM[o[m]] === TM[p]; c[m] += 1; if (!ally) o[m] = p; touched.push(m); } }
    for (const k of hot) if (c[k] === 0) o[k] = -1;
    const next = [], seen = new Set();
    for (const m of touched) if (c[m] >= 4 && !seen.has(m)) { seen.add(m); next.push(m); }
    for (const k of hot) if (c[k] >= 4 && !seen.has(k)) { seen.add(k); next.push(k); }
    hot = next;
  }
  let owner = -2;
  for (let k = 0; k < c.length; k++) if (c[k] > 0) { if (owner === -2) owner = o[k]; else if ((TM ? TM[o[k]] !== TM[owner] : o[k] !== owner)) return -1; }
  return owner >= 0 ? owner : -1;
}

function tally(st, N) {
  const cells = new Array(N).fill(0), pts = new Array(N).fill(0), c = st.c, o = st.o;
  for (let k = 0; k < c.length; k++) if (c[k] > 0) { cells[o[k]]++; pts[o[k]] += c[k]; }
  return { cells, pts };
}
function nextSeat(t, p, N) { for (let k = 1; k <= N; k++) { const q = (p + k) % N; if (t.cells[q] > 0) return q; } return p; }

const WIN = 1e6;
// Valeur de la position pour le joueur me : ses cases et ses points (ceux de son équipe, le cas échéant) contre ceux des adversaires.
function evaluate(t, st, N, me, TM) {
  const val = s => 3 * t.cells[s] + t.pts[s];
  if (!TM) {
    if (t.cells[me] === 0) return -WIN;
    let opp = 0, best = 0, alive = 0;
    for (let s = 0; s < N; s++) {
      if (s === me || t.cells[s] === 0) continue;
      const v = val(s); opp += v; alive++; if (v > best) best = v;
    }
    if (!alive) return WIN;
    return val(me) - (alive > 1 ? 0.5 * (opp / alive) + 0.5 * best : opp);
  }
  const sum = new Map();
  for (let s = 0; s < N; s++) if (t.cells[s] > 0) sum.set(TM[s], (sum.get(TM[s]) || 0) + val(s));
  const mine = sum.get(TM[me]) || 0;
  if (!mine) return -WIN;
  let opp = 0, best = 0, alive = 0;
  for (const [tm, v] of sum) { if (tm === TM[me]) continue; opp += v; alive++; if (v > best) best = v; }
  if (!alive) return WIN;
  return mine - (alive > 1 ? 0.5 * (opp / alive) + 0.5 * best : opp);
}

const myMoves = (st, p) => { const r = []; for (let k = 0; k < st.c.length; k++) if (st.c[k] > 0 && st.o[k] === p) r.push(k); return r; };

class Timeout extends Error {}

function search(st, N, me, mover, depth, alpha, beta, ctx) {
  const TM = ctx.TM, friend = s => (TM ? TM[s] === TM[me] : s === me);
  if (ctx.deadline && (++ctx.nodes & 63) === 0 && Date.now() > ctx.deadline) throw new Timeout();
  const moves = myMoves(st, mover);
  const maxi = friend(mover);
  // classe les coups par évaluation immédiate : meilleurs d'abord (pour moi) ou pires d'abord (adversaire)
  const kids = [];
  for (const i of moves) {
    const ch = clone(st), w = play(ch, i, mover, TM);
    if (w >= 0) {
      const v = friend(w) ? WIN + depth : -WIN - depth;
      if (maxi ? v >= WIN : v <= -WIN) return v;      // coup gagnant (ou perdant) immédiat
      kids.push({ i, ch, t: null, win: v, score: v });
      continue;
    }
    const t = tally(ch, N);
    kids.push({ i, ch, t, win: null, score: evaluate(t, ch, N, me, TM) });
  }
  if (!kids.length) return evaluate(tally(st, N), st, N, me);
  kids.sort((a, b) => maxi ? b.score - a.score : a.score - b.score);
  const K = depth <= 1 ? kids.length : Math.min(kids.length, maxi ? ctx.kMe : ctx.kOpp);
  let best = maxi ? -Infinity : Infinity;
  for (let x = 0; x < K; x++) {
    const k = kids[x];
    let v;
    if (k.win !== null) v = k.win;
    else if (depth <= 1 || k.score <= -WIN) v = k.score;
    else v = search(k.ch, N, me, nextSeat(k.t, mover, N), depth - 1, alpha, beta, ctx);
    if (maxi) { if (v > best) best = v; if (best > alpha) alpha = best; }
    else { if (v < best) best = v; if (best < beta) beta = best; }
    if (beta <= alpha) break;
  }
  return best;
}

// Réglages de chaque niveau
// Niveaux 2 à 8 : on joue le meilleur coup immédiat, avec une part de coups au hasard (de moins en moins).
// Niveaux 9 à 11 : on regarde aussi la réponse de l'adversaire (2 coups de réflexion), avec une part de hasard décroissante.
const D2 = { depth: 2, ms: 0, kMe: 99, kOpp: 5, jitter: 1.5 };
const SETTINGS = {
  2: { greedy: true, random: 0.6, jitter: 2.5 },
  3: { greedy: true, random: 0.45, jitter: 2.5 },
  4: { greedy: true, random: 0.3, jitter: 2.5 },
  5: { greedy: true, random: 0.2, jitter: 2.5 },
  6: { greedy: true, random: 0.12, jitter: 2.5 },
  7: { greedy: true, random: 0.07, jitter: 2.5 },
  8: { greedy: true, random: 0, jitter: 2 },
  9: Object.assign({}, D2, { random: 0.12 }),
  10: Object.assign({}, D2, { random: 0.06 }),
  11: D2
};

// Choisit une case (indice) pour le joueur `seat`. board : { n, o, c } avec des tableaux ordinaires.
function choose(level, board, seat, N, rng, override, teams) {
  const TM = teams ? Array.from({ length: N }, (_, s) => s % teams) : null;
  rng = rng || Math.random;
  const st = { n: board.n, h: board.h || board.n, dead: board.dead || 0, o: Int8Array.from(board.o), c: Int8Array.from(board.c) };
  const moves = myMoves(st, seat);
  if (!moves.length) return -1;
  if (moves.length === 1 || (level <= 1 && !override)) return moves[Math.floor(rng() * moves.length)];
  const S = override || SETTINGS[level] || SETTINGS[3];
  if (S.random && rng() < S.random) return moves[Math.floor(rng() * moves.length)];
  const noise = () => (rng() - 0.5) * 2 * S.jitter;
  const quick = [];
  for (const i of moves) {
    const ch = clone(st), w = play(ch, i, seat, TM);
    if (w >= 0 && (TM ? TM[w] === TM[seat] : w === seat)) return i;     // gagne tout de suite
    quick.push({ i, ch, w, score: w >= 0 ? -WIN : evaluate(tally(ch, N), ch, N, seat, TM) });
  }
  if (S.greedy) { let b = quick[0], bs = -Infinity; for (const q of quick) { const s = q.score + noise(); if (s > bs) { bs = s; b = q; } } return b.i; }
  // recherche : approfondissement progressif, limité par le temps
  const ctx = { nodes: 0, deadline: 0, kMe: S.kMe, kOpp: S.kOpp, TM };
  const t0 = Date.now(); let bestMove = quick.reduce((a, b) => (b.score > a.score ? b : a)).i;
  const maxDepth = S.depth, limit = S.ms ? t0 + S.ms : 0;
  for (let d = 2; d <= maxDepth; d++) {
    ctx.deadline = limit;
    let top = -Infinity, topMove = -1;
    try {
      const scored = [];
      for (const q of quick) {
        if (q.w >= 0) continue;
        const t = tally(q.ch, N);
        const v = evaluate(t, q.ch, N, seat, TM) <= -WIN ? -WIN : search(q.ch, N, seat, nextSeat(t, seat, N), d - 1, -Infinity, Infinity, ctx);
        scored.push({ i: q.i, v });
      }
      for (const s of scored) { const v = s.v + noise(); if (v > top) { top = v; topMove = s.i; } }
      if (topMove >= 0) bestMove = topMove;
    } catch (e) { if (e instanceof Timeout) break; throw e; }
    if (limit && Date.now() > limit) break;
    if (Math.abs(top) >= WIN) break;
  }
  return bestMove;
}

const byLevel = lv => LEVELS.find(l => l.level === lv) || LEVELS[2];
module.exports = { LEVELS, byLevel, choose, play, tally, evaluate };
