# Phase 5 design: server-side paper trading

Status: **v3, approved by the owner as best effort** (2026-11-26).

The independent review (Codex) asked for rework twice. The remaining issues come from upstream's browser engine, which the fork cannot fence without editing upstream (§8). The owner chose **option A**: the server watches paper orders while no main window is open, as **best effort**, with the limits documented. The cheap fixes from the second review are included here.

v1 ran two engines on the same account at once (the browser's and the server's). Whole-account compare-and-swap cannot make two engines agree: a browser change still in upstream's 300 ms save timer could vanish silently, an old price could fill an order created after it, and buying power could be judged on different marks. **v2 has a single owner at a time: the server fills only while no main window is open.**

## Goal

Limit orders, stop orders, stop losses and take profits on the **live** paper account fill when the price
reaches them, around the clock, with no browser open. Each fill is pushed once ("AAPL stop loss filled at
189.50"). Open browsers show the fill within seconds.

Constraints from the owner:
- **No upstream pull request and no upstream file changes**: everything lives in `selfhost/`.
- It must not risk the account: no lost, duplicated or out-of-order fills, and no fills from stale prices.

Not in scope: the bar-replay practice account (it never leaves the browser), new order types, margin
or financing.

## What exists today

- **The account:** upstream keeps the whole live account in the `wickline.paper` key: settings, cash,
  positions with their stop loss and take profit, orders, trades, fills, the last price per symbol
  (`last`) and an id counter (`seq`). The self-hosted server already syncs that key with the
  compare-and-swap policy, as a **live** key. Open tabs rebuild their account when it changes
  (`trading.js`: `storage` listener → `new PaperAccount({}, store.get('paper'))`).
- **The engine:** `public/js/paper.js` (`PaperAccount`) has no DOM and no network. It runs unmodified in Node:
  `new PaperAccount({}, saved).tick(symbol, price, time)` returns the fills, and `toJSON()` is what the
  browser saves. A contract test already pins this API (integration point `paper-engine`).
- **Filling:** `tick` walks the price from `last[symbol]` to the new price and fills every level crossed:
  a limit at its own price, a stop at the next trade, with slippage and commission.
- **Today's gap:** the browser fills only while a main window is open and receiving prices, so stops and
  take profits do nothing while every tab is closed.
- **The worker:** the alert worker already streams Yahoo, Binance, Coinbase, Bybit and OKX, with market
  hours, REST fallback and staleness. It runs in a supervised `worker_threads` thread.

## Design

### 1. One engine, imported from upstream

The server imports upstream's `PaperAccount` directly, the same way the contract tests do. Fills follow
upstream's rules exactly, and an upstream change applies to both sides. The `paper-engine` contract is
extended with **behavioural** tests against the real engine:
- `tick` returns fills **and** rejected orders (removed, with no fill);
- one tick can produce several results (an entry, then its bracket exit);
- the walk stops after 50 iterations;
- times are seconds, while feed times are milliseconds;
- `seq` numbers orders, fills and trades together;
- `toJSON` caps trades at 500 and fills at 1,000;
- `reset` restarts `seq`.

### 2. One owner at a time: the server fills only while you are away

| State | Who fills | When |
|---|---|---|
| **Browser** | upstream's engine in the main window, as today | a main window reported presence in the last `PRESENCE_LEASE` (150 s), or `index.html` was served that recently |
| **Server** | the server's evaluator | no presence for longer than the lease |

- **Presence:** every **main** window sends `POST /api/selfhost/presence` every 30 s. `boot.js` does this,
  and pop-out windows (`?popout=1`) never fill, so they never report. This is a self-hosted addition only;
  upstream is not changed.
- **Serving the page:** a **GET** of `index.html` for a main window counts as presence. A HEAD request
  and a pop-out URL do not. It renews the lease **before** the snapshot is built, so the server cannot
  fill between the snapshot a page starts from and its first report.
- **The lease:** 150 s, so it outlives background timer throttling, which can stretch a hidden tab's
  timers to once a minute.
- **A tab that stops reporting:** a closed tab, a frozen tab, or a phone gone to sleep. The server takes over
  after the lease runs out.
- **During those 150 s nobody fills.** That is the deliberate price of never having two owners.

### 3. Handover

- **Browser to server** (the lease expires):
  - the server loads the **current** stored account and its version into memory;
  - it starts a new generation (§4), so nothing queued from before is applied.
- **Server to browser** (presence or a page request arrives):
  - the server stops at once and drops its queue;
  - if prices moved its in-memory marks (`last`) since its last save, it saves the account once, so the
    browser starts from current marks. That save is a compare-and-swap against the version it loaded,
    like any other server write;
  - the page or tab receives it through the snapshot or SSE. On a page request this all happens
    synchronously **before** the snapshot is built, so a page always starts from the server's latest
    account.
- **A tab that wakes after the server took over:** for example, a phone that slept longer than the lease.
  Its in-memory account is old, and upstream may act on a price before SSE delivers the server's
  version. Its save is then rejected (the base is older) and it reloads the server's account, with the
  usual notice. Nothing is merged silently.
- **A save that might have been lost:** a browser save sent on `beforeunload` may never arrive (the page
  is gone). The server then works from the last version that did arrive. When that browser returns with
  its unsaved change, its write is rejected (the base is older) and it shows "Your change on this device
  was replaced by a newer one". The change is visible, never silently merged. This can only happen
  across a handover.

### 4. The server evaluator (while it owns the account)

- **One place, one account:** a single evaluator on the main thread keeps the account in memory as a
  `PaperAccount`. Every symbol's mark is in that one object, so buying power is always judged on one
  coherent set of marks. The worker only delivers prices; it runs no engine.
- **Ordered prices:** the worker sends each price for a watched symbol in arrival order, with its
  receipt time. The evaluator applies them one by one (`tick`, with milliseconds converted to seconds).
  - **A barrier:** an **external** change to the account (anything but the evaluator's own commit) starts
    a new generation. Prices received before that moment are dropped, so a price from before an order
    existed cannot fill it.
  - **The evaluator's own commits** do not start a new generation, so the following prices from the
    same stream still apply.
- **Committing a result:** the account, the outbox rows and the new generation checkpoint are written in
  one SQLite transaction (`state.mutate` plus `outbox.insert`), as alert triggers are.
  - The write is a compare-and-swap against the **epoch and the version** the evaluator holds. An import
    resets versions to 1, so the epoch is needed too.
  - If either moved (an import, a restore, the API, a browser that slipped in), the result is
    **discarded**: the evaluator reloads and starts a new generation, and the price is not replayed.
  - **A transient storage failure** (not a conflict) reloads, then **replays that one price once**, so a
    crossing is not lost to a hiccup. A second failure pauses the evaluator and is shown in the status.
- **Freshness:** only **streamed** prices fill; REST fallback prices do not, because they can be delayed.
  A price must have arrived less than 10 s before it is evaluated, which also covers a backed-up queue.
  This is quote freshness, not a proof of trade time: exchanges' ticker times describe when the ticker
  was generated. A stale or unsupported symbol pauses server fills for that symbol, and the status says
  so.
- **Reset, import, restore, or a deleted `paper` key:** the evaluator listens for epoch changes and
  `paper` changes, reloads, and starts a new generation.

### 5. Gaps and restarts

- **After a restart or reconnect:** the first price walks from the stored `last` to the new price. A limit
  or stop **between those two prices** fills, as when upstream reopens a tab.
- **Excursions the server did not see are lost.** If the price dipped through your stop and came back
  while nothing was watching (the container was down, or the stream was out), that crossing cannot be
  reconstructed. This is stated in the docs.

### 6. Notifications

- **What is pushed:** each fill or rejection the server commits is queued **in the same transaction**
  (`outbox.insert`, then a kick after the commit).
- **The key:** `paper:<epoch>:<account version>:<n>`, where `n` is the result's position in that commit.
  Rejections have no id of their own, so the position is used instead.
- **The guarantee:** pushes are **queued once** and delivered with the outbox's bounded retries (up to
  `NOTIFY_MAX_ATTEMPTS`). As for alerts, a crash between Gotify accepting a message and Wickline recording
  it can repeat that one push.
- **Text:**
  - "AAPL stop loss filled at 189.50", then "Sell 10 · P&L +125.00 · Paper";
  - "AAPL limit order rejected: insufficient buying power".
- **Fills made in a browser are not pushed:** a main window is open somewhere.
- **Settings:** `PAPER_SERVER` (default `true`) and `NOTIFY_PAPER` (default `true`). They are independent of
  `ALERTS_SERVER`: the worker runs if either feature is on.

### 7. Coverage and limits

- **Watched symbols:** every symbol where `hasWork(symbol)` is true (an open order, or a position, which may
  carry a stop loss or take profit).
- **Priority:** paper symbols are watched **before** alert symbols under `ALERT_MAX_SYMBOLS`. A stop
  protects money, so alerts give way first.
- **Coverage:** the status reports each paper symbol as `covered`, `stale`, `unsupported` or
  `over capacity`, plus who owns the account now, the last server fill and errors.
- **Size:** the account is parsed once per handover and per reload, not per price. Ticks run on the
  in-memory object. A commit serializes it, which upstream already caps (500 trades, 1,000 fills). A
  quota failure on commit is logged and shown in the status, and the evaluator stops until the next
  reload.

## 8. Known limits (best effort)

These come from upstream's browser engine, which fills and saves on its own. The fork cannot fence it
without editing upstream (option B, rejected). SELFHOSTED.md states them plainly:
- **The lease gap:** for up to 150 s after the last main window closes or freezes, nobody fills. A crossing
  that goes and comes back inside that time is missed.
- **A waking tab:** for example, a phone that slept past the lease. It can fill from its old copy before it
  learns the server took over. Its save is usually rejected and it reloads, with the "replaced" notice. A
  change made in the 300 ms before an incoming update can be lost **silently**.
- **Several windows or devices:** each runs upstream's engine. This is upstream's behaviour today, and the
  server stays out while any of them is present.
- **A change that never reached the server:** for example, a cancellation made just before closing the
  tab, on a slow connection. The server works from the last saved account and can fill that order.
- **Prices the server never saw:** for example, while the container was down. These cannot be replayed.

## Phasing

| PR | Content |
|---|---|
| 5a | Presence (`boot.js`, `POST /api/selfhost/presence`, GET `index.html` renewal for main windows), the ownership state machine and handover, the evaluator with its barrier and its epoch-and-version commit, receipt-time freshness, the behavioural engine contracts. Deterministic tests, including: a browser change in the 300 ms timer is never replaced while present; an old tick never fills a newer order; cross-symbol buying power; a failed commit reloads; reset or import with queued messages; a lost `beforeunload` save across a handover; a restart. |
| 5b | Notifications in the commit transaction, the coverage and status reporting, independent settings, docs (SELFHOSTED.md, the Unraid template), a live run against a real feed, and a pause for unsupported or stale symbols. |

## Decisions (owner, 2026-11-26)

1. Push every server fill and rejection.
2. Server fills use streamed prices only.
3. `PAPER_SERVER=true` by default.
4. Best effort (option A), with the limits in §8 documented.

## Risks

- **Upstream changes the account format or fill rules.** The engine is imported, so fill rules follow
  upstream. The behavioural contract tests fail on a format or behaviour change before it reaches a release.
- **No owner for up to 150 s after the last main window closes.** That is the cost of never having two
  owners. It is shown in the status, and the lease can be tuned.
- **A browser save lost on `beforeunload`.** That change is replaced visibly, with a notice, after the
  handover. It is never merged silently.
- **Excursions while nothing watched.** These are not reconstructed (§5), and the docs say so.
