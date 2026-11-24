// Minimal structured logger: one JSON object per line on stdout/stderr (what Docker and Unraid
// collect). Never pass secrets; fields named like secrets are masked as a safety net.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRETISH = /pass(word)?|secret|token|cookie|authorization|totp|hash/i;

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (SECRETISH.test(k) && v != null && v !== '' && typeof v !== 'boolean') out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = { message: v.message, code: v.code };
    else out[k] = v;
  }
  return out;
}

export function createLogger({ level = 'info', stream = null } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...clean(fields) });
    if (stream) stream(line);
    else (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger = () => createLogger({ stream: () => {} });
