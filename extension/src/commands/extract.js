// DOM extraction helpers. All run via Runtime.evaluate with returnByValue.
import { evalInPage } from '../cdp.js';

function jss(v) { return JSON.stringify(v); }

export async function query_selector({ tabId, selector } = {}) {
  if (!tabId || !selector) { const e = new Error('query_selector: tabId+selector required'); e.code = 'BAD_PARAMS'; throw e; }
  const data = await evalInPage(tabId,
    `(() => { const el = document.querySelector(${jss(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), x: r.x, y: r.y, width: r.width, height: r.height, centerX: r.x + r.width/2, centerY: r.y + r.height/2 }; })()`
  );
  return { element: data };
}

export async function get_text({ tabId, selector, trim = true } = {}) {
  if (!tabId || !selector) { const e = new Error('get_text: tabId+selector required'); e.code = 'BAD_PARAMS'; throw e; }
  const text = await evalInPage(tabId,
    `(() => { const el = document.querySelector(${jss(selector)}); if (!el) return null; const t = el.innerText || el.textContent || ''; return ${trim ? 't.trim()' : 't'}; })()`
  );
  return { text };
}

export async function get_html({ tabId, selector, outer = false } = {}) {
  if (!tabId) { const e = new Error('get_html: tabId required'); e.code = 'BAD_PARAMS'; throw e; }
  let expr;
  if (!selector) {
    expr = "document.documentElement.outerHTML";
  } else {
    expr = `(() => { const el = document.querySelector(${jss(selector)}); if (!el) return null; return el.${outer ? 'outerHTML' : 'innerHTML'}; })()`;
  }
  const html = await evalInPage(tabId, expr);
  return { html };
}

export async function get_attribute({ tabId, selector, attribute } = {}) {
  if (!tabId || !selector || !attribute) { const e = new Error('get_attribute: tabId+selector+attribute required'); e.code = 'BAD_PARAMS'; throw e; }
  const value = await evalInPage(tabId,
    `(() => { const el = document.querySelector(${jss(selector)}); return el ? el.getAttribute(${jss(attribute)}) : null; })()`
  );
  return { value };
}

export async function get_value({ tabId, selector } = {}) {
  if (!tabId || !selector) { const e = new Error('get_value: tabId+selector required'); e.code = 'BAD_PARAMS'; throw e; }
  const value = await evalInPage(tabId,
    `(() => { const el = document.querySelector(${jss(selector)}); return el ? ('value' in el ? el.value : null) : null; })()`
  );
  return { value };
}

export async function exists({ tabId, selector } = {}) {
  if (!tabId || !selector) { const e = new Error('exists: tabId+selector required'); e.code = 'BAD_PARAMS'; throw e; }
  const found = await evalInPage(tabId, `!!document.querySelector(${jss(selector)})`);
  return { exists: !!found };
}

export async function count({ tabId, selector } = {}) {
  if (!tabId || !selector) { const e = new Error('count: tabId+selector required'); e.code = 'BAD_PARAMS'; throw e; }
  const n = await evalInPage(tabId, `document.querySelectorAll(${jss(selector)}).length`);
  return { count: n };
}
