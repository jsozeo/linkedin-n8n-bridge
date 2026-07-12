// Raw Runtime.evaluate. Very powerful — callers must trust their JS.
import { evalInPage } from '../cdp.js';

export async function evaluate_js({ tabId, expression, awaitPromise = false } = {}) {
  if (!tabId || typeof expression !== 'string') {
    const e = new Error('evaluate_js: tabId and expression required');
    e.code = 'BAD_PARAMS'; throw e;
  }
  const value = await evalInPage(tabId, expression, { awaitPromise });
  return { value };
}
