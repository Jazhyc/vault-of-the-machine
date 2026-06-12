// Client-only control settings (mouse sensitivity + keybinds), persisted
// per-origin in localStorage under 'sv_settings' (same family as
// sv_name/sv_class/sv_loadout — a new tunnel URL is a new origin and resets
// them). The server never sees any of this: sens and binds only shape the
// input that becomes ordinary state/fire/hit messages.
//
// Mutations go through setSens/setBind/resetControls, which save and fire a
// 'sv-settings' window event so bind-dependent UI text can re-render.

const SENS_BASE = 0.0023; // sensMult 1.0 = the original hardcoded feel

const DEFAULT_BINDS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft',
  weapon1: 'Digit1', weapon2: 'Digit2', weapon3: 'Digit3',
  reload: 'KeyR', grenade: 'KeyG', melee: 'KeyV', super: 'KeyF',
  interact: 'KeyE', inventory: 'Tab', help: 'KeyH',
};

// Display order + labels for the rebind UI.
export const ACTIONS = [
  ['forward', 'MOVE FORWARD'], ['back', 'MOVE BACK'],
  ['left', 'MOVE LEFT'], ['right', 'MOVE RIGHT'],
  ['jump', 'JUMP'], ['sprint', 'SPRINT'],
  ['weapon1', 'WEAPON 1'], ['weapon2', 'WEAPON 2'], ['weapon3', 'WEAPON 3'],
  ['reload', 'RELOAD'], ['grenade', 'GRENADE'], ['melee', 'MELEE'],
  ['super', 'SUPER'], ['interact', 'INTERACT'], ['inventory', 'INVENTORY'],
  ['help', 'CONTROLS OVERLAY'],
];

// ESC cancels a rebind capture (and the browser eats it under pointer lock
// anyway) — it may never be bound to an action.
export const RESERVED = new Set(['Escape']);

const stored = (() => {
  try { return JSON.parse(localStorage.getItem('sv_settings') || '{}'); }
  catch { return {}; }
})();

export const settings = {
  sensMult: typeof stored.sensMult === 'number' ? stored.sensMult : 1,
  // merge over defaults so actions added later still get a key
  binds: { ...DEFAULT_BINDS, ...(stored.binds || {}) },
};

export function sens() { return SENS_BASE * settings.sensMult; }
export function code(action) { return settings.binds[action]; }

function save() {
  localStorage.setItem('sv_settings', JSON.stringify(settings));
  dispatchEvent(new Event('sv-settings'));
}

export function setSens(mult) {
  settings.sensMult = Math.max(0.2, Math.min(3, mult));
  save();
}

// Assigning a key already used by another action swaps the two bindings, so
// every action always has a key.
export function setBind(action, c) {
  if (RESERVED.has(c) || !(action in settings.binds)) return;
  const prev = settings.binds[action];
  for (const a of Object.keys(settings.binds)) {
    if (a !== action && settings.binds[a] === c) settings.binds[a] = prev;
  }
  settings.binds[action] = c;
  save();
}

export function resetControls() {
  settings.sensMult = 1;
  settings.binds = { ...DEFAULT_BINDS };
  save();
}

// e.code → short label for hint text and the rebind buttons
export function keyLabel(c) {
  if (!c) return '—';
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Numpad')) return 'NUM ' + c.slice(6);
  const map = {
    Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT', AltRight: 'R-ALT',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    CapsLock: 'CAPS', Backspace: 'BKSP', Enter: 'ENTER',
  };
  return map[c] || c.toUpperCase();
}
