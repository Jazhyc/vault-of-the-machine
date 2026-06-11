import { MAX_PLAYERS } from '/shared/constants.js';

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.myId = null;
    this.connected = false;
    this.handlerMs = 0; // ws-handler time since last frame (spike profiler reads & resets)
  }

  on(type, fn) { this.handlers[type] = fn; }

  connect(name, cls) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}`);
      this.ws = ws;
      ws.onopen = () => this.send({ t: 'join', name, cls });
      ws.onmessage = (ev) => {
        const t0 = performance.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'welcome') {
          this.myId = m.id; this.connected = true;
          resolve(m.id);
        } else if (m.t === 'full' && !this.connected) {
          reject(new Error(`Fireteam is full (${MAX_PLAYERS}/${MAX_PLAYERS})`));
        }
        const h = this.handlers[m.t];
        if (h) h(m);
        this.handlerMs += performance.now() - t0;
      };
      ws.onerror = () => { if (!this.connected) reject(new Error('Could not reach the raid server')); };
      ws.onclose = () => {
        if (!this.connected) reject(new Error('Connection closed'));
        this.connected = false;
        if (this.handlers._closed) this.handlers._closed();
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendState(pos, yaw, pitch) { this.send({ t: 'state', pos, yaw, pitch }); }
  fire(w, from, dir) { this.send({ t: 'fire', w, from, dir }); }
  hit(target, dmg, weapon) { this.send({ t: 'hit', target, dmg, weapon }); }
  explode(kind, p) { this.send({ t: 'explode', kind, p }); }
  superCast(dir) { this.send({ t: 'superCast', dir }); }
  interact() { this.send({ t: 'interact' }); }
  sigil(i) { this.send({ t: 'sigil', i }); }
}
