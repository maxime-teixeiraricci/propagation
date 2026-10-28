/* Règles de Propagation, partagées par le serveur (qui vérifie chaque coup) et la page (qui anime). */
(function (root) {
  'use strict';

  // Anneau d'une case : distance au bord le plus proche (0 = la bordure de la grille).
  // h : hauteur de la grille (par défaut n, grille carrée). Les zones de la conquête sont des rectangles n × h.
  function ring(n, i, h) { h = h || n; const x = i % n, y = (i - x) / n; return Math.min(x, y, n - 1 - x, h - 1 - y); }
  // Mort subite : nombre maximal d'anneaux qui peuvent disparaître (il reste toujours un carré de 2×2 ou 3×3 au centre).
  const maxDead = (n, h) => Math.max(0, Math.floor((Math.min(n, h || n) - 2) / 2));
  const SUDDEN_START = 30;     // mort subite : la première bordure disparaît au 30e tour...
  const SUDDEN_EVERY = 5;      // ...puis une autre tous les 5 tours
  // Nombre de tours avant le prochain rétrécissement (round : tours déjà terminés).
  const suddenLeft = round => (round < SUDDEN_START ? SUDDEN_START - round : SUDDEN_EVERY - ((round - SUDDEN_START) % SUDDEN_EVERY));

  // dead (facultatif) : nombre d'anneaux disparus. Les cases disparues n'existent plus : les points qui y vont sont perdus.
  function neighbors(n, i, dead, h) {
    h = h || n;
    const x = i % n, y = (i - x) / n, r = [];
    if (x > 0) r.push(i - 1);
    if (x < n - 1) r.push(i + 1);
    if (y > 0) r.push(i - n);
    if (y < h - 1) r.push(i + n);
    return dead ? r.filter(m => ring(n, m, h) >= dead) : r;
  }

  // Cases de départ, dans l'ordre où elles se suivent autour de la grille (sens des aiguilles d'une montre).
  // 2 joueurs : deux coins opposés. 4 joueurs : les quatre coins. Ces deux cas sont parfaitement symétriques.
  // 8 joueurs : une orbite complète du carré (rotations + miroirs), donc toutes les surfaces sont identiques.
  // 6 joueurs : aucune symétrie parfaite n'existe sur une grille carrée ; ces placements donnent à chacun
  // la même surface (à une case près), la même distance au plus proche adversaire, et le même recul au bord.
  const LAYOUTS = {
    '6-9': [[1, 1], [4, 1], [7, 1], [7, 7], [4, 7], [1, 7]],          // surfaces rigoureusement égales
    '6-10': [[2, 2], [5, 2], [7, 4], [7, 7], [4, 7], [2, 5]],
    '6-12': [[4, 1], [7, 1], [10, 6], [10, 9], [1, 9], [1, 6]],
    '6-14': [[1, 5], [5, 1], [11, 2], [12, 8], [8, 12], [2, 11]],
    '8-10': [[1, 3], [3, 1], [6, 1], [8, 3], [8, 6], [6, 8], [3, 8], [1, 6]],   // orbite complète : surfaces rigoureusement égales
    '8-12': [[2, 4], [4, 2], [7, 2], [9, 4], [9, 7], [7, 9], [4, 9], [2, 7]],
    '8-14': [[3, 5], [5, 3], [8, 3], [10, 5], [10, 8], [8, 10], [5, 10], [3, 8]],
    '8-16': [[4, 6], [6, 4], [9, 4], [11, 6], [11, 9], [9, 11], [6, 11], [4, 9]]
  };
  // Nombre de joueurs -> tailles de grille proposées (les trois premières) et taille par défaut (la quatrième).
  const SIZES = { 2: [5, 6, 8, 6], 4: [6, 8, 10, 8], 6: [9, 10, 12, 10], 8: [10, 12, 14, 12] };

  function startCells(n, np, h) {
    if (h && h !== n) return np === 2 ? [n + 1, (h - 2) * n + n - 2] : [];      // rectangle : deux départs symétriques (rotation de 180°)
    const t = LAYOUTS[np + '-' + n];
    if (t) return t.map(([x, y]) => y * n + x);
    const m = n - 2, L = 4 * (m - 1), out = [];
    for (let k = 0; k < np; k++) {
      const u = Math.round(k * L / np) % L, side = Math.floor(u / (m - 1)), q = u % (m - 1);
      let x, y;
      if (side === 0) { x = 1 + q; y = 1; } else if (side === 1) { x = m; y = 1 + q; }
      else if (side === 2) { x = m - q; y = m; } else { x = 1; y = m - q; }
      out.push(y * n + x);
    }
    return out;
  }

  // rot : décalage des places (le joueur k prend la k+rot-ième case de départ), tiré au sort à chaque partie.
  function newBoard(n, np, rot, h) {
    np = np || 2; rot = rot || 0; h = h || n;
    const o = new Array(n * h).fill(-1), c = new Array(n * h).fill(0);
    startCells(n, np, h).forEach((i, k) => { const p = ((k - rot) % np + np) % np; o[i] = p; c[i] = 1; });
    const b = { n, o, c };
    if (h !== n) b.h = h;
    return b;
  }

  // Le joueur p ajoute un point en i. Seuil fixe : 4 points, partout. Les points qui sortent de la grille sont perdus.
  // team (facultatif) : tableau place -> équipe. Un débordement ne prend pas les cases d'un coéquipier : elles reçoivent le point
  // mais restent à leur propriétaire. Sans équipes, tout ce qui est touché passe au joueur p.
  // board.dead : anneaux déjà disparus. board.shrinkTo : si supérieur, la bordure disparaît après le coup (mort subite),
  // sauf si le coup gagne la partie ou s'il ne resterait plus aucune case.
  function simulate(board, i, p, team) {
    const n = board.n, H = board.h || n, o = board.o.slice(), c = board.c.slice(), dead = board.dead || 0;
    c[i] += 1; o[i] = p;
    const frames = [{ o: o.slice(), c: c.slice(), got: [i], dead }];
    let winner = -1;
    for (let w = 0; w < 3000; w++) {
      const hot = [];
      for (let k = 0; k < c.length; k++) if (c[k] >= 4) hot.push(k);
      if (!hot.length) break;
      const got = new Set();
      for (const k of hot) c[k] -= 4;
      for (const k of hot) for (const m of neighbors(n, k, dead, H)) {
        const ally = team && c[m] > 0 && o[m] >= 0 && team[o[m]] === team[p];
        c[m] += 1; if (!ally) o[m] = p; got.add(m);
      }
      for (const k of hot) if (c[k] === 0) o[k] = -1;
      frames.push({ o: o.slice(), c: c.slice(), got: [...got], dead });
      const owners = new Set(); let first = -1;
      for (let k = 0; k < c.length; k++) if (c[k] > 0) { owners.add(team ? team[o[k]] : o[k]); if (first < 0) first = o[k]; }
      if (owners.size === 1) { winner = first; break; }
    }
    let newDead = dead;
    const to = Math.min(board.shrinkTo || 0, maxDead(n, H));
    if (winner < 0 && to > dead) {
      let any = false;
      for (let k = 0; k < c.length; k++) if (c[k] > 0 && ring(n, k, H) >= to) { any = true; break; }
      if (any) {
        for (let k = 0; k < c.length; k++) if (ring(n, k, H) < to) { c[k] = 0; o[k] = -1; }
        newDead = to;
        frames.push({ o: o.slice(), c: c.slice(), got: [], dead: newDead, shrunk: true });
        const owners = new Set(); let first = -1;
        for (let k = 0; k < c.length; k++) if (c[k] > 0) { owners.add(team ? team[o[k]] : o[k]); if (first < 0) first = o[k]; }
        if (owners.size === 1) winner = first;
      }
    }
    return { frames, o, c, winner, dead: newDead };
  }

  // Un coup avec la règle de mort subite. board : { n, o, c, np, dead }. round : tours déjà terminés.
  // Un tour se termine quand on repasse par le premier siège (le jeu revient à un siège de numéro inférieur ou égal).
  // À partir du 30e tour terminé, puis tous les 5 tours, la bordure encore en place disparaît.
  function step(board, i, p, team, sudden, round) {
    round = round || 0;
    let r = simulate(board, i, p, team);
    if (!sudden || r.winner >= 0) { r.round = round; return r; }
    const wrapped = nextTurn(r.o, r.c, p, board.np) <= p;
    if (wrapped) round++;
    const dead = board.dead || 0;
    if (wrapped && round >= SUDDEN_START && (round - SUDDEN_START) % SUDDEN_EVERY === 0 && dead < maxDead(board.n, board.h)) r = simulate(Object.assign({}, board, { shrinkTo: dead + 1 }), i, p, team);
    r.round = round;
    return r;
  }

  // Joueur suivant qui a encore au moins une case (les éliminés sont sautés).
  function nextTurn(o, c, p, np) {
    for (let k = 1; k <= np; k++) {
      const q = (p + k) % np;
      for (let i = 0; i < c.length; i++) if (c[i] > 0 && o[i] === q) return q;
    }
    return p;
  }

  function tally(o, c, np) {
    const t = [];
    for (let k = 0; k < np; k++) t.push({ cells: 0, points: 0 });
    for (let k = 0; k < c.length; k++) if (c[k] > 0 && o[k] >= 0 && t[o[k]]) { t[o[k]].cells++; t[o[k]].points += c[k]; }
    return t;
  }

  // Rangs finaux : le gagnant est 1er, puis les éliminés dans l'ordre inverse de leur élimination.
  // elim : liste de groupes de places éliminées au même moment, dans l'ordre. Les ex æquo partagent le même rang.
  function ranksFrom(np, winner, elim) {
    const ranks = new Array(np).fill(0);
    let r = 1;
    if (winner >= 0) { ranks[winner] = 1; r = 2; }
    for (let g = elim.length - 1; g >= 0; g--) {
      const group = elim[g].filter(s => ranks[s] === 0);
      group.forEach(s => { ranks[s] = r; });
      r += group.length;
    }
    for (let s = 0; s < np; s++) if (ranks[s] === 0) ranks[s] = r;
    return ranks;
  }

  // Élo à N joueurs : chaque paire de joueurs est comptée comme un duel (victoire, nul ou défaite selon le rang),
  // et chaque duel pèse K/(N-1). À deux joueurs, c'est l'Élo classique.
  function eloDeltas(ratings, ranks, K, scale) {
    K = K || 32; scale = scale || 1;
    const N = ratings.length, d = new Array(N).fill(0);
    if (N < 2) return d;
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        if (a === b) continue;
        const S = ranks[a] < ranks[b] ? 1 : ranks[a] === ranks[b] ? 0.5 : 0;
        const E = 1 / (1 + Math.pow(10, (ratings[b] - ratings[a]) / (400 * scale)));
        d[a] += (K / (N - 1)) * (S - E);
      }
    }
    return d.map(Math.round);
  }

  // Rangs : 15 rangs en 3 paliers de 5, notés uniquement par leur lettre : D, C−, C, C+, B−, B, B+, A−, A, A+, S−, S, S+, SS, X. L'échelle d'Élo va de 700 (plancher) à 3500 (début du rang X) : 200 points par rang.
  // Un nouveau joueur (Élo 1000) démarre au milieu de C−. ELO_SCALE étire la courbe d'Élo (écart de 400 → 400 × ELO_SCALE pour 10 contre 1)
  // afin que les écarts entre niveaux d'IA gardent le même sens qu'avant l'élargissement de l'échelle.
  const ELO_MIN = 700, ELO_MAX_RANK = 3500, ELO_SCALE = 2800 / 1860;
  const RANK_TIERS = ['D à B−', 'B à A+', 'S− à X'];
  const RANK_NAMES = ['D', 'C−', 'C', 'C+', 'B−', 'B', 'B+', 'A−', 'A', 'A+', 'S−', 'S', 'S+', 'SS', 'X'];
  const RANK_FLOORS = Array.from({ length: 15 }, (_, i) => 700 + 200 * i);
  // Le rang X n'a pas de plafond : X0 à partir de 3500, puis X1 à 3700, X2 à 3900… (un sous-niveau tous les 200 points).
  function rankOf(elo) {
    elo = Math.max(RANK_FLOORS[0], Math.round(Number(elo) || 0));
    let k = 0;
    for (let i = 0; i < RANK_FLOORS.length; i++) if (elo >= RANK_FLOORS[i]) k = i;
    const top = k === RANK_FLOORS.length - 1;
    const sub = top ? Math.floor((elo - RANK_FLOORS[k]) / 200) : -1;
    const lo = top ? RANK_FLOORS[k] + 200 * sub : RANK_FLOORS[k], hi = top ? lo + 200 : RANK_FLOORS[k + 1];
    return { index: k, level: k + Math.max(sub, 0), sub, tier: Math.floor(k / 5), tierName: RANK_TIERS[Math.floor(k / 5)], pos: k % 5 + 1,
      name: top ? 'X' + sub : RANK_NAMES[k], letter: top ? 'X' + sub : RANK_NAMES[k],
      lo, hi, progress: (elo - lo) / (hi - lo), toNext: hi - elo, nextName: top ? 'X' + (sub + 1) : RANK_NAMES[k + 1] };
  }

  const api = { ELO_MIN, ELO_MAX_RANK, ELO_SCALE, RANK_TIERS, RANK_NAMES, RANK_FLOORS, rankOf, neighbors, ring, maxDead, SUDDEN_START, SUDDEN_EVERY, suddenLeft, LAYOUTS, SIZES, startCells, newBoard, simulate, step, nextTurn, tally, ranksFrom, eloDeltas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : this);
