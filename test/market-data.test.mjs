import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { createReferenceMarketData, createReferenceMarketStreams } from '../market-data.mjs';

const instant = 1794913200000;
const ticker = {symbol:'BTCUSDT',closeTime:instant,lastPrice:'103.13',highPrice:'109',lowPrice:'95',volume:'13',priceChangePercent:'1.2'};
const candle = [instant,'100','109','95','103.13','13'];

test('reference quote validates inputs, merges Binance data, caches results and renews on expiration',async () => {
  let now = instant;
  const calls = [];
  const getQuote = createReferenceMarketData({now:() => now,fetchImpl:async url => {
    calls.push(url);
    assert.equal(url.origin,'https://data-api.binance.vision');
    assert.equal(url.searchParams.get('symbol'),'BTCUSDT');
    return Response.json(url.pathname.endsWith('/klines') ? [candle] : ticker);
  }});
  const active = async symbol => symbol === 'BTC/USDT';
  await assert.rejects(getQuote('ABC/USDT','1m',active),{status:404});
  await assert.rejects(getQuote('BTC/USDT','unsupported',active),{status:400});
  const [first,second] = await Promise.all([getQuote('BTC/USDT','1m',active),getQuote('BTC/USDT','1m',active)]);
  assert.deepEqual(first,second);
  assert.equal(first.source,'Binance');
  assert.equal(first.candles[0].close,'103.13');
  assert.equal(first.ticker.price_change_pct,'1.2');
  assert.equal(first.ticker.updated_at,new Date(instant).toISOString());
  await getQuote('BTC/USDT','1m',active);
  assert.equal(calls.length,2);
  now += 10_000;
  await getQuote('BTC/USDT','1m',active);
  assert.equal(calls.length,4);
});

test('the backend separates reference prices from Supabase order data',async t => {
  const handler = createApp({
    supabaseUrl:'https://example.supabase.co',key:'sb_publishable_test',
    upstreamFetch:async url => {
      assert.equal(url.pathname,'/rest/v1/public_markets');
      assert.equal(url.searchParams.get('status'),'eq.active');
      return Response.json(url.searchParams.get('symbol') === 'eq.BTC/USDT' ? [{symbol:'BTC/USDT'}] : []);
    },
    marketFetch:async url => Response.json(url.pathname.endsWith('/klines') ? [candle] : ticker)
  });
  const server = createServer(handler).listen(0,'127.0.0.1');
  t.after(() => server.close());
  await once(server,'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/api/data/marketQuote?interval=1m&symbol=';
  const response = await fetch(url + 'BTC%2FUSDT');
  assert.equal(response.status,200);
  assert.equal((await response.json()).ticker.last_price,'103.13');
  assert.equal((await fetch(url + 'ETH%2FUSDT')).status,404);
});

test('one-second updates share a WebSocket and close it when the last subscriber leaves', async () => {
  let sockets = 0;
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.close = () => { socket.readyState = 3; socket.dispatchEvent(new Event('close')); };
  const stream = createReferenceMarketStreams({openSocket:url => {
    sockets++;
    assert.match(url,/^wss:\/\/data-stream\.binance\.vision\/stream\?streams=btcusdt@kline_1s\/btcusdt@ticker$/);
    return socket;
  }});
  const events = [];
  const first = await stream('BTC/USDT','1s',async () => true,{send:event => events.push(event),close(){}});
  const second = await stream('BTC/USDT','1s',async () => true,{send:event => events.push(event),close(){}});
  for (const t of [instant,instant + 1000]) {
    const data = {s:'BTCUSDT',e:'kline',E:t,k:{i:'1s',t,o:'100',h:'109',l:'95',c:'103.13'}};
    socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({data})}));
  }
  assert.equal(sockets,1);
  assert.equal(events.length,4);
  assert.equal(Date.parse(events[2].candle.open_time) - Date.parse(events[0].candle.open_time),1000);
  first();
  assert.equal(socket.readyState,1);
  second();
  assert.equal(socket.readyState,3);
});
