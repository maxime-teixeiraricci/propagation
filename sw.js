/* Service worker de Propagation : reçoit le signal « c'est ton tour » et affiche la notification. */
'use strict';

const fmtLeft = ms => {
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  if (h >= 48) return Math.round(h / 24) + ' jours';
  if (h >= 1) return h + ' h' + (m % 60 >= 10 && h < 6 ? ' ' + String(m % 60).padStart(2, '0') : '');
  return Math.max(1, m) + ' min';
};

// Texte de la notification selon les parties qui attendent ce joueur.
function describe(games) {
  if (!games || !games.length) return { body: 'Ouvre le jeu pour voir tes parties.', url: '/' };
  if (games.length === 1) {
    const g = games[0];
    const left = g.left != null ? ` Il te reste ${fmtLeft(g.left)}.` : '';
    return { body: `Partie ${g.code} : à toi de jouer.${left}`, url: '/#' + g.code };
  }
  const urgent = games.find(g => g.left != null);
  return { body: `À toi de jouer dans ${games.length} parties.` + (urgent ? ` La plus pressée : ${fmtLeft(urgent.left)}.` : ''), url: '/' };
}

async function due() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return null;
    const r = await fetch('/api/due', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    if (!r.ok) return null;
    return (await r.json()).games;
  } catch (e) { return null; }
}

self.addEventListener('push', ev => {
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ t: 'push' }));                       // la page ouverte se met à jour
    const games = await due();
    if (games && wins.some(w => w.visibilityState === 'visible')) return;   // la page est sous ses yeux et vient d'être mise à jour
    const d = describe(games);
    await self.registration.showNotification('Propagation', {
      body: d.body, tag: 'tour', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url }
    });
  })());
});

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const url = (ev.notification.data && ev.notification.data.url) || '/';
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); w.postMessage({ t: 'open', url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', ev => ev.waitUntil(self.clients.claim()));
