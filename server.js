// Propagation : serveur de parties. Aucune dépendance, Node 18+ : `node server.js`
// Sert la page (index.html) et un petit magasin de documents en temps réel via WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PATH_RE = /^games\/[A-Z0-9]{4}$/;
const MAX_FRAME = 256 * 1024;      // taille max d'un message
const MAX_DOCS = 5000;             // parties gardées en mémoire
const MAX_CLIENTS = 1000;
const TTL_MS = 24 * 3600 * 1000;   // une partie est oubliée après 24 h sans coup

const docs = new Map();            // chemin -> { d, t }
const clients = new Set();

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html introuvable'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(buf);
    });
  } else if (url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Introuvable');
  }
});

/* ---------- WebSocket (RFC 6455, minimal) ---------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key || clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const c = { socket, subs: new Set(), buf: Buffer.alloc(0), frag: [], fragLen: 0 };
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
function sendRaw(c, op, payload) {
  if (!c.socket.destroyed && c.socket.writable) c.socket.write(frame(op, payload));
}
function send(c, obj) { sendRaw(c, 1, Buffer.from(JSON.stringify(obj))); }

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
      if (fin) { const msg = Buffer.concat(c.frag).toString('utf8'); c.frag = []; c.fragLen = 0; handle(c, msg); }
    }
  }
}

/* ---------- protocole ---------- */
// client -> serveur : {t:'sub'|'unsub'|'get'|'set'|'upd', p, d?, id?}
// serveur -> client : {t:'doc', p, d|null}  et  {t:'res', id, ok, d?, code?}
function getDoc(p) { const e = docs.get(p); return e ? e.d : null; }
function broadcast(p) {
  const d = getDoc(p);
  for (const c of clients) if (c.subs.has(p)) send(c, { t: 'doc', p, d });
}
function handle(c, msg) {
  let m;
  try { m = JSON.parse(msg); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const { t, p, id } = m;
  const reply = (ok, extra) => { if (id !== undefined) send(c, Object.assign({ t: 'res', id, ok }, extra)); };
  if (typeof p !== 'string' || !PATH_RE.test(p)) { reply(false, { code: 'invalid_argument' }); return; }
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  if (t === 'sub') { c.subs.add(p); send(c, { t: 'doc', p, d: getDoc(p) }); }
  else if (t === 'unsub') { c.subs.delete(p); }
  else if (t === 'get') { reply(true, { d: getDoc(p) }); }
  else if (t === 'set') {
    if (!isObj(m.d)) { reply(false, { code: 'invalid_argument' }); return; }
    if (!docs.has(p) && docs.size >= MAX_DOCS) { reply(false, { code: 'quota_exceeded' }); return; }
    docs.set(p, { d: m.d, t: Date.now() });
    reply(true); broadcast(p);
  }
  else if (t === 'upd') {
    const cur = docs.get(p);
    if (!cur || !isObj(m.d)) { reply(false, { code: 'invalid_argument' }); return; }
    docs.set(p, { d: Object.assign({}, cur.d, m.d), t: Date.now() });
    reply(true); broadcast(p);
  }
  else reply(false, { code: 'invalid_argument' });
}

/* ---------- entretien ---------- */
setInterval(() => { for (const c of clients) sendRaw(c, 9, Buffer.alloc(0)); }, 25000).unref();
setInterval(() => {
  const limit = Date.now() - TTL_MS;
  for (const [p, e] of docs) if (e.t < limit) docs.delete(p);
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log('Propagation : http://localhost:' + PORT));
