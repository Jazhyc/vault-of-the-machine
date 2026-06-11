// End-to-end smoke test: joins via WebSocket, stands on the plate, and
// confirms the encounter starts and enemies spawn.
//
//   node test/smoke.js                       — boots a local server and tests it
//   SMOKE_URL=https://xyz.loca.lt node test/smoke.js — tests a remote/tunneled server
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const remote = process.env.SMOKE_URL ? process.env.SMOKE_URL.replace(/\/$/, '') : null;
const PORT = 3105;
const base = remote || `http://localhost:${PORT}`;
const wsUrl = base.replace(/^http/, 'ws');
// localtunnel serves browsers an interstitial; this header bypasses it.
const headers = { 'bypass-tunnel-reminder': '1', 'user-agent': 'sv-smoke' };

let srv = null;
const die = (msg, code = 1) => { console.error(msg); srv?.kill(); process.exit(code); };
setTimeout(() => die('TIMEOUT: smoke test did not finish in 45s'), 45000).unref();

if (!remote) {
  srv = spawn(process.execPath, ['server/main.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write(d));
  await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('raid server up')) res(); }));
}

// static routes
for (const path of ['/', '/js/main.js', '/shared/constants.js', '/vendor/three.module.js']) {
  const r = await fetch(`${base}${path}`, { headers });
  if (!r.ok) die(`STATIC FAIL ${path} -> ${r.status}`);
  console.log(`  ✓ GET ${path} (${(await r.text()).length} bytes)`);
}

const ws = new WebSocket(wsUrl, { headers });
let sawMech = false, sawEnemy = false, sawBossBar = false;

ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'SmokeBot', cls: 'voidcaller' })));
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.t === 'welcome') {
    console.log(`  ✓ joined as ${m.id} via ${wsUrl}`);
    // stand on the center plate
    setInterval(() => ws.send(JSON.stringify({ t: 'state', pos: [0, 0, 1], yaw: 0, pitch: 0 })), 100).unref();
  }
  if (m.t === 'snap') {
    if (m.enc.st === 'MECH') sawMech = true;
    if (m.enc.bossMax > 0) sawBossBar = true;
    if (m.enemies.length > 0) sawEnemy = true;
    if (sawMech && sawEnemy && sawBossBar) {
      console.log('  ✓ encounter started (MECH), boss HP set, enemies spawned');
      console.log('\nSmoke test passed.');
      ws.close(); srv?.kill();
      process.exit(0);
    }
  }
});
ws.on('error', (e) => die(`WS ERROR: ${e.message}`));
ws.on('close', () => { /* exit handled above or by timeout */ });
