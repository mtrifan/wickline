// Who owns the live paper account (PLAN Phase 5, selfhost/docs/PHASE5-PAPER.md §2): a main window
// reporting presence (boot.js, every 30 s) or a GET of the app page keeps the browser the owner for
// PRESENCE_LEASE_MS; with no report for longer, the server takes over.

export const PRESENCE_LEASE_MS = 150_000;

export function createPresence({ leaseMs = PRESENCE_LEASE_MS, now = Date.now } = {}) {
  // At start, a browser may already be open (a restart): wait one lease before taking over.
  let last = now();
  return {
    /** A main window is here (or a page for one is being served). */
    touch() { last = now(); },
    /** True while a main window reported within the lease. */
    present() { return now() - last < leaseMs; },
    get lastSeenAt() { return last; },
  };
}
