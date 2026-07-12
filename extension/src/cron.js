// Minimal, dependency-free cron parser for the extension's scheduler.
//
// Supports standard 5-field expressions evaluated in the browser's LOCAL time:
//
//   ┌───────────── minute        (0 - 59)
//   │ ┌─────────── hour          (0 - 23)
//   │ │ ┌───────── day of month  (1 - 31)
//   │ │ │ ┌─────── month         (1 - 12)
//   │ │ │ │ ┌───── day of week    (0 - 6, Sunday = 0; 7 also = Sunday)
//   * * * * *
//
// Each field accepts: `*`, lists `a,b`, ranges `a-b`, steps `*/n`, `a-b/n`.
// A handful of macros are also accepted (@hourly, @daily, …).
//
// Day-of-month / day-of-week follow the classic Vixie-cron rule: when BOTH are
// restricted, a tick fires if EITHER matches; when one is `*`, only the other
// constrains the schedule.

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const FIELD_RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both Sunday)
];

function parseField(spec, index) {
  const [min, max] = FIELD_RANGES[index];
  const allowed = new Set();

  for (const part of String(spec).split(',')) {
    const chunk = part.trim();
    if (!chunk) throw new Error(`empty term in field ${index + 1}`);

    let step = 1;
    let rangePart = chunk;
    const slash = chunk.indexOf('/');
    if (slash !== -1) {
      rangePart = chunk.slice(0, slash);
      step = Number(chunk.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step '${chunk}'`);
    }

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`non-numeric term '${chunk}'`);
    if (lo < min || hi > max || lo > hi) throw new Error(`out-of-range term '${chunk}' (field ${index + 1})`);

    for (let v = lo; v <= hi; v += step) allowed.add(v === 7 && index === 4 ? 0 : v);
  }

  // Normalise Sunday (both 0 and 7 accepted on input, stored as 0).
  if (index === 4 && allowed.has(7)) {
    allowed.delete(7);
    allowed.add(0);
  }
  return allowed;
}

export function parseCron(expression) {
  const raw = String(expression || '').trim();
  const normalized = MACROS[raw] || raw;
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (got ${fields.length}): "${expression}"`);
  }

  const [minute, hour, dom, month, dow] = fields.map(parseField);
  const domRestricted = fields[2].trim() !== '*';
  const dowRestricted = fields[4].trim() !== '*';

  return { minute, hour, dom, month, dow, domRestricted, dowRestricted };
}

export function validateCron(expression) {
  try {
    parseCron(expression);
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function matches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domOk = parsed.dom.has(date.getDate());
  const dowOk = parsed.dow.has(date.getDay());

  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true;
}

/**
 * Next Date strictly after `from` (default: now) matching the expression,
 * evaluated in local time. Returns null if nothing matches within a year
 * (should never happen for a valid expression).
 */
export function nextRun(expression, from = new Date()) {
  const parsed = parseCron(expression);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = 366 * 24 * 60; // one year of minutes
  for (let i = 0; i < limit; i += 1) {
    if (matches(parsed, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
