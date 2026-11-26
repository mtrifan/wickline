# Phase 5 design: server-side paper trading

Status: **proposal for the owner's approval** (2026-11-26). Nothing here is built yet.

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

The server imports upstream's `PaperAccount` directly, the same way the contract tests do. The server
fills exactly as the browser would, and an upstream change to the fill rules applies to both
automatically. The `paper-engine` contract is extended to pin the pieces this design relies on:
`tick`, `hasWork`, `toJSON`, the shape of a fill, and the `last` and `seq` fields.

### 2. Who fills: the worker proposes, the main thread decides

```
price tick ──► worker: mirror PaperAccount.tick(...)  ── would fill? ──► main: { type: 'paper', symbol, price, at }
                                                                            │
                     state.mutate('paper'): load the CURRENT stored account, tick(symbol, price, at),
                     write toJSON() if it produced fills (new version → SSE → tabs rebuild), queue pushes
```

- **The worker** keeps an in-memory mirror of the account, refreshed on every `paper` change through the
  same `sync.onChange` path alerts use. It watches every symbol where `hasWork(symbol)` is true: an open
  order, or a position, which may carry a stop loss or take profit. Those symbols are added to the
  feed's symbol set, alongside the alert symbols.
- **The worker** runs each price through the mirror only to decide whether to report it. It reports
  only prices that produce a fill, plus a throttled **progress** price per symbol (see §4). It never
  writes.
- **The main thread** applies the price to the **current stored account** inside one SQLite transaction
  (`state.mutate`), and saves only if that produced fills. The decision is always made against the
  latest saved state, so nothing the browser saved since the mirror was refreshed is lost or applied
  twice.
- A price that would fill on the mirror but no longer fills on the stored account (a browser already
  filled or cancelled it) does nothing.

### 3. A browser open at the same time

Both sides may fill the same order from the same move, as with alerts. The key is compare-and-swap, so
**the first save wins**:
- **The server saves first:** a browser save built on the older version gets a 409. `boot.js`
  re-hydrates `paper`, upstream rebuilds its account from it, and the server's fill is shown.
- **The browser saves first:** the server's transaction loads the browser's account, finds the order
  gone, and does nothing.
- **A fill and a user action at the same moment:** for example, the user moves a stop just as the
  server fills it. The later save is rejected, and that browser shows the existing notice "Your change
  on this device was replaced by a newer one". **The user sees the result and can redo the action.** The
  account is never corrupted.
- **Writes close together:** the browser saves 300 ms after a change and on `beforeunload`. Both are
  ordinary compare-and-swap writes, so a stale `beforeunload` save after a server fill is rejected
  server-side, as already designed for Phase 2.

### 4. Prices, gaps and restarts

- **Prices:** the same feeds as alerts, and the same rule: a fill needs a fresh price (stream or REST
  fallback). A stale symbol fills nothing. All market sessions count, as in the browser, which fills
  on any quote it receives.
- **The stored `last[symbol]`** is where the next walk starts. The account is written only on a fill,
  so after a quiet spell that starting point can be old. Writing a progress price into the account
  would bump its version every minute and keep rejecting the browser's saves. Instead:
  - the worker sends a throttled **progress price** per watched symbol (at most once a minute, and only
    when it moved);
  - the main thread stores it in a **server-side table** (`paper_progress`: symbol, price, time), never
    in the account;
  - when the main thread applies a fill check, it starts the walk from the progress price **if that was
    recorded after the account was last saved**. Otherwise it starts from the account's own `last`.

  The account changes only when something fills, and a restart walks from a recent price.
- **After a restart, a gap, or a stream outage:** the first new price walks from the stored `last`. Any
  limit or stop crossed while the server was not watching fills on that first price. This is what upstream
  does today when you reopen the tab after a while. **Open question 2** asks whether to keep it.

### 5. Notifications

- **Each fill the server makes** is pushed through the outbox, deduped on `paper:<fill id>:<time>`.
  Fill ids come from the account's own counter, and the time makes them unique across account resets.
- **Text:** "AAPL stop loss filled at 189.50", then "Sell 10 · P&L +125.00 · Paper" (the reason is
  upstream's: Limit, Stop, Stop loss, Take profit). The link opens the symbol (`PUBLIC_URL/#s=…`).
- **Fills the browser makes are not pushed**: you are looking at it.
- **Settings:** `PAPER_SERVER` (default `true`) and `NOTIFY_PAPER` (default `true`).

### 6. Status and limits

- **Status:** `/api/selfhost/alerts/status` gains a `paper` section listing watched symbols, the last
  server fill and errors. Watched paper symbols count towards `ALERT_MAX_SYMBOLS`; alerts come first.
- **Writes:** the account is written once per fill. Progress prices go to `paper_progress` (a schema
  migration, with a fixture captured when it ships), at most once a minute per watched symbol.

## Phasing

| PR | Content |
|---|---|
| 5a | The engine import, the worker mirror and symbol watching, the main-thread `mutate` apply, the `paper_progress` table (a migration and its fixture), contract updates. Tests: the real `PaperAccount`; a limit, a stop, a stop loss and a take profit filling with no browser; a browser save racing a server fill; a stale `beforeunload` after a fill; a restart. |
| 5b | Notifications (`NOTIFY_PAPER`), the status section, settings, docs (SELFHOSTED.md, the Unraid template), and a live run against a real feed. |

## Open questions for the owner

1. **Pushes:** push **every** server fill (default), or only stop loss, take profit and stop fills?
2. **After a long gap:** fill orders crossed while the server was down on its first new price, like
   upstream does when a tab reopens (default)? Or treat a gap longer than `ALERT_RESUME_MAX_GAP`
   (15 min) as a fresh start, so nothing fills from the gap?
3. **Default on:** `PAPER_SERVER=true` by default (proposed), or opt-in?

## Risks

- **Upstream changes the account format or fill rules.** The engine is imported, so fill rules follow
  upstream automatically. The contract test fails on a format change before it reaches a release.
- **A double fill from two engines.** Ruled out by deciding inside the transaction, against the stored
  account (§2, §3).
- **A user action replaced by a concurrent fill.** Visible and rare (§3). The alternative, merging the
  account entry by entry, needs upstream's cooperation, which is out of scope.
