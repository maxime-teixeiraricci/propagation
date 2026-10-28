/* Conquête : un monde commun où quatre camps (eau, feu, air, terre) se disputent des zones.
   Ce module ne contient que les règles (aucun accès au réseau ni au disque) : le serveur lui confie l'état du monde.
   - Chaque zone est une grille a × b où se joue le combat. Elle rapporte (a + b) + (a × b) points par heure à son camp.
   - Une zone a des points de vie (PV). Chaque victoire d'un attaquant contre sa défense en retire un ;
     à zéro, la zone change de camp, repart avec tous ses PV, et le camp vainqueur gagne un bonus de capture.
   - Une saison dure une semaine (du lundi 00 h au lundi suivant, heure de Paris), puis la carte repart de zéro.
   Les points horaires sont calculés à la demande d'après l'heure écoulée : aucun minuteur n'est nécessaire. */
'use strict';

const HOUR = 3600 * 1000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const CAPTURE_BONUS_H = 6;            // bonus de capture : 6 heures de production de la zone
const MAX_EVENTS = 40, MAX_HISTORY = 12;

// Ordre d'affichage des camps. Les camps de départ se placent dans les coins : eau en haut à gauche, puis feu, terre et air dans le sens des aiguilles d'une montre.
const TEAMS = ['eau', 'feu', 'air', 'terre'];
const TEAM_NAMES = { eau: 'Eau', feu: 'Feu', air: 'Air', terre: 'Terre' };
const HOME_ORDER = ['eau', 'feu', 'terre', 'air'];

/* ---------- la carte ----------
   Un carré de 10 × 10 en « moulinet » : quatre quarts identiques tournés de 90°, plus une case centrale.
   Les quatre camps sont donc rigoureusement à égalité (mêmes zones, mêmes distances, mêmes tailles).
   Chaque quart contient une zone de départ (H) et trois zones à prendre (M, N, O).
   a × b est la grille du combat ; lvl est le niveau de l'IA qui défend (voir bot.js) ; pv, les points de vie une fois la zone prise ;
   pv0, ceux d'une zone libre (au début de la saison). */
const TYPES = {
  H: { tile: [0, 0, 2, 4], a: 7, b: 7, lvl: 5, pv: 4 },     // zone de départ
  M: { tile: [2, 0, 2, 2], a: 5, b: 5, lvl: 3, pv: 2, pv0: 1 },
  N: { tile: [4, 0, 2, 2], a: 6, b: 6, lvl: 4, pv: 3, pv0: 1 },
  O: { tile: [2, 2, 4, 2], a: 8, b: 6, lvl: 6, pv: 3, pv0: 2 }
};
const NAMES = {
  eau:   { H: 'Récif d’Azur', M: 'Marais', N: 'Estuaire', O: 'Delta' },
  feu:   { H: 'Caldeira', M: 'Fumerolles', N: 'Cratères', O: 'Volcan' },
  terre: { H: 'Bastion', M: 'Sentier', N: 'Collines', O: 'Vallée' },
  air:   { H: 'Aérie', M: 'Falaises', N: 'Brumes', O: 'Sommets' }
};
const rotate = ([x, y, w, h]) => [10 - y - h, x, h, w];       // quart de tour dans le sens des aiguilles d'une montre
const area = Z => Z.a * Z.b;
const yieldOf = Z => (Z.a + Z.b) + Z.a * Z.b;

const ZONES = [];
HOME_ORDER.forEach((team, k) => {
  for (const t of ['H', 'M', 'N', 'O']) {
    let tile = TYPES[t].tile;
    for (let r = 0; r < k; r++) tile = rotate(tile);
    const T = TYPES[t];
    ZONES.push({ id: team + '-' + t.toLowerCase(), name: NAMES[team][t], kind: t, home: t === 'H' ? team : null, x: tile[0], y: tile[1], w: tile[2], h: tile[3], a: T.a, b: T.b, lvl: T.lvl, pv: T.pv, pv0: t === 'H' ? T.pv : T.pv0 });
  }
});
ZONES.push({ id: 'nexus', name: 'Le Nexus', kind: 'C', home: null, x: 4, y: 4, w: 2, h: 2, a: 10, b: 10, lvl: 8, pv: 5, pv0: 3 });
ZONES.forEach(Z => { Z.income = yieldOf(Z); Z.bonus = CAPTURE_BONUS_H * Z.income; });
const ZONE = Object.fromEntries(ZONES.map(Z => [Z.id, Z]));

// Deux zones sont voisines si elles se touchent par un bord (pas seulement par un coin).
function touches(p, q) {
  const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
  return (ox === 0 && oy > 0) || (oy === 0 && ox > 0);
}
const NEIGHBORS = Object.fromEntries(ZONES.map(Z => [Z.id, ZONES.filter(Y => Y !== Z && touches(Z, Y)).map(Y => Y.id)]));

/* ---------- saison ---------- */
// Décalage de l'heure de Paris par rapport à l'heure UTC, en millisecondes (heure d'été comprise).
function parisOffset(ts) {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
  } catch (e) { return HOUR; }
}
// Semaine de ts : du lundi 00 h au lundi suivant 00 h, heure de Paris. Le 5 janvier 1970 était un lundi.
function seasonBounds(ts) {
  const off = parisOffset(ts), local = ts + off;
  const id = Math.floor((local - 4 * DAY) / WEEK);
  const at = i => { const l = i * WEEK + 4 * DAY; return l - parisOffset(l - off); };
  return { id, start: at(id), end: at(id + 1) };
}

/* ---------- le monde ---------- */
function newWorld(now, history) {
  const b = seasonBounds(now);
  const zones = ZONES.map(Z => ({ id: Z.id, owner: Z.home, hp: Z.home ? Z.pv : Z.pv0, paid: now }));
  return { v: 1, id: b.id, start: b.start, end: b.end, zones, scores: { eau: 0, feu: 0, air: 0, terre: 0 }, events: [], history: history || [] };
}
const zoneOf = (w, id) => w.zones.find(z => z.id === id);

// Verse les points des heures écoulées. Les heures se comptent depuis la prise de la zone.
function settle(w, now) {
  now = Math.min(now, w.end);
  for (const z of w.zones) {
    if (!z.owner) continue;
    const n = Math.floor((now - z.paid) / HOUR);
    if (n > 0) { w.scores[z.owner] += n * ZONE[z.id].income; z.paid += n * HOUR; }
  }
}

// Si la saison est finie, la clôt (en lui versant ses derniers points), l'ajoute à l'historique et renvoie le monde de la saison en cours.
// top : meilleurs joueurs de la saison close (calculés par le serveur).
function rollover(w, now, top) {
  if (now < w.end) return w;
  settle(w, w.end);
  const best = Math.max(...TEAMS.map(t => w.scores[t]));
  const leaders = TEAMS.filter(t => w.scores[t] === best);
  const counts = {}; TEAMS.forEach(t => { counts[t] = w.zones.filter(z => z.owner === t).length; });
  const hist = (w.history || []).concat([{ id: w.id, start: w.start, end: w.end, scores: Object.assign({}, w.scores), zones: counts, winner: best > 0 && leaders.length === 1 ? leaders[0] : null, top: (top || []).slice(0, 3) }]);
  return newWorld(now, hist.slice(-MAX_HISTORY));
}

const owned = (w, team) => w.zones.filter(z => z.owner === team);
const rate = (w, team) => owned(w, team).reduce((s, z) => s + ZONE[z.id].income, 0);

// Une équipe n'attaque qu'une zone voisine d'une des siennes ; sans aucune zone, elle peut attaquer n'importe où.
// Renvoie null si c'est permis, sinon la raison : 'own' (déjà à elle), 'far' (trop loin).
function whyNot(w, team, zoneId) {
  const z = zoneOf(w, zoneId);
  if (!z || !TEAMS.includes(team)) return 'invalid';
  if (z.owner === team) return 'own';
  const mine = owned(w, team);
  if (!mine.length) return null;
  return mine.some(m => NEIGHBORS[m.id].includes(zoneId)) ? null : 'far';
}

function pushEvent(w, ev) { w.events.push(ev); if (w.events.length > MAX_EVENTS) w.events.splice(0, w.events.length - MAX_EVENTS); }

// Un joueur de `team` a battu la défense de la zone. Renvoie ce qui s'est passé.
function hit(w, zoneId, team, now, by) {
  settle(w, now);
  const z = zoneOf(w, zoneId), Z = ZONE[zoneId];
  if (!z || !TEAMS.includes(team)) return { kind: 'none' };
  if (z.owner === team) return { kind: 'own', hp: z.hp, maxHp: Z.pv };
  const prev = z.owner;
  z.hp -= 1;
  if (z.hp > 0) {
    pushEvent(w, { t: now, kind: 'hit', zone: zoneId, team, prev, by: by || '', hp: z.hp });
    return { kind: 'hit', hp: z.hp, maxHp: Z.pv, prev };
  }
  z.owner = team; z.hp = Z.pv; z.paid = now;
  w.scores[team] += Z.bonus;
  pushEvent(w, { t: now, kind: 'capture', zone: zoneId, team, prev, by: by || '', bonus: Z.bonus });
  return { kind: 'capture', hp: Z.pv, maxHp: Z.pv, prev, bonus: Z.bonus };
}

// Vue pour le client : la carte, les scores et ce que `team` peut attaquer.
function snapshot(w, team, now) {
  return {
    season: { id: w.id, start: w.start, end: w.end },
    zones: w.zones.map(z => {
      const Z = ZONE[z.id];
      return { id: z.id, name: Z.name, kind: Z.kind, x: Z.x, y: Z.y, w: Z.w, h: Z.h, a: Z.a, b: Z.b, income: Z.income, bonus: Z.bonus,
        lvl: Z.lvl, maxHp: Z.pv, owner: z.owner, hp: z.hp, home: Z.home, why: team ? whyNot(w, team, z.id) : 'noteam' };
    }),
    scores: Object.assign({}, w.scores),
    rate: Object.fromEntries(TEAMS.map(t => [t, rate(w, t)])),
    counts: Object.fromEntries(TEAMS.map(t => [t, owned(w, t).length])),
    events: w.events.slice(-20).reverse(),
    history: (w.history || []).slice().reverse()
  };
}

module.exports = { HOUR, DAY, WEEK, CAPTURE_BONUS_H, TEAMS, TEAM_NAMES, ZONES, ZONE, NEIGHBORS, yieldOf, area, seasonBounds, parisOffset, newWorld, zoneOf, settle, rollover, rate, owned, whyNot, hit, snapshot };
