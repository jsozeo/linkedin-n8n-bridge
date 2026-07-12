// Cookie helpers via chrome.cookies (no CDP needed).

export async function get_cookies({ url, domain, name } = {}) {
  const details = {};
  if (url) details.url = url;
  if (domain) details.domain = domain;
  if (name) details.name = name;
  const cookies = await chrome.cookies.getAll(details);
  return { cookies };
}

export async function set_cookies({ cookies } = {}) {
  if (!Array.isArray(cookies)) {
    const e = new Error('set_cookies: `cookies` must be an array'); e.code = 'BAD_PARAMS'; throw e;
  }
  const out = [];
  for (const c of cookies) {
    if (!c.url) { const e = new Error('set_cookies: each cookie needs a `url`'); e.code = 'BAD_PARAMS'; throw e; }
    const saved = await chrome.cookies.set(c);
    out.push(saved);
  }
  return { saved: out.length, cookies: out };
}

export async function clear_cookies({ url, name } = {}) {
  if (name && url) {
    await chrome.cookies.remove({ url, name });
    return { removed: 1 };
  }
  // Without a name → remove all cookies matching url/domain.
  const list = await chrome.cookies.getAll(url ? { url } : {});
  for (const c of list) {
    const cookieUrl = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
    await chrome.cookies.remove({ url: cookieUrl, name: c.name });
  }
  return { removed: list.length };
}
