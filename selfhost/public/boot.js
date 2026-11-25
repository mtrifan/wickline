// Wickline Self-Hosted: the browser sync agent (PLAN §2.3). Loaded as a classic synchronous script
// right after <head>, before upstream's own scripts, by the server's index.html injection.
//
// 1. Hydrate: apply the server snapshot (#wl-snapshot) to localStorage before upstream reads it.
// 2. Capture: patch localStorage.setItem/removeItem for synced `wickline.*` keys. A change marks
//    the key dirty (`wickline-selfhost.dirty.<key>` = the version it was based on); the value is
//    read from localStorage at send time, so nothing is stored twice.
// 3. One leader tab per browser profile (Web Locks, or a localStorage lease where Web Locks is
//    unavailable, as on plain-http LAN addresses) owns the uploads and the single event stream.
//    Other tabs need no channel of their own: their dirty markers and the leader's writes reach
//    every tab as native `storage` events.
// 4. Remote changes: keys upstream listens to (alerts, paper, scripts, lang) are written and a
//    `storage` event dispatched, so they update live. Any other key would need a reload, so the
//    change is held back: a banner offers a reload, and a hidden tab reloads when next shown. A
//    stale local write to a held-back key is then refused by the server (409) instead of quietly
//    undoing the other device's change.
//
// Bookkeeping lives under `wickline-selfhost.*`, which upstream never reads and which never syncs.

(function () {
  'use strict';

  const NS = 'wickline-selfhost.';
  const PREFIX = 'wickline.';
  const DEBOUNCE_MS = 400;
  const KEEPALIVE_MAX = 60_000; // browsers cap keepalive request bodies at 64 KB in total

  let snap;
  try { snap = JSON.parse(document.getElementById('wl-snapshot').textContent); } catch (e) {
    console.error('[wickline-selfhost] no snapshot: sync is off for this page', e);
    return;
  }
  let ls;
  try { ls = window.localStorage; ls.length; } catch (e) {
    console.error('[wickline-selfhost] localStorage is unavailable: sync is off', e);
    return;
  }

  const proto = Storage.prototype;
  const rawGet = proto.getItem;
  const rawSet = proto.setItem;
  const rawRemove = proto.removeItem;
  const rawKey = proto.key;
  const get = (k) => rawGet.call(ls, k);
  const del = (k) => rawRemove.call(ls, k);
  const trySet = (k, v) => {
    try { rawSet.call(ls, k, v); return true; } catch (e) { console.warn('[wickline-selfhost] could not store', k, e); return false; }
  };
  const allKeys = () => { const out = []; for (let i = 0; i < ls.length; i++) out.push(rawKey.call(ls, i)); return out; };

  const cfg = snap.sync || { exact: [], prefixes: [], live: [] };
  const exact = new Set(cfg.exact);
  const live = new Set(cfg.live);
  const nameOf = (full) => (typeof full === 'string' && full.startsWith(PREFIX) ? full.slice(PREFIX.length) : null);
  const isSynced = (name) => name !== null && (exact.has(name) || cfg.prefixes.some((p) => name.startsWith(p) && name.length > p.length));
  const epoch = snap.epoch;

  // --- bookkeeping ----------------------------------------------------------------------------

  const verOf = (name) => Number(get(`${NS}v.${name}`)) || 0;
  const setVer = (name, v) => trySet(`${NS}v.${name}`, String(v));
  const dirtyBase = (name) => { const d = get(`${NS}dirty.${name}`); return d === null ? null : (Number(d) || 0); };
  const markDirty = (name) => { if (dirtyBase(name) === null) trySet(`${NS}dirty.${name}`, String(verOf(name))); };
  const setDirty = (name, base) => trySet(`${NS}dirty.${name}`, String(base));
  const clearDirty = (name) => del(`${NS}dirty.${name}`);
  const dirtyNames = () => allKeys().filter((k) => k.startsWith(`${NS}dirty.`)).map((k) => k.slice(NS.length + 6));
  const cursor = () => Number(get(`${NS}rev`)) || 0;
  const advance = (rev) => { if (rev > cursor()) trySet(`${NS}rev`, String(rev)); };

  function randomId() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b); // works without a secure context, unlike crypto.randomUUID
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  let clientId = get(`${NS}client`);
  if (!clientId || !/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) { clientId = randomId(); trySet(`${NS}client`, clientId); }
  const tabId = randomId();

  const held = new Set(); // remote changes held back until a reload
  let reloadWhenVisible = false;
  let bannerKind = null;
  let ui = null;

  /** Writes a synced key without capture (no echo back to the server). */
  function writeLocal(name, value) {
    const full = PREFIX + name;
    if (value === null) del(full); else trySet(full, value);
  }

  function dispatchStorage(name, oldValue, newValue) {
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: PREFIX + name, oldValue, newValue, storageArea: ls, url: location.href }));
    } catch (e) { console.warn('[wickline-selfhost] could not dispatch a storage event', e); }
  }

  // --- 1. hydration ---------------------------------------------------------------------------

  let previousData = null; // first run on this profile: local values the server's data replaced

  if (get(`${NS}epoch`) !== epoch) {
    const firstRun = get(`${NS}epoch`) === null;
    // Metadata from another epoch (or none) means nothing: start over from the snapshot.
    for (const k of allKeys()) if (k.startsWith(`${NS}v.`) || k.startsWith(`${NS}dirty.`)) del(k);
    del(`${NS}rev`);
    const replaced = {};
    for (const full of allKeys()) {
      const name = nameOf(full);
      if (!isSynced(name)) continue;
      const remote = snap.keys[name];
      const local = get(full);
      if (remote) {
        if (local !== null && (remote.deleted ? null : remote.v) !== local) replaced[name] = local;
      } else if (firstRun) {
        markDirty(name); // the server has never had it: upload this browser's copy
      } else {
        del(full); // a restore or import: this browser mirrors the server's data exactly
      }
    }
    for (const [name, r] of Object.entries(snap.keys)) { writeLocal(name, r.deleted ? null : r.v); setVer(name, r.ver); }
    if (firstRun && Object.keys(replaced).length) previousData = replaced;
    trySet(`${NS}epoch`, epoch);
  } else {
    for (const [name, r] of Object.entries(snap.keys)) {
      // A key changed here but not yet uploaded is resolved by the server when it is sent.
      if (r.ver > verOf(name) && dirtyBase(name) === null) { writeLocal(name, r.deleted ? null : r.v); setVer(name, r.ver); }
    }
  }
  advance(snap.rev);

  // --- 2. write capture -----------------------------------------------------------------------

  proto.setItem = function setItem(key, value) {
    if (this !== ls) return rawSet.call(this, key, value);
    const name = nameOf(String(key));
    if (!isSynced(name)) return rawSet.call(this, key, value);
    const s = String(value);
    const prev = rawGet.call(this, key);
    rawSet.call(this, key, s); // a quota error propagates exactly as it would without us
    if (prev !== s) changed(name); // no-op suppression: upstream rewrites some keys on every boot
    return undefined;
  };
  proto.removeItem = function removeItem(key) {
    if (this !== ls) return rawRemove.call(this, key);
    const name = nameOf(String(key));
    if (!isSynced(name)) return rawRemove.call(this, key);
    const prev = rawGet.call(this, key);
    rawRemove.call(this, key);
    if (prev !== null) changed(name);
    return undefined;
  };

  function changed(name) {
    markDirty(name);
    schedule(name);
    render();
  }

  // --- 3. leader: uploads ---------------------------------------------------------------------

  let leader = false;
  let online = true;
  const timers = new Map();
  const inflight = new Set();
  const again = new Set();
  let retryTimer = null;
  let retryDelay = 2000;

  function schedule(name, delay = DEBOUNCE_MS) {
    if (!leader) return; // the leader hears the dirty marker as a storage event
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => { timers.delete(name); upload(name); }, delay));
  }

  function flushAll(opts) {
    for (const name of dirtyNames()) { clearTimeout(timers.get(name)); timers.delete(name); upload(name, opts); }
  }

  function retryLater() {
    online = false;
    publishStatus();
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; flushAll(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  }

  async function upload(name, { keepalive = false } = {}) {
    if (!leader) return;
    if (inflight.has(name)) { again.add(name); return; }
    const base = dirtyBase(name);
    if (base === null) return;
    const full = PREFIX + name;
    const value = get(full);
    const body = JSON.stringify(value === null ? { baseVersion: base, epoch, clientId } : { value, baseVersion: base, epoch, clientId });
    inflight.add(name);
    render();
    let res;
    let data = {};
    try {
      // fetch() is called synchronously, so a pagehide flush starts before the page goes away.
      res = await fetch(`/api/selfhost/state/${encodeURIComponent(name)}`, {
        method: value === null ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Wickline-Selfhost': '1' },
        body,
        credentials: 'same-origin',
        keepalive: keepalive && body.length <= KEEPALIVE_MAX,
      });
      try { data = await res.json(); } catch { /* empty or not JSON */ }
    } catch {
      inflight.delete(name);
      retryLater();
      return;
    }
    inflight.delete(name);
    if (res.status === 401) { toLogin(); return; }
    if (res.ok) {
      online = true; retryDelay = 2000; publishStatus();
      const now = get(full);
      const merged = 'value' in data && data.value !== value;
      setVer(name, data.version);
      if (now === value) {
        if (merged) { writeLocal(name, data.value); dispatchStorage(name, value, data.value); }
        clearDirty(name);
      } else {
        // Changed again while in flight: send the newer value next. After a merge, keep the original
        // base so the server merges again; basing it on the merged version would drop the entries
        // the merge brought in from the other device.
        if (!merged) setDirty(name, data.version);
        schedule(name);
      }
    } else if (res.status === 409 && data.error === 'conflict') {
      const old = get(full);
      const next = data.deleted ? null : data.value;
      writeLocal(name, next);
      setVer(name, data.version);
      clearDirty(name);
      if (live.has(name)) dispatchStorage(name, old, next);
      notify('replaced', name);
    } else if (res.status === 409 && data.error === 'epoch') {
      notify('restored');
    } else if (res.status === 413 || res.status === 422 || res.status === 400) {
      clearDirty(name); // never accepted as sent; keep the local copy, stop retrying
      if (res.status === 413) notify('quota', name);
      else console.warn('[wickline-selfhost] the server refused', name, data.error);
    } else {
      retryLater();
    }
    if (again.delete(name)) schedule(name, 0);
    render();
  }

  // --- 3. leader: the event stream ------------------------------------------------------------

  let es = null;

  function connect() {
    if (!leader || es) return;
    es = new EventSource(`/api/selfhost/events?epoch=${encodeURIComponent(epoch)}&since=${cursor()}`);
    es.addEventListener('open', () => { online = true; retryDelay = 2000; publishStatus(); flushAll(); });
    es.addEventListener('change', (e) => { try { onRemote(JSON.parse(e.data)); } catch (err) { console.warn('[wickline-selfhost] bad change event', err); } });
    es.addEventListener('reset', () => { disconnect(); notify('restored'); });
    es.addEventListener('error', () => {
      online = false; publishStatus();
      if (es && es.readyState === EventSource.CLOSED) { disconnect(); checkSession(); }
    });
  }

  function disconnect() { if (es) { es.close(); es = null; } }

  /** After the stream was refused: a lapsed login goes to the sign-in page, anything else retries. */
  async function checkSession() {
    try {
      const r = await fetch('/api/selfhost/session', { credentials: 'same-origin' });
      if (r.status === 401) { toLogin(); return; }
    } catch { /* offline */ }
    setTimeout(connect, 5000);
  }

  function onRemote(c) {
    advance(c.rev);
    if (!isSynced(c.key) || c.ver <= verOf(c.key)) return; // a replay of what this profile has
    if (c.by === clientId) return; // this profile's own write; its upload response sets the version
    if (dirtyBase(c.key) !== null) return; // a local change is pending; the server resolves it
    if (live.has(c.key)) {
      const old = get(PREFIX + c.key);
      writeLocal(c.key, c.deleted ? null : c.v);
      setVer(c.key, c.ver);
      dispatchStorage(c.key, old, c.deleted ? null : c.v);
    } else {
      held.add(c.key);
      notify('remote', c.key);
    }
  }

  // --- 3. leader election ---------------------------------------------------------------------

  function becomeLeader() {
    if (leader) return;
    leader = true;
    connect();
    flushAll();
    render();
  }
  function resign() {
    if (!leader) return;
    leader = false;
    disconnect();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    render();
  }

  if (navigator.locks && typeof navigator.locks.request === 'function') {
    navigator.locks.request('wickline-selfhost-leader', () => { becomeLeader(); return new Promise(() => {}); });
  } else {
    // Lease fallback: the leader renews `wickline-selfhost.leader` every few seconds.
    const LEASE = `${NS}leader`;
    const readLease = () => { try { return JSON.parse(get(LEASE)); } catch { return null; } };
    const tick = () => {
      const l = readLease();
      const now = Date.now();
      if (!l || l.until < now || l.id === tabId) {
        trySet(LEASE, JSON.stringify({ id: tabId, until: now + 15_000 }));
        setTimeout(() => { const m = readLease(); if (m && m.id === tabId) becomeLeader(); else resign(); }, 50);
      } else if (leader) resign();
    };
    tick();
    setInterval(tick, 3000);
    window.addEventListener('pagehide', () => { const l = readLease(); if (l && l.id === tabId) del(LEASE); });
  }

  // --- other tabs' writes, banners and status -------------------------------------------------

  window.addEventListener('storage', (e) => {
    if (e.storageArea !== ls || !e.key) return;
    if (e.key.startsWith(`${NS}dirty.`)) { if (e.newValue !== null) schedule(e.key.slice(NS.length + 6)); render(); return; }
    const name = nameOf(e.key);
    if (isSynced(name) && dirtyBase(name) !== null) { schedule(name); return; }
    if (e.key === `${NS}notice` && e.newValue) { try { const n = JSON.parse(e.newValue); handleNotice(n.kind, n.key); } catch { /* ignore */ } }
    else if (e.key === `${NS}status`) render();
  });

  window.addEventListener('online', () => { if (leader) { flushAll(); connect(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (leader) flushAll({ keepalive: true }); return; }
    if (reloadWhenVisible) reloadNow();
  });
  window.addEventListener('pagehide', () => { if (leader) flushAll({ keepalive: true }); });

  function needReload(kind) {
    if (document.visibilityState === 'hidden') reloadWhenVisible = true; // never reload a hidden tab
    showBanner(kind);
  }

  /** Reloads without the s/tf hash, which upstream would otherwise apply over the synced layout. */
  function reloadNow() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.has('s') || h.has('tf')) {
      h.delete('s'); h.delete('tf');
      const rest = h.toString();
      history.replaceState(history.state, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
    }
    location.reload();
  }

  function toLogin() {
    location.assign(`/selfhost/login?next=${encodeURIComponent(location.pathname + location.search)}${location.hash}`);
  }

  /** Shows a notice here and, through a storage event, in every other tab of this profile. */
  function notify(kind, key) {
    trySet(`${NS}notice`, JSON.stringify({ kind, key, at: Date.now() }));
    handleNotice(kind, key);
  }

  function handleNotice(kind, key) {
    if (kind === 'remote' || kind === 'restored') needReload(kind);
    else if (kind === 'replaced' && key && !live.has(key)) needReload('replaced-reload'); // the page still shows the old value
    else showBanner(kind);
  }

  function publishStatus() {
    if (leader) trySet(`${NS}status`, online ? 'online' : 'offline');
    render();
  }

  // --- UI (plain DOM, inline styles: nothing for upstream's CSS to collide with) ---------------

  const TEXT = {
    remote: 'Updated on another device.',
    restored: 'The server’s data was restored or imported. Reload to continue syncing.',
    replaced: 'Your change on this device was replaced by a newer one from another device.',
    quota: 'This change is too large to sync (server storage limit). It is kept on this device only.',
    previous: 'This browser had data that differs from the server’s. The server’s data is now loaded.',
  };
  TEXT['replaced-reload'] = `${TEXT.replaced} Reload to see it.`;

  function ensureUi() {
    if (ui || !document.body) return ui;
    const dot = document.createElement('div');
    dot.id = 'wl-sync-status';
    dot.setAttribute('role', 'status');
    dot.style.cssText = 'position:fixed;right:6px;bottom:6px;width:8px;height:8px;border-radius:50%;z-index:2147483646;pointer-events:auto;opacity:.8';
    const banner = document.createElement('div');
    banner.id = 'wl-sync-banner';
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    banner.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;'
      + 'max-width:min(640px,calc(100vw - 32px));padding:10px 14px;border-radius:8px;background:#1f2937;color:#f9fafb;'
      + 'font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    document.body.append(dot, banner);
    ui = { dot, banner };
    return ui;
  }

  function button(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #4b5563;background:#374151;color:inherit;cursor:pointer';
    b.addEventListener('click', onClick);
    return b;
  }

  function showBanner(kind) {
    // A pending reload outranks a notice; the same banner is not rebuilt.
    if (bannerKind === kind || (bannerKind === 'restored' && kind !== 'restored')) return;
    bannerKind = kind;
    const u = ensureUi();
    if (!u) return;
    const text = document.createElement('span');
    text.textContent = TEXT[kind];
    const actions = [];
    if (kind === 'remote' || kind === 'restored' || kind === 'replaced-reload') actions.push(button('Reload', reloadNow));
    if (kind === 'previous') actions.push(button('Download previous data', downloadPrevious));
    if (kind !== 'restored') actions.push(button('Dismiss', () => { u.banner.hidden = true; bannerKind = null; }));
    u.banner.replaceChildren(text, ...actions);
    u.banner.dataset.kind = kind;
    u.banner.hidden = false;
  }

  function downloadPrevious() {
    const blob = new Blob([JSON.stringify({ app: 'wickline', exportedAt: new Date().toISOString(), origin: location.origin, keys: previousData }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wickline-local-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function state() {
    if ((leader ? !online : get(`${NS}status`) === 'offline')) return 'offline';
    if (inflight.size || dirtyNames().length) return 'pending';
    return 'synced';
  }

  const COLORS = { synced: '#22c55e', pending: '#f59e0b', offline: '#ef4444' };
  const TITLES = { synced: 'Synced', pending: 'Saving changes…', offline: 'Offline: changes are kept and sent when the server is reachable' };

  function render() {
    const u = ensureUi();
    if (!u) return;
    const s = state();
    u.dot.dataset.state = s;
    u.dot.style.background = COLORS[s];
    u.dot.title = `Wickline Self-Hosted: ${TITLES[s]}`;
    u.dot.setAttribute('aria-label', u.dot.title);
  }

  function onReady() {
    render();
    if (previousData) showBanner('previous');
    if (bannerKind) { const k = bannerKind; bannerKind = null; showBanner(k); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();

  // Diagnostics (and the browser tests): read-only state plus a manual flush.
  Object.defineProperty(window, 'wicklineSelfhost', {
    value: Object.freeze({
      get leader() { return leader; },
      get connected() { return !!es && es.readyState === 1; },
      get state() { return state(); },
      get held() { return [...held]; },
      clientId,
      epoch,
      flush: () => flushAll(),
    }),
  });
})();
