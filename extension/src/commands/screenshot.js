// Capture a screenshot of the visible viewport (or full page) via
// Page.captureScreenshot. Returns a `data:` URL by default.
import { send, enableDomain } from '../cdp.js';

export async function screenshot({ tabId, format = 'png', quality, fullPage = false } = {}) {
  if (!tabId) { const e = new Error('screenshot: tabId required'); e.code = 'BAD_PARAMS'; throw e; }
  await enableDomain(tabId, 'Page');
  const params = { format };
  if (format === 'jpeg' && typeof quality === 'number') params.quality = quality;
  if (fullPage) params.captureBeyondViewport = true;
  const { data } = await send(tabId, 'Page.captureScreenshot', params);
  const dataUrl = `data:image/${format};base64,${data}`;
  return { dataUrl, format, bytes: Math.floor(data.length * 3 / 4) };
}
