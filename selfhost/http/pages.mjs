// The login page: self-contained (no external assets), styled after Wickline's dark theme.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function loginPage({ next = '/', totp = false, error = '', retryAfterSec = 0 } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Wickline</title>
<style>
  :root { color-scheme: dark light; --bg:#0f1115; --panel:#171a21; --text:#e6e8ee; --muted:#9aa3b2; --line:#2a2f3a; --accent:#2f81f7; --bad:#f85149; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --text:#1d2330; --muted:#5b6475; --line:#dde1e8; --accent:#1f6feb; --bad:#cf222e; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
  form { width:100%; max-width:340px; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 18px; display:flex; align-items:center; gap:8px; }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 6px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:18px; width:100%; padding:10px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  .err { color:var(--bad); font-size:13px; margin:0 0 4px; }
  .foot { color:var(--muted); font-size:12px; margin-top:14px; text-align:center; }
</style>
</head>
<body>
<form method="post" action="/selfhost/login" autocomplete="on">
  <h1><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="color:var(--accent)"><path d="M12 2.5v19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="7.5" y="7" width="9" height="10" rx="2.2" fill="currentColor"/></svg>Wickline</h1>
  ${error ? `<p class="err" role="alert">${esc(error)}${retryAfterSec ? ` Try again in ${retryAfterSec} s.` : ''}</p>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="hidden" name="hash" id="hash" value="">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  ${totp ? `<label for="code">Authenticator code</label>
  <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>` : ''}
  <button type="submit">Sign in</button>
  <p class="foot">Wickline Self-Hosted (unofficial)</p>
</form>
<script>document.getElementById('hash').value = location.hash.slice(0, 2000);</script>
</body>
</html>`;
}
