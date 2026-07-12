// Keyboard commands via CDP `Input.dispatchKeyEvent` + `Input.insertText`.
//
// Modifier bitmask (CDP):
//   1 = Alt, 2 = Ctrl, 4 = Meta/Cmd, 8 = Shift.
import { send } from '../cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODIFIER_MAP = {
  alt: 1, option: 1,
  ctrl: 2, control: 2,
  cmd: 4, meta: 4, command: 4, super: 4,
  shift: 8,
};

/** Map a friendly key name to CDP { key, code, windowsVirtualKeyCode }. */
const NAMED_KEYS = {
  'enter':       { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
  'return':      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
  'tab':         { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode: 9 },
  'escape':      { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  'esc':         { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  'backspace':   { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode: 8 },
  'delete':      { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
  'arrowleft':   { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
  'arrowright':  { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  'arrowup':     { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
  'arrowdown':   { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
  'home':        { key: 'Home',       code: 'Home',       windowsVirtualKeyCode: 36 },
  'end':         { key: 'End',        code: 'End',        windowsVirtualKeyCode: 35 },
  'pageup':      { key: 'PageUp',     code: 'PageUp',     windowsVirtualKeyCode: 33 },
  'pagedown':    { key: 'PageDown',   code: 'PageDown',   windowsVirtualKeyCode: 34 },
  'space':       { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32 },
};

function resolveKey(name) {
  if (!name) { const e = new Error('key name required'); e.code = 'BAD_PARAMS'; throw e; }
  const lc = String(name).toLowerCase();
  if (NAMED_KEYS[lc]) return { ...NAMED_KEYS[lc], text: NAMED_KEYS[lc].key.length === 1 ? NAMED_KEYS[lc].key : undefined };

  if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit  = /^[0-9]$/.test(upper);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${upper}` : `Key${upper}`,
      text: name,
      windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
    };
  }

  return { key: name, code: name, text: undefined, windowsVirtualKeyCode: 0 };
}

export async function key_down({ tabId, key, modifiers = 0 } = {}) {
  if (!tabId || !key) { const e = new Error('key_down: tabId and key required'); e.code = 'BAD_PARAMS'; throw e; }
  const k = resolveKey(key);
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: k.text ? 'keyDown' : 'rawKeyDown',
    key: k.key, code: k.code, text: k.text,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    modifiers,
  });
  return { ok: true };
}

export async function key_up({ tabId, key, modifiers = 0 } = {}) {
  if (!tabId || !key) { const e = new Error('key_up: tabId and key required'); e.code = 'BAD_PARAMS'; throw e; }
  const k = resolveKey(key);
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k.key, code: k.code,
    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
    modifiers,
  });
  return { ok: true };
}

export async function key_press({ tabId, key, modifiers = 0, holdMs = 0 } = {}) {
  await key_down({ tabId, key, modifiers });
  if (holdMs > 0) await sleep(holdMs);
  await key_up({ tabId, key, modifiers });
  return { ok: true };
}

/**
 * Type a string, character by character, dispatching keyDown/keyUp around an
 * `Input.insertText`. `delayMs` controls per-char pacing (humanizes typing).
 */
export async function type_text({ tabId, text, delayMs = 10 } = {}) {
  if (!tabId || typeof text !== 'string') { const e = new Error('type_text: tabId and text required'); e.code = 'BAD_PARAMS'; throw e; }
  for (const ch of text) {
    if (ch === '\n') {
      await key_press({ tabId, key: 'Enter' });
    } else {
      // For printable chars, `Input.insertText` produces a beforeinput/input
      // event consistent with real typing (and isTrusted from the page POV
      // because it goes through the renderer).
      await send(tabId, 'Input.insertText', { text: ch });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return { ok: true, length: text.length };
}

/**
 * Parse a combo string like "Cmd+Shift+T" or "Ctrl+L" and dispatch it.
 * The last token is the key, the rest are modifiers.
 */
export async function shortcut({ tabId, combo } = {}) {
  if (!tabId || !combo) { const e = new Error('shortcut: tabId and combo required'); e.code = 'BAD_PARAMS'; throw e; }
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 1) { const e = new Error(`shortcut: invalid combo '${combo}'`); e.code = 'BAD_PARAMS'; throw e; }
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIER_MAP[m.toLowerCase()];
    if (!bit) { const e = new Error(`shortcut: unknown modifier '${m}'`); e.code = 'BAD_PARAMS'; throw e; }
    modifiers |= bit;
  }
  await key_press({ tabId, key: keyName, modifiers });
  return { ok: true, modifiers, key: keyName };
}
