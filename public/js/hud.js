import { CLASSES, ENC, PLAYER } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), bossbar: $('bossbar'), bossname: $('bossname'), bossfill: $('bossbarFill'),
      immune: $('immuneTag'), shieldPanel: $('bossShieldPanel'), phase: $('phaseLine'), announce: $('announce'),
      announceMain: $('announceMain'), announceSub: $('announceSub'),
      toasts: $('toasts'), prompt: $('prompt'), readyOuter: $('readyBarOuter'), readyFill: $('readyBarFill'),
      hpFill: $('hpBarFill'), superRing: $('superRing'), superPct: $('superPct'), buffs: $('buffs'),
      roster: $('roster'), vignette: $('vignette'), downed: $('downedOverlay'), downedText: $('downedText'),
      scope: $('scope'), hitmarker: $('hitmarker'), loot: $('lootToast'),
      lootHead: $('lootHead'), lootName: $('lootName'), lootLore: $('lootLore'),
      help: $('help'), helpHint: $('helpHint'), reloadHint: $('reloadHint'),
      wslots: [$('w0'), $('w1'), $('w2')],
      endScreen: $('endScreen'), endTitle: $('endTitle'), endSub: $('endSub'), endStats: $('endStats'),
      flash: $('flash'), goldenFrame: $('goldenFrame'),
      channel: $('channel'), channelLabel: $('channelLabel'), channelFill: $('channelFill'),
    };
    this.rosterRows = new Map();
    this.rosterIds = '';
    this.el.bossname.textContent = ENC.bossName;
    // final-stand threshold notch on the boss bar
    document.getElementById('bossbarMark').style.left = `${ENC.finalFrac * 100}%`;
    this.announceUntil = 0;
    this.hitUntil = 0;
    this.vignetteLevel = 0;
    this.cache = {};
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyH' && document.pointerLockElement) this.el.help.classList.toggle('hidden');
    });
  }

  show() { this.el.hud.classList.remove('hidden'); }

  setText(key, el, text) {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    el.textContent = text;
  }

  toast(text, kind = 'info') {
    const div = document.createElement('div');
    div.className = `toast ${kind}`;
    div.textContent = text;
    this.el.toasts.appendChild(div);
    while (this.el.toasts.children.length > 5) this.el.toasts.firstChild.remove();
    setTimeout(() => { div.style.opacity = '0'; }, 4200);
    setTimeout(() => div.remove(), 5000);
  }

  announce(main, sub = '') {
    this.el.announceMain.textContent = main;
    this.el.announceSub.textContent = sub;
    this.el.announce.style.opacity = '1';
    this.announceUntil = performance.now() / 1000 + 3.2;
  }

  hitmarker(crit) {
    this.el.hitmarker.style.opacity = '1';
    this.el.hitmarker.classList.toggle('crit', !!crit);
    this.hitUntil = performance.now() / 1000 + 0.12;
  }

  hurt() { this.vignetteLevel = Math.min(1, this.vignetteLevel + 0.55); }

  // Full-screen flash (Obliteration white, missile impact blue).
  // Strength 0..1; fades out on its own.
  flash(strength, color = '#fff') {
    const f = this.el.flash;
    f.style.background = color;
    f.style.transition = 'none';
    f.style.opacity = String(strength);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      f.style.transition = 'opacity 0.9s ease-out';
      f.style.opacity = '0';
    }));
  }

  scope(on) {
    if (this._scopeOn === on) return;
    this._scopeOn = on;
    this.el.scope.classList.toggle('hidden', !on);
    document.getElementById('crosshair').style.opacity = on ? '0' : '1';
  }

  prompt(text) {
    if (!text) { this.el.prompt.classList.add('hidden'); return; }
    this.el.prompt.classList.remove('hidden');
    if (this.cache.prompt !== text) {
      this.cache.prompt = text;
      this.el.prompt.innerHTML = text;
    }
  }

  lootToast(item) { this.itemTip('EXOTIC ENGRAM', item, ''); }

  // Item card with a line of lore — used for raid-mechanic pickups too.
  itemTip(header, name, lore) {
    this.el.lootHead.textContent = header;
    this.el.lootName.textContent = name;
    this.el.lootLore.textContent = lore;
    this.el.lootLore.classList.toggle('hidden', !lore);
    this.el.loot.classList.remove('hidden');
    clearTimeout(this._lootTimer);
    this._lootTimer = setTimeout(() => this.el.loot.classList.add('hidden'), 5000);
  }

  endScreen(kind, stats = null) {
    if (!kind) { this.el.endScreen.classList.add('hidden'); return; }
    this.el.endScreen.classList.remove('hidden');
    if (kind === 'win') {
      this.el.endTitle.textContent = 'RAID COMPLETE';
      this.el.endTitle.className = 'title win';
      this.el.endSub.textContent = 'VAULTHUR HAS FALLEN — CLAIM THE CACHE BEFORE THE VAULT RESETS';
    } else {
      this.el.endTitle.textContent = 'DARKNESS CONSUMED YOU';
      this.el.endTitle.className = 'title lose';
      this.el.endSub.textContent = 'THE ENCOUNTER RESETS...';
    }
    // fireteam scoreboard — the server sends it (sorted) with wipe/bossDied
    this.el.endStats.classList.toggle('hidden', !stats || !stats.length);
    this.el.endStats.innerHTML = '';
    if (!stats || !stats.length) return;
    const mkRow = (cells, cls = '') => {
      const row = document.createElement('div');
      row.className = `srow ${cls}`;
      cells.forEach(([text, color], i) => {
        const span = document.createElement('span');
        if (i > 0) span.className = 'sval';
        span.textContent = text; // textContent: guardian names are player input
        if (color) span.style.color = color;
        row.appendChild(span);
      });
      this.el.endStats.appendChild(row);
    };
    mkRow([['GUARDIAN'], ['KILLS'], ['BOSS DMG'], ['KEEPERS']], 'head');
    for (const s of stats) {
      mkRow([
        [s.name, CLASSES[s.cls]?.color],
        [String(s.kills)], [s.dmg.toLocaleString('en-US')], [String(s.keepers)],
      ]);
    }
  }

  update(dt, snap, me, weapons, serverNow, myId) {
    const now = performance.now() / 1000;
    if (now > this.announceUntil) this.el.announce.style.opacity = '0';
    if (now > this.hitUntil) this.el.hitmarker.style.opacity = '0';
    this.vignetteLevel = Math.max(0, this.vignetteLevel - dt * 1.2);
    const lowHp = me && me.hp < 70 && me.hp > 0;
    this.el.vignette.style.opacity = String(Math.min(1, this.vignetteLevel + (lowHp ? 0.45 : 0)));

    if (!snap) return;
    const enc = snap.enc;

    // boss bar
    const showBoss = enc.st !== 'LOBBY';
    this.el.bossbar.classList.toggle('hidden', !showBoss);
    if (showBoss && enc.bossMax > 0) {
      this.el.bossfill.style.width = `${(enc.bossHp / enc.bossMax) * 100}%`;
      this.el.bossfill.classList.toggle('final', enc.st === 'FINAL');
      const shieldOn = enc.shield && !enc.bossDead;
      this.el.immune.classList.toggle('hidden', !shieldOn);
      // ward panel: full while ordinarily immune; during the generator surge
      // it drains right-to-left with the time left (per-frame off server time)
      this.el.shieldPanel.classList.toggle('hidden', !shieldOn);
      if (shieldOn) {
        const frac = enc.sg ? Math.max(0, Math.min(1, (enc.sg - serverNow) / ENC.surgeDur)) : 1;
        this.el.shieldPanel.style.width = `${frac * 100}%`;
      }
    }

    // phase line
    const remain = enc.ends ? enc.ends - serverNow : 0;
    let phase = '', danger = false;
    switch (enc.st) {
      case 'MECH': {
        if (enc.stage === 'KEEPERS') {
          const done = enc.sig ? enc.sig.m.filter(Boolean).length : 0;
          phase = `ROUND ${enc.round} — SKY CODES ${done}/2`;
        } else if (enc.stage === 'HUNT') phase = `ROUND ${enc.round} — WARDS DOWN: SLAY THE KEEPERS`;
        else if (enc.stage === 'FINAL') phase = `ROUND ${enc.round} — GROUND THE HERALD'S WARD`;
        else if (enc.stage === 'MISSILE') phase = `ROUND ${enc.round} — THE LANCE FALLS`;
        else phase = `ROUND ${enc.round} — KEEPERS STIR BEYOND THE GATES`;
        break;
      }
      case 'DAMAGE': phase = `DAMAGE PHASE — ${fmt(remain)}`; break;
      case 'OBLIT': phase = `OBLITERATION IN ${Math.max(0, remain).toFixed(1)}`; danger = true; break;
      case 'FINAL': phase = `FINAL STAND — ANNIHILATION IN ${fmt(remain)}`; danger = true; break;
      case 'VICTORY': phase = 'THE WATCHER IS SLAIN'; break;
      case 'WIPE': phase = 'WIPED'; danger = true; break;
    }
    this.setText('phase', this.el.phase, phase);
    this.el.phase.classList.toggle('danger', danger);

    // ready bar (lobby)
    const showReady = enc.st === 'LOBBY' && enc.ready > 0.05;
    this.el.readyOuter.classList.toggle('hidden', !showReady);
    if (showReady) this.el.readyFill.style.width = `${(enc.ready / enc.readyNeed) * 100}%`;

    if (me) {
      // hp + super
      this.el.hpFill.style.width = `${Math.max(0, (me.hp / PLAYER.maxHp) * 100)}%`;
      this.el.hpFill.classList.toggle('low', me.hp < 70);
      const cls = CLASSES[me.cls];
      this.el.superRing.style.setProperty('--cc', cls.color);
      this.el.superRing.style.setProperty('--p', String(me.sup));
      this.el.superRing.classList.toggle('ready', me.sup >= 99.5);
      this.setText('sup', this.el.superPct, me.sup >= 99.5 ? 'READY' : `${Math.floor(me.sup)}%`);

      // buffs
      let buffs = '';
      if (snap.enc.focus === myId) buffs += `<span class="buff marked">VAULTHUR'S MARK</span>`;
      if (me.gu > serverNow) buffs += `<span class="buff gold">GOLDEN VOLLEY — ${Math.max(0, me.gu - serverNow).toFixed(1)}s</span>`;
      if (me.av > 0 && me.av < ENC.capsulesNeeded) buffs += `<span class="buff viral">ANTIVIRAL ${me.av}/${ENC.capsulesNeeded}</span>`;
      if (me.av >= ENC.capsulesNeeded) buffs += `<span class="buff viral">VIRAL PURGE</span>`;
      if (me.ky) buffs += `<span class="buff gold">AURIC KEY</span>`;
      if (me.wb > serverNow) buffs += `<span class="buff gold">WARDBREAKER — ${Math.max(0, me.wb - serverNow).toFixed(1)}s</span>`;
      if (this.cache.buffs !== buffs) { this.cache.buffs = buffs; this.el.buffs.innerHTML = buffs; }

      // golden super frame
      this.el.goldenFrame.style.opacity = me.gu > serverNow ? '1' : '0';

      // downed overlay
      this.el.downed.classList.toggle('hidden', !me.dn);
      if (me.dn) {
        const left = Math.max(0, (me.bleedAt || 0) - serverNow);
        const solo = snap.players.length <= 1;
        const reviver = snap.players.find(p => p.rt === myId && p.rv > serverNow);
        this.setText('dtext', this.el.downedText,
          reviver ? `${reviver.name.toUpperCase()} IS REVIVING YOU…`
            : solo ? 'YOUR LIGHT FADES...'
              : `A TEAMMATE CAN REVIVE YOU — ${fmt(left)}`);
      }

      // revive channel progress (shown to the reviver and to the downed)
      let ch = null;
      if (me.rv > serverNow && me.rt) {
        const target = snap.players.find(p => p.id === me.rt);
        ch = { label: `REVIVING ${(target?.name || '').toUpperCase()}`, frac: 1 - (me.rv - serverNow) / PLAYER.reviveTime };
      } else if (me.dn) {
        const reviver = snap.players.find(p => p.rt === myId && p.rv > serverNow);
        if (reviver) ch = { label: 'HOLD ON…', frac: 1 - (reviver.rv - serverNow) / PLAYER.reviveTime };
      }
      this.el.channel.classList.toggle('hidden', !ch);
      if (ch) {
        this.setText('chl', this.el.channelLabel, ch.label);
        this.el.channelFill.style.width = `${Math.max(0, Math.min(1, ch.frac)) * 100}%`;
      }
    }

    // weapons
    const ws = weapons.hudState();
    ws.defs.forEach((d, i) => {
      const slot = this.el.wslots[i];
      const st = ws.state[i];
      slot.classList.toggle('cur', i === ws.cur);
      slot.classList.toggle('empty', st.mag === 0 && st.reserves <= 0);
      this.setText(`wn${i}`, slot.querySelector('.wname'), d.name);
      const res = Number.isFinite(st.reserves) ? st.reserves : '∞';
      const ammoEl = slot.querySelector('.wammo');
      const ammoText = `${st.mag} | ${res}`;
      if (this.cache[`wa${i}`] !== ammoText) {
        this.cache[`wa${i}`] = ammoText;
        ammoEl.innerHTML = `${st.mag} <span>| ${res}</span>`;
      }
    });
    this.setText('rh', this.el.reloadHint,
      ws.reloading ? 'RELOADING…' : ws.grenadeIn > 0 ? `GRENADE ${ws.grenadeIn.toFixed(0)}s` : '');

    // roster: persistent rows, updated in place (full innerHTML rebuilds at
    // snapshot rate caused visible DOM churn)
    const ids = snap.players.map(p => p.id).join('|');
    if (this.rosterIds !== ids) {
      this.rosterIds = ids;
      this.rosterRows.clear();
      this.el.roster.innerHTML = '';
      for (const p of snap.players) {
        const c = CLASSES[p.cls]?.color || '#fff';
        const row = document.createElement('div');
        row.className = 'mate';
        row.innerHTML = `
          <div class="mname" style="color:${c}"><span class="nm"></span> <span class="down"></span></div>
          <div class="mhpOuter"><div class="mhpFill"></div></div>
          <div class="msup"><div class="msupFill" style="background:${c}"></div></div>`;
        row.querySelector('.nm').textContent = p.name + (p.id === myId ? ' (YOU)' : '');
        this.el.roster.appendChild(row);
        this.rosterRows.set(p.id, {
          hp: row.querySelector('.mhpFill'), sup: row.querySelector('.msupFill'),
          status: row.querySelector('.down'), lastStatus: '',
        });
      }
    }
    for (const p of snap.players) {
      const row = this.rosterRows.get(p.id);
      if (!row) continue;
      row.hp.style.width = `${Math.max(0, p.hp / PLAYER.maxHp * 100)}%`;
      row.sup.style.width = `${p.sup}%`;
      const status = p.dd ? 'DEAD' : p.dn ? 'DOWN' : '';
      if (row.lastStatus !== status) { row.lastStatus = status; row.status.textContent = status; }
    }
  }
}
