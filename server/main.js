import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { MAX_PLAYERS, CLASSES } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const [rawPath, rawQuery] = (req.url || '/').split('?');
  let url = decodeURIComponent(rawPath);
  if (url === '/api/unlocks') {
    // unlocks are per guardian name — pass ?name= to ask about a specific one
    const name = (new URLSearchParams(rawQuery || '').get('name') || '').slice(0, 16);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ gjally: game.gjallyOwners.has(name) }));
  }
  let file;
  if (url === '/' || url === '/index.html') file = path.join(ROOT, 'public/index.html');
  else if (url === '/vendor/three.module.js') file = path.join(ROOT, 'node_modules/three/build/three.module.js');
  else if (url.startsWith('/shared/')) file = path.join(ROOT, url);
  else file = path.join(ROOT, 'public', url);

  file = path.normalize(file);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const sockets = new Map(); // playerId -> ws
let nextConnId = 1;

const game = new Game((target, msg) => {
  const exclude = msg.exclude;
  if (exclude) delete msg.exclude;
  const data = JSON.stringify(msg);
  if (target) {
    const ws = sockets.get(target);
    if (ws && ws.readyState === ws.OPEN) ws.send(data);
  } else {
    for (const [id, ws] of sockets) {
      if (id === exclude) continue;
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
});

// Raid unlocks persist across server restarts, keyed by guardian name.
const UNLOCKS_FILE = path.join(ROOT, '.unlocks.json');
try {
  const u = JSON.parse(fs.readFileSync(UNLOCKS_FILE, 'utf8'));
  for (const n of u.gjallyNames || []) game.gjallyOwners.add(n);
} catch { /* first run (or pre-per-player format — those unlocks reset) */ }
game.onUnlock = () => {
  fs.writeFile(UNLOCKS_FILE, JSON.stringify({ gjallyNames: [...game.gjallyOwners] }), () => {});
};

wss.on('connection', (ws) => {
  let id = null;
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!id) {
      if (m.t !== 'join') return;
      if (game.players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'full' }));
        return ws.close();
      }
      id = 'p' + nextConnId++;
      sockets.set(id, ws);
      const cls = CLASSES[m.cls] ? m.cls : 'gunslinger';
      const p = game.addPlayer(id, m.name, cls);
      ws.send(JSON.stringify({ t: 'welcome', id, gj: game.gjallyOwners.has(p.name) }));
      game.broadcastSnapshot();
      return;
    }
    try { game.onMessage(id, m); } catch (e) { console.error('msg error', e); }
  });
  ws.on('close', () => {
    if (id) { sockets.delete(id); game.removePlayer(id); }
  });
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;
  try { game.tick(dt); } catch (e) { console.error('tick error', e); }
}, 50);

server.listen(PORT, () => {
  console.log(`SHATTERED VAULT raid server up — http://localhost:${PORT}`);
  console.log(`Fireteam size: 1-${MAX_PLAYERS}. Share your LAN address for co-op.`);
});
