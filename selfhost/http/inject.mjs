// Injects the synced-state snapshot and the sync agent into upstream's index.html (PLAN §2.3.1).
//
// Right after the single <head> tag (integration point html-head) come:
//   <script type="application/json" id="wl-snapshot">…</script>   the escaped snapshot
//   <script src="/selfhost/boot.js"></script>                       a classic synchronous script
// so boot.js hydrates localStorage before upstream's inline theme script and its modules run.

const HEAD = '<head>';

/**
 * JSON that is inert inside a <script> element: `<`, `>` and `&` are escaped (no `</script>` or
 * `<!--` can end or alter the element), and U+2028/U+2029 too (line terminators in old engines).
 */
export function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const BANNER = '<div role="alert" style="position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:12px 16px;'
  + 'background:#b00020;color:#fff;font:14px/1.4 system-ui,sans-serif">Wickline Self-Hosted could not attach its sync agent '
  + '(upstream index.html has no single &lt;head&gt; tag). Changes on this page stay in this browser. Please report this.</div>';

/**
 * Returns index.html with the snapshot and boot.js injected. If the anchor is missing or
 * ambiguous, the page is served unchanged apart from a visible error banner (a contract test
 * catches this in CI before a release).
 */
export function injectBoot(html, payload) {
  const at = html.indexOf(HEAD);
  if (at < 0 || html.indexOf(HEAD, at + 1) >= 0) {
    const body = html.search(/<body[^>]*>/i);
    if (body < 0) return BANNER + html;
    const end = html.indexOf('>', body) + 1;
    return html.slice(0, end) + BANNER + html.slice(end);
  }
  const end = at + HEAD.length;
  const tags = `\n<script type="application/json" id="wl-snapshot">${scriptSafeJson(payload)}</script>`
    + '\n<script src="/selfhost/boot.js"></script>';
  return html.slice(0, end) + tags + html.slice(end);
}

/** True for the paths upstream answers with index.html ("/", "/index.html", "/%69ndex.html", "/./index.html"). */
export function isIndexPath(pathname) {
  if (pathname === '/') return true;
  let p;
  try { p = decodeURIComponent(pathname); } catch { return false; }
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.length === 0 || (parts.length === 1 && parts[0] === 'index.html');
}
