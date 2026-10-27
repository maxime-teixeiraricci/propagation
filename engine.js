/* Règles de Propagation, partagées par le serveur (qui vérifie chaque coup) et la page (qui anime). */
(function (root) {
  'use strict';

  function neighbors(n, i) {
    const x = i % n, y = (i - x) / n, r = [];
    if (x > 0) r.push(i - 1);
    if (x < n - 1) r.push(i + 1);
    if (y > 0) r.push(i - n);
    if (y < n - 1) r.push(i + n);
    return r;
  }

  // Cases de départ, dans l'ordre où elles se suivent autour de la grille (sens des aiguilles d'une montre).
  // 2 joueurs : deux coins opposés. 4 joueurs : les quatre coins. Ces deux cas sont parfaitement symétriques.
  // 8 joueurs : une orbite complète du carré (rotations + miroirs), donc toutes les surfaces sont identiques.
  // 6 joueurs : aucune symétrie parfaite n'existe sur une grille carrée ; ces placements donnent à chacun
  // la même surface (à une case près), la même distance au plus proche adversaire, et le même recul au bord.
  const LAYOUTS = {
    '6-10': [[2, 2], [5, 2], [7, 4], [7, 7], [4, 7], [2, 5]],
    '6-12': [[4, 1], [7, 1], [10, 6], [10, 9], [1, 9], [1, 6]],
    '6-14': [[1, 5], [5, 1], [11, 2], [12, 8], [8, 12], [2, 11]],
    '8-12': [[2, 4], [4, 2], [7, 2], [9, 4], [9, 7], [7, 9], [4, 9], [2, 7]],
    '8-14': [[3, 5], [5, 3], [8, 3], [10, 5], [10, 8], [8, 10], [5, 10], [3, 8]],
    '8-16': [[4, 6], [6, 4], [9, 4], [11, 6], [11, 9], [9, 11], [6, 11], [4, 9]]
  };
  // Nombre de joueurs -> tailles de grille proposées (les trois premières) et taille par défaut (la quatrième).
  const SIZES = { 2: [6, 8, 10, 8], 4: [8, 10, 12, 10], 6: [10, 12, 14, 12], 8: [12, 14, 16, 14] };

  function startCells(n, np) {
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
  function newBoard(n, np, rot) {
    np = np || 2; rot = rot || 0;
    const o = new Array(n * n).fill(-1), c = new Array(n * n).fill(0);
    startCells(n, np).forEach((i, k) => { const p = ((k - rot) % np + np) % np; o[i] = p; c[i] = 1; });
    return { n, o, c };
  }

  // Le joueur p ajoute un point en i. Seuil fixe : 4 points, partout. Les points qui sortent de la grille sont perdus.
  // team (facultatif) : tableau place -> équipe. Un débordement ne prend pas les cases d'un coéquipier : elles reçoivent le point
  // mais restent à leur propriétaire. Sans équipes, tout ce qui est touché passe au joueur p.
  function simulate(board, i, p, team) {
    const n = board.n, o = board.o.slice(), c = board.c.slice();
    c[i] += 1; o[i] = p;
    const frames = [{ o: o.slice(), c: c.slice(), got: [i] }];
    let winner = -1;
    for (let w = 0; w < 3000; w++) {
      const hot = [];
      for (let k = 0; k < c.length; k++) if (c[k] >= 4) hot.push(k);
      if (!hot.length) break;
      const got = new Set();
      for (const k of hot) c[k] -= 4;
      for (const k of hot) for (const m of neighbors(n, k)) {
        const ally = team && c[m] > 0 && o[m] >= 0 && team[o[m]] === team[p];
        c[m] += 1; if (!ally) o[m] = p; got.add(m);
      }
      for (const k of hot) if (c[k] === 0) o[k] = -1;
      frames.push({ o: o.slice(), c: c.slice(), got: [...got] });
      const owners = new Set(); let first = -1;
      for (let k = 0; k < c.length; k++) if (c[k] > 0) { owners.add(team ? team[o[k]] : o[k]); if (first < 0) first = o[k]; }
      if (owners.size === 1) { winner = first; break; }
    }
    return { frames, o, c, winner };
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
  function eloDeltas(ratings, ranks, K) {
    K = K || 32;
    const N = ratings.length, d = new Array(N).fill(0);
    if (N < 2) return d;
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        if (a === b) continue;
        const S = ranks[a] < ranks[b] ? 1 : ranks[a] === ranks[b] ? 0.5 : 0;
        const E = 1 / (1 + Math.pow(10, (ratings[b] - ratings[a]) / 400));
        d[a] += (K / (N - 1)) * (S - E);
      }
    }
    return d.map(Math.round);
  }

  const api = { neighbors, LAYOUTS, SIZES, startCells, newBoard, simulate, nextTurn, tally, ranksFrom, eloDeltas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : this);
