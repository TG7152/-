const marketDataOrigin = 'https://data-api.binance.vision';
const supportedIntervals = new Set(['1s','1m','5m','15m','1h','4h','1d']);
const freshnessMs = 8_000;
const maximumEntries = 240;

export class MarketDataError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateMarket(symbol, interval) {
  if (!/^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/.test(symbol ?? '') || !supportedIntervals.has(interval)) {
    throw new MarketDataError(400, '请选择有效交易对和 K 线周期。');
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
        if (response.status === 400) throw new MarketDataError(404, '该交易对暂无参考行情。');
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
    validateMarket(symbol,interval);
    const cacheKey = symbol + ':' + interval;
    const entry = cached.get(cacheKey);
    if (entry && entry.expires > now()) return entry.value;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    if (pending.size >= 32) throw new MarketDataError(503, '行情请求较多，请稍后重试。');

    const task = (async () => {
      if (!await isActive(symbol)) throw new MarketDataError(404, '此交易对未开放参考行情。');
      const value = await load(symbol, interval);
      cached.delete(cacheKey);
      cached.set(cacheKey,{value, expires:now() + (interval === '1s' ? 1000 : freshnessMs)});
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

export function createReferenceMarketStreams({ openSocket = url => new WebSocket(url) } = {}) {
  const channels = new Map();

  return async (symbol, interval, isActive, listener) => {
    validateMarket(symbol,interval);
    if (!await isActive(symbol)) throw new MarketDataError(404,'此交易对未开放参考行情。');
    const providerSymbol = symbol.replace('/','');
    const key = providerSymbol + ':' + interval;
    let channel = channels.get(key);
    if (!channel) {
      if (channels.size >= 32) throw new MarketDataError(503,'实时行情连接较多，请稍后重试。');
      const stream = providerSymbol.toLowerCase();
      const socket = openSocket(`wss://data-stream.binance.vision/stream?streams=${stream}@kline_${interval}/${stream}@ticker`);
      const listeners = new Set();
      channel = {socket,listeners};
      channels.set(key,channel);
      const stop = () => {
        if (channels.get(key) !== channel) return;
        channels.delete(key);
        for (const current of listeners) current.close();
        listeners.clear();
        if (socket.readyState < 2) socket.close();
      };
      socket.addEventListener('close',stop);
      socket.addEventListener('error',stop);
      socket.addEventListener('message',event => {
        const update = readMarketEvent(event.data,providerSymbol,interval);
        if (update) for (const current of listeners) current.send(update);
      });
    }
    if (channel.listeners.size >= 48) throw new MarketDataError(503,'实时行情连接较多，请稍后重试。');
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
      if (!channel.listeners.size && channels.get(key) === channel) {
        channels.delete(key);
        if (channel.socket.readyState < 2) channel.socket.close();
      }
    };
  };
}

function readMarketEvent(raw, symbol, interval) {
  try {
    const data = JSON.parse(raw)?.data;
    if (data?.s !== symbol || !Number.isFinite(data.E)) return null;
    const updated_at = new Date(data.E).toISOString();
    if (data.e === 'kline' && data.k?.i === interval && [data.k.o,data.k.h,data.k.l,data.k.c].every(price => Number(price) > 0)) {
      const {t,o,h,l,c} = data.k;
      return {updated_at,candle:{open_time:new Date(t).toISOString(),open:o,high:h,low:l,close:c}};
    }
    if (data.e === '24hrTicker' && Number(data.c) > 0) {
      return {ticker:{updated_at,last_price:data.c,high_24h:data.h,low_24h:data.l,volume_24h:data.v,price_change_pct:data.P}};
    }
    return null;
  } catch {
    return null;
  }
}
