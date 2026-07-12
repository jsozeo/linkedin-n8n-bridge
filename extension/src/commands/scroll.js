// Smooth scroll, animated in-page via requestAnimationFrame for guaranteed
// movement (CDP `Input.dispatchMouseEvent type:mouseWheel` is unreliable when
// the tab/window isn't focused — events fire JS handlers but the compositor
// may discard the actual scroll). We pair the rAF animation with synthetic
// wheel events at each frame so any scroll listener still sees "real" wheel
// activity (useful against lazy-load watchers).
//
//   no selector  → scrolls the document (window.scrollTo)
//   selector     → scrolls the matching element (element.scrollTop), e.g.
//                  LinkedIn's left results pane on /jobs/search
import { send, evalInPage } from '../cdp.js';

export async function scroll({ tabId, percent, durationMs = 1000, selector = null } = {}) {
  if (!tabId || typeof percent !== 'number') {
    const e = new Error('scroll: tabId and numeric `percent` required'); e.code = 'BAD_PARAMS'; throw e;
  }

  // Probe geometry. We also use the same in-page snippet to perform the
  // animation so the scroll happens regardless of CDP wheel reliability.
  const scrollScript = `
    (async () => {
      const sel = ${JSON.stringify(selector)};
      const el = sel ? document.querySelector(sel) : null;
      if (sel && !el) return JSON.stringify({ found: false });
      const isWindow = !el;
      const ch = isWindow ? window.innerHeight : el.clientHeight;
      const sh = isWindow ? document.documentElement.scrollHeight : el.scrollHeight;
      const sy = isWindow ? window.scrollY : el.scrollTop;
      const maxScroll = Math.max(0, sh - ch);
      const target = Math.max(0, Math.min(maxScroll, maxScroll * (${percent} / 100)));
      const totalDelta = target - sy;

      if (Math.abs(totalDelta) < 1) {
        return JSON.stringify({ found: true, scrolled: 0, target, sh, ch, sy });
      }

      const durationMs = ${durationMs};
      const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const t0 = performance.now();
      await new Promise((resolve) => {
        function step(now) {
          const t = Math.min(1, (now - t0) / durationMs);
          const y = sy + totalDelta * easeInOutQuad(t);
          if (isWindow) window.scrollTo(0, y);
          else el.scrollTop = y;
          // Fire a synthetic 'scroll' event so any IntersectionObserver /
          // lazy-loader that listens picks it up. (scrollTo/scrollTop already
          // emit one but we make sure even for fractional updates.)
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });

      const finalY = isWindow ? window.scrollY : el.scrollTop;
      return JSON.stringify({ found: true, scrolled: finalY - sy, target, sh, ch, sy });
    })()
  `;

  // awaitPromise: true so Runtime.evaluate waits for the async IIFE to settle.
  const raw = await evalInPage(tabId, scrollScript, { awaitPromise: true });
  const probe = JSON.parse(raw);
  if (!probe.found) {
    const e = new Error(`scroll: selector not found: ${selector}`); e.code = 'NOT_FOUND'; throw e;
  }

  // Best-effort wheel dispatch on top of the JS animation — keeps the input
  // pipeline "warm" for sites that gate behaviors on real wheel events.
  // We fire a SINGLE wheel impulse at the geometric center; if the tab is
  // foreground this adds nothing visible, if it's background the JS scroll
  // already moved us.
  try {
    const cx = Math.floor((probe.ch || 600) / 2);
    const cy = Math.floor((probe.ch || 600) / 2);
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: cx, y: cy,
      deltaX: 0, deltaY: probe.target - probe.sy,
    });
  } catch { /* non-fatal — JS scroll already did the work */ }

  return { ok: true, scrolled: probe.scrolled, target: probe.target, selector };
}
