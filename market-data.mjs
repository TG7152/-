const marketDataOrigin = 'https://data-api.binance.vision';
const supportedIntervals = new Set(['1m','5m','15m','1h','4h','1d']);
const freshnessMs = 8_000;
const maximumEntries = 240;

export class MarketDataError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createReferenceMarketData({ fetchImpl = fetch, now = Date.now } = {}) {
  const cached = new Map();
  const pending = new Map();

  async function fetchMarketData(path, params) {
    const url = new URL(path, marketDataOrigin);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetchImpl(url, { redirect:'error', signal:AbortSignal.timeout(6000) });
      if (!response.ok) {
        if (response.status === 400) throw new MarketDataError(404, '该交易对没有 Binance 参考行情。');
        throw new MarketDataError(502, '参考行情暂时不可用。');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(502, '参考行情暂时不可用。');
    }
  }

  async function load(symbol, interval) {
    const providerSymbol = symbol.replace('/', '');
    const [bars, ticker] = await Promise.all([
      fetchMarketData('/api/v3/klines', { symbol:providerSymbol, interval, limit:'90' }),
      fetchMarketData('/api/v3/ticker/24hr', { symbol:providerSymbol })
    ]);
    if (!Array.isArray(bars) || ticker?.symbol !== providerSymbol || !Number.isFinite(ticker.closeTime)) {
      throw new MarketDataError(502, '参考行情的格式暂时无法读取。');
    }
    const candles = bars.flatMap(bar => {
      if (!Array.isArray(bar) || !Number.isFinite(bar[0]) ||
          !bar.slice(1,5).every(price => typeof price === 'string' && Number(price) > 0) || bar.length < 6) return [];
      const [openTime,open,high,low,close] = bar;
      return [{ open_time:new Date(openTime).toISOString(),open,high,low,close }];
    });
    if (!candles.length) throw new MarketDataError(404, '该周期暂无参考 K 线。');
    return {
      source:'Binance', symbol, interval, candles,
      ticker:{
        last_price:ticker.lastPrice, high_24h:ticker.highPrice, low_24h:ticker.lowPrice,
        volume_24h:ticker.volume, price_change_pct:ticker.priceChangePercent,
        updated_at:new Date(ticker.closeTime).toISOString()
      }
    };
  }

  return async (symbol, interval, isActive) => {
    if (!/^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/.test(symbol ?? '') || !supportedIntervals.has(interval)) {
      throw new MarketDataError(400, '请选择有效交易对和 K 线周期。');
    }
    const cacheKey = symbol + ':' + interval;
    const entry = cached.get(cacheKey);
    if (entry && entry.expires > now()) return entry.value;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    if (pending.size >= 32) throw new MarketDataError(503, '行情请求较多，请稍后重试。');

    const task = (async () => {
      if (!await isActive(symbol)) throw new MarketDataError(404, '此交易对未开放参考行情。');
      const value = await load(symbol, interval);
      cached.delete(cacheKey);
      cached.set(cacheKey,{value, expires:now() + freshnessMs});
      if (cached.size > maximumEntries) cached.delete(cached.keys().next().value);
      return value;
    })();
    pending.set(cacheKey, task);
    try {
      return await task;
    } finally {
      pending.delete(cacheKey);
    }
  };
}
