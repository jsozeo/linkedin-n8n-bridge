// Mouse + wheel commands via CDP `Input.*`. Events are isTrusted=true.
import { send } from '../cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need(params, keys, cmd) {
  for (const k of keys) {
    if (params?.[k] === undefined || params[k] === null) {
      const e = new Error(`${cmd}: \`${k}\` is required`); e.code = 'BAD_PARAMS'; throw e;
    }
  }
}

export async function mouse_move({ tabId, x, y, steps = 10, startX, startY, stepDelayMs = 12 } = {}) {
  need({ tabId, x, y }, ['tabId', 'x', 'y'], 'mouse_move');
  if (typeof startX === 'number' && typeof startY === 'number' && steps > 1) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: startX + (x - startX) * t,
        y: startY + (y - startY) * t,
      });
      if (i < steps) await sleep(stepDelayMs);
    }
  } else {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }
  return { ok: true };
}

export async function mouse_down({ tabId, x, y, button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  need({ tabId, x, y }, ['tabId', 'x', 'y'], 'mouse_down');
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers });
  return { ok: true };
}

export async function mouse_up({ tabId, x, y, button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  need({ tabId, x, y }, ['tabId', 'x', 'y'], 'mouse_up');
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers });
  return { ok: true };
}

export async function mouse_click({ tabId, x, y, button = 'left', clickCount = 1, modifiers = 0, holdMs = 0 } = {}) {
  need({ tabId, x, y }, ['tabId', 'x', 'y'], 'mouse_click');
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers });
  if (holdMs > 0) await sleep(holdMs);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers });
  return { ok: true };
}

export async function mouse_drag({ tabId, fromX, fromY, toX, toY, steps = 20, button = 'left', stepDelayMs = 15, modifiers = 0 } = {}) {
  need({ tabId, fromX, fromY, toX, toY }, ['tabId', 'fromX', 'fromY', 'toX', 'toY'], 'mouse_drag');
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button, clickCount: 1, modifiers });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
      button, modifiers,
    });
    await sleep(stepDelayMs);
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button, clickCount: 1, modifiers });
  return { ok: true };
}

export async function wheel({ tabId, x, y, deltaX = 0, deltaY = 0 } = {}) {
  need({ tabId, x, y }, ['tabId', 'x', 'y'], 'wheel');
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  return { ok: true };
}
