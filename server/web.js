// Host the raid over the internet: boots the normal server, then opens a
// public tunnel to it. Prefers cloudflared (no interstitial page, no account);
// falls back to localtunnel (pure npm, also no account).
import { spawn } from 'node:child_process';
import './main.js'; // starts the http+ws raid server on PORT

const PORT = process.env.PORT || 3000;

function banner(url, extra = '') {
  console.log('\n============================================================');
  console.log('  VAULT OF THE MACHINE — PUBLIC FIRETEAM LINK');
  console.log(`\n  ${url}\n`);
  if (extra) console.log(extra);
  console.log('  Share the link with up to 5 friends — they just open it');
  console.log('  in a browser. You can play on http://localhost:' + PORT);
  console.log('============================================================\n');
}

// cloudflared quick tunnel: `cloudflared tunnel --url http://localhost:PORT`
// prints a random https://*.trycloudflare.com URL on stderr.
function tryCloudflared() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let proc;
    try {
      proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
    } catch { return finish(null); }
    const scan = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) finish({ proc, url: m[0] });
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', () => finish(null));      // ENOENT — not installed
    proc.on('exit', () => finish(null));
    setTimeout(() => { if (!done) { try { proc.kill(); } catch {} finish(null); } }, 15000);
  });
}

async function localtunnelLoop() {
  const { default: localtunnel } = await import('localtunnel');
  let failures = 0;
  for (;;) {
    try {
      const tunnel = await localtunnel({ port: Number(PORT) });
      failures = 0;
      // loca.lt shows first-time visitors a reminder page; the "tunnel
      // password" it asks for is simply the host's public IP.
      let pass = '';
      try { pass = (await (await fetch('https://loca.lt/mytunnelpassword')).text()).trim(); } catch {}
      banner(tunnel.url, pass
        ? `  NOTE: on first visit friends see a "tunnel reminder" page.\n  The tunnel password is: ${pass}\n`
        : '');
      await new Promise((res) => { tunnel.on('close', res); tunnel.on('error', res); });
      console.log('Tunnel dropped — reopening…');
    } catch (e) {
      console.error('localtunnel failed:', e.message);
      if (++failures >= 5) {
        console.error('Could not open a tunnel. LAN play still works (npm start).');
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const cf = await tryCloudflared();
if (cf) {
  banner(cf.url);
  cf.proc.on('exit', (code) => {
    console.error(`cloudflared tunnel exited (code ${code}) — public link is down.`);
    console.error('Restart with: npm run web   (LAN play is unaffected)');
  });
} else {
  console.log('cloudflared not found — using localtunnel (loca.lt) instead.');
  console.log('Tip: install cloudflared for a cleaner link with no visitor page.');
  await localtunnelLoop();
}
