/* Mode Royale de Propagation : carte irrégulière, manches simultanées, zone qui rétrécit.
   Module partagé : le serveur résout chaque manche, la page rejoue la même résolution pour l'animation. */
(function (root) {
  'use strict';

  const START_POINTS = 3;          // chacun démarre avec une case de 3 points : elle déborde dès la première manche
  const ZONE_START = 6;            // la zone commence à rétrécir à la fin de la 6e manche...
  const ZONE_EVERY = 2;            // ...puis toutes les 2 manches
  const ZONE_STEPS = 10;           // 10 rétrécissements jusqu'à la zone finale
  const ZONE_FINAL = 1.6;          // rayon de la zone finale (en cases)
  const ZONE_WARN = 2;             // la zone suivante est annoncée 2 manches avant
  const ROUND_CAP = 70;            // au-delà, la partie s'arrête aux points
  const ROUND_MS = 10000;          // durée d'une manche (hors animation)
  const SIZES = [16, 20, 24];      // nombres de joueurs proposés

  // Générateur pseudo-aléatoire à graine (mulberry32) : la même graine donne la même carte.
  function rng(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function nbs(n, h, alive, i) {
    const x = i % n, y = (i - x) / n, r = [];
    if (x > 0 && alive[i - 1]) r.push(i - 1);
    if (x < n - 1 && alive[i + 1]) r.push(i + 1);
    if (y > 0 && alive[i - n]) r.push(i - n);
    if (y < h - 1 && alive[i + n]) r.push(i + n);
    return r;
  }

  // Bruit de valeurs lissé : grille grossière interpolée.
  function noiseField(R, n, h, cells) {
    const gw = cells + 2, g = Array.from({ length: gw * gw }, () => R());
    const sm = t => t * t * (3 - 2 * t);
    return (x, y) => {
      const u = x / (n - 1) * cells, v = y / (h - 1) * cells, i = Math.floor(u), j = Math.floor(v), fu = sm(u - i), fv = sm(v - j);
      const a = g[j * gw + i], b = g[j * gw + i + 1], c = g[(j + 1) * gw + i], d = g[(j + 1) * gw + i + 1];
      return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
    };
  }

  function components(n, h, alive) {
    const comp = new Array(n * h).fill(-1), sizes = [];
    for (let s = 0; s < n * h; s++) {
      if (!alive[s] || comp[s] >= 0) continue;
      const id = sizes.length; let size = 0; const q = [s]; comp[s] = id;
      while (q.length) { const k = q.pop(); size++; for (const m of nbs(n, h, alive, k)) if (comp[m] < 0) { comp[m] = id; q.push(m); } }
      sizes.push(size);
    }
    return { comp, sizes };
  }

  // Distances en pas depuis un ensemble de cases (parcours en largeur sur les cases vivantes).
  function bfs(n, h, alive, sources) {
    const d = new Array(n * h).fill(-1), q = [];
    sources.forEach(s => { d[s] = 0; q.push(s); });
    for (let k = 0; k < q.length; k++) { const i = q[k]; for (const m of nbs(n, h, alive, i)) if (d[m] < 0) { d[m] = d[i] + 1; q.push(m); } }
    return d;
  }

  // Carte irrégulière : une forme arrondie dont le contour est déformé par du bruit, trouée de quelques lacs.
  // Retourne { n, h, alive (0/1), starts (np cases), eye, r0 }.
  function genMap(np, seed) {
    const R = rng(seed);
    const per = 16;                                         // environ 16 cases vivantes par joueur
    for (let attempt = 0; attempt < 40; attempt++) {
      const side = Math.ceil(Math.sqrt(np * per / 0.8));
      const n = side + Math.floor(R() * 3) - 1, h = side + Math.floor(R() * 3) - 1;
      const f1 = noiseField(R, n, h, 4), f2 = noiseField(R, n, h, 9);
      const cx = (n - 1) / 2, cy = (h - 1) / 2, alive = new Array(n * h).fill(0);
      const thr = 0.86 + 0.012 * attempt;
      for (let y = 0; y < h; y++) for (let x = 0; x < n; x++) {
        const dx = Math.abs(x - cx) / (n / 2), dy = Math.abs(y - cy) / (h / 2);
        const d = Math.pow(Math.pow(dx, 3) + Math.pow(dy, 3), 1 / 3);          // forme de carré arrondi
        const wob = (f1(x, y) - .5) * .5 + (f2(x, y) - .5) * .22;
        if (d + wob < thr) alive[y * n + x] = 1;
      }
      // lacs : des disques retirés de l'intérieur, tant que la carte reste d'un seul tenant
      const lakes = 3 + Math.floor(R() * 4);
      for (let k = 0; k < lakes; k++) {
        const lx = 3 + R() * (n - 6), ly = 3 + R() * (h - 6), lr = 1.1 + R() * 1.6, save = alive.slice();
        for (let y = 0; y < h; y++) for (let x = 0; x < n; x++) if (Math.hypot(x - lx, y - ly) < lr) alive[y * n + x] = 0;
        const cc = components(n, h, alive);
        if (cc.sizes.length > 1 && cc.sizes.filter(s => s > 6).length > 1) for (let i = 0; i < alive.length; i++) alive[i] = save[i];
      }
      // plus grande masse seulement ; on retire les cases qui n'ont qu'un voisin (impasses d'une case)
      const cc = components(n, h, alive); let best = 0; cc.sizes.forEach((s, i) => { if (s > cc.sizes[best]) best = i; });
      for (let i = 0; i < alive.length; i++) if (alive[i] && cc.comp[i] !== best) alive[i] = 0;
      for (let pass = 0; pass < 3; pass++) for (let i = 0; i < alive.length; i++) if (alive[i] && nbs(n, h, alive, i).length < 2) alive[i] = 0;
      const live = alive.reduce((a, b) => a + b, 0);
      if (live < np * 13 || live > np * 22) continue;
      const starts = pickStarts(n, h, alive, np, R);
      if (!starts) continue;
      // l'œil de la zone : une case près du centre de gravité
      let sx = 0, sy = 0; for (let i = 0; i < alive.length; i++) if (alive[i]) { sx += i % n; sy += Math.floor(i / n); }
      sx /= live; sy /= live;
      const near = []; for (let i = 0; i < alive.length; i++) if (alive[i] && Math.hypot(i % n - sx, Math.floor(i / n) - sy) < 3.5 && nbs(n, h, alive, i).length >= 3) near.push(i);
      if (!near.length) continue;
      const eye = near[Math.floor(R() * near.length)];
      let r0 = 0; for (let i = 0; i < alive.length; i++) if (alive[i]) r0 = Math.max(r0, dist(n, i, eye));
      return { n, h, alive, starts, eye, r0: Math.ceil(r0) + .5 };
    }
    // repli : carré plein (ne devrait jamais arriver)
    const n = 20, h = 20, alive = new Array(n * h).fill(1), starts = pickStarts(n, h, alive, np, R);
    return { n, h, alive, starts, eye: 10 * n + 10, r0: 14.5 };
  }
  function dist(n, i, j) { return Math.hypot(i % n - j % n, Math.floor(i / n) - Math.floor(j / n)); }

  // Départs : cases bien éloignées les unes des autres, puis équilibrées pour que chacun ait à peu près la même part de carte.
  function pickStarts(n, h, alive, np, R) {
    const cand = []; for (let i = 0; i < alive.length; i++) if (alive[i] && nbs(n, h, alive, i).length >= 3) cand.push(i);
    if (cand.length < np) return null;
    const starts = [cand[Math.floor(R() * cand.length)]];
    while (starts.length < np) {
      const d = bfs(n, h, alive, starts); let best = -1, bd = -1;
      for (const i of cand) if (!starts.includes(i) && d[i] > bd) { bd = d[i]; best = i; }
      starts.push(best);
    }
    const areas = st => {                                           // part de carte la plus proche de chaque départ
      const own = new Array(n * h).fill(-1), dd = new Array(n * h).fill(-1), q = [];
      st.forEach((s, k) => { own[s] = k; dd[s] = 0; q.push(s); });
      for (let k = 0; k < q.length; k++) { const i = q[k]; for (const m of nbs(n, h, alive, i)) if (dd[m] < 0) { dd[m] = dd[i] + 1; own[m] = own[i]; q.push(m); } }
      const a = new Array(st.length).fill(0); own.forEach(o => { if (o >= 0) a[o]++; });
      return a;
    };
    const score = st => { const a = areas(st), m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((s, v) => s + (v - m) * (v - m), 0); };
    let cur = score(starts);
    for (let it = 0; it < 400; it++) {
      const k = Math.floor(R() * np), old = starts[k];
      const opts = cand.filter(i => i !== old && !starts.includes(i) && dist(n, i, old) <= 3);
      if (!opts.length) continue;
      starts[k] = opts[Math.floor(R() * opts.length)];
      const s = score(starts);
      if (s <= cur) cur = s; else starts[k] = old;
    }
    return starts;
  }

  // Rayon de la zone après k rétrécissements.
  const zoneRadius = (r0, k) => r0 + (ZONE_FINAL - r0) * Math.min(k, ZONE_STEPS) / ZONE_STEPS;
  // Nombre de rétrécissements déjà faits quand 'round' manches sont terminées.
  const zoneSteps = round => (round < ZONE_START ? 0 : Math.min(ZONE_STEPS, Math.floor((round - ZONE_START) / ZONE_EVERY) + 1));
  // Prochaine manche (nombre de manches terminées) à laquelle la zone rétrécit, ou 0 s'il n'y en a plus.
  function zoneNext(round) {
    const k = zoneSteps(round);
    if (k >= ZONE_STEPS) return 0;
    return ZONE_START + k * ZONE_EVERY;
  }

  // Une manche : tout le monde pose un point en même temps, puis les débordements se propagent ensemble, vague après vague.
  // Quand plusieurs joueurs envoient des points sur la même case dans la même vague, le plus gros apport l'emporte
  // (à égalité : le propriétaire actuel, sinon un tirage fixé par la manche et la case).
  // board : { n, h, alive, o, c } ; picks : [[place, case], …] ; round : numéro de manche (pour les égalités).
  function resolve(board, picks, round) {
    const n = board.n, h = board.h, alive = board.alive, o = board.o.slice(), c = board.c.slice();
    const frames = [];
    const got0 = [];
    for (const [s, i] of picks) { c[i] += 1; o[i] = s; got0.push(i); }
    frames.push({ o: o.slice(), c: c.slice(), got: got0 });
    let winner = -1;
    for (let w = 0; w < 3000; w++) {
      const hot = []; for (let k = 0; k < c.length; k++) if (c[k] >= 4) hot.push(k);
      if (!hot.length) break;
      const prev = o.slice(), inc = new Map();
      for (const k of hot) c[k] -= 4;
      for (const k of hot) for (const m of nbs(n, h, alive, k)) {
        c[m] += 1;
        let t = inc.get(m); if (!t) { t = new Map(); inc.set(m, t); }
        t.set(prev[k], (t.get(prev[k]) || 0) + 1);
      }
      for (const [m, t] of inc) {
        let best = -1, bc = 0, tie = [];
        for (const [ow, cnt] of t) { if (cnt > bc) { bc = cnt; best = ow; tie = [ow]; } else if (cnt === bc) tie.push(ow); }
        if (tie.length > 1) {
          if (tie.includes(prev[m])) best = prev[m];
          else { let bp = Infinity; for (const ow of tie) { const pr = ((ow + 1) * 7919 + (round + 1) * 104729 + (w + 1) * 31 + m * 1009) % 100003; if (pr < bp) { bp = pr; best = ow; } } }
        }
        o[m] = best;
      }
      for (const k of hot) if (c[k] === 0) o[k] = -1;
      frames.push({ o: o.slice(), c: c.slice(), got: [...inc.keys()] });
      const owners = new Set(); let first = -1;
      for (let k = 0; k < c.length; k++) if (c[k] > 0) { owners.add(o[k]); if (first < 0) first = o[k]; }
      if (owners.size === 1) { winner = first; break; }
    }
    return { frames, o, c, winner };
  }

  // Zone : retire les cases trop loin de l'œil. Retourne les cases qui disparaissent (le plateau est modifié sur place).
  // Ne fait rien s'il ne devait plus rester aucun point en jeu.
  function shrink(board, eye, r) {
    const n = board.n, gone = [];
    for (let i = 0; i < board.alive.length; i++) if (board.alive[i] && dist(n, i, eye) > r) gone.push(i);
    if (!gone.length) return gone;
    let left = false;
    for (let i = 0; i < board.c.length; i++) if (board.c[i] > 0 && board.alive[i] && dist(n, i, eye) <= r) { left = true; break; }
    if (!left) return [];
    for (const i of gone) { board.alive[i] = 0; board.c[i] = 0; board.o[i] = -1; }
    return gone;
  }
  // Cases qui disparaîtront au prochain rétrécissement (annoncées quelques manches avant).
  function danger(board, eye, r0, round) {
    const nx = zoneNext(round); if (!nx || nx - round > ZONE_WARN) return [];
    const r = zoneRadius(r0, zoneSteps(round) + 1), out = [];
    for (let i = 0; i < board.alive.length; i++) if (board.alive[i] && dist(board.n, i, eye) > r) out.push(i);
    return out;
  }

  // Durée de l'animation d'une manche, la même pour le serveur (qui attend) et la page (qui joue).
  const animDelay = nf => (nf <= 40 ? 130 : Math.max(35, Math.floor(5200 / nf)));
  const animMs = nf => 700 + nf * animDelay(nf);

  // IA : choisit une case parmi les siennes. Les niveaux faibles ajoutent du hasard.
  // threat : cases condamnées par la zone (on préfère y faire déborder les points).
  function botPick(board, seat, level, rnd, doomed) {
    const n = board.n, h = board.h, alive = board.alive, o = board.o, c = board.c;
    const own = []; for (let i = 0; i < c.length; i++) if (o[i] === seat && c[i] > 0 && alive[i]) own.push(i);
    if (!own.length) return -1;
    const sigma = Math.max(0, 11 - level) * 0.32;
    let best = own[0], bs = -Infinity;
    for (const i of own) {
      const ns = nbs(n, h, alive, i), nc = c[i] + 1, missing = 4 - ns.length;
      let s = 0;
      if (nc >= 4) {
        for (const m of ns) {
          if (o[m] === seat && c[m] > 0) s += 0.5 + (c[m] >= 3 ? 2.2 : 0);
          else if (c[m] > 0) s += 2 + c[m] * 0.8 + (c[m] >= 3 ? 2.5 : 0);
          else s += 0.9;
        }
        s -= missing * 0.5;
      } else {
        s += 0.55 * nc + (nc === 3 ? 1.6 : 0);
        let enemies = 0; for (const m of ns) if (c[m] > 0 && o[m] !== seat) { enemies++; if (c[m] >= 3) s += (nc === 3 ? 0.6 : -0.4); }
        s += 0.3 * enemies;
      }
      if (doomed && doomed.has(i)) s += nc >= 4 ? 4 : -3;
      s += (rnd() - .5) * 2 * sigma;
      if (s > bs) { bs = s; best = i; }
    }
    return best;
  }

  const api = { START_POINTS, ZONE_START, ZONE_EVERY, ZONE_STEPS, ZONE_FINAL, ZONE_WARN, ROUND_CAP, ROUND_MS, SIZES,
    rng, nbs, genMap, resolve, shrink, danger, zoneRadius, zoneSteps, zoneNext, dist, animDelay, animMs, botPick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Royale = api;
})(typeof window !== 'undefined' ? window : this);
