// Network access for the alert worker. Loopback requests (upstream's relay on the internal
// listener) always go direct; exchange connections (Binance, Coinbase) go through WICKLINE_PROXY
// when one is set, like upstream's own market-data traffic. Each request names its dispatcher, so
// neither can take the other's route.

import { Agent, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, WebSocket as UndiciWebSocket } from 'undici';

export function createNet({ proxyUrl = null } = {}) {
  const direct = new Agent();
  const external = !proxyUrl ? direct : proxyUrl.startsWith('socks5:') ? new Socks5ProxyAgent(proxyUrl) : new ProxyAgent(proxyUrl);
  return {
    loopback: (url, init = {}) => undiciFetch(url, { ...init, dispatcher: direct }),
    fetch: (url, init = {}) => undiciFetch(url, { ...init, dispatcher: external }),
    openWs: (url) => new UndiciWebSocket(url, { dispatcher: external }),
    async close() { await Promise.allSettled([direct.close(), external === direct ? null : external.close()]); },
  };
}
