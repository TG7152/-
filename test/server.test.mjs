import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, startupOptions } from '../server.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const token = 'header.' + Buffer.from(JSON.stringify({sub:userId})).toString('base64url') + '.signature';
const authSession = { access_token:token,refresh_token:'mock-refresh',expires_in:3600,user:{id:userId,email:'test@example.com'} };

test('Codespaces defaults to forwarded HTTPS and secure cookies', () => {
  const opts = startupOptions({CODESPACES:'true',CODESPACE_NAME:'example-workspace',GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev'});
  assert.equal(opts.origin,'https://example-workspace-3000.app.github.dev');
  assert.equal(opts.port,3000);
  assert.equal(opts.host,'0.0.0.0');
  assert.equal(opts.secureCookies,true);
  assert.match(opts.key,/^sb_publishable_/);
  assert.equal(startupOptions({}).host,'127.0.0.1');
});

async function fixture(t, role = null) {
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({path:url.pathname, query:url.searchParams, authorization:options.headers.authorization, body});
    if (url.pathname === '/auth/v1/token') return Response.json(authSession);
    if (url.pathname === '/auth/v1/user') return Response.json(authSession.user);
    if (url.pathname === '/auth/v1/logout') return new Response(null,{status:204});
    if (url.pathname.endsWith('/admin_members')) return Response.json(role ? [{role}] : []);
    if (url.pathname.endsWith('/public_markets')) return Response.json([{symbol:'BTC/USDT'}]);
    if (url.pathname.endsWith('/wallet_balances')) return new Response('[{"available_balance":99999999999999999.123456789,"locked_balance":0}]');
    if (url.pathname.endsWith('/submit_limit_order')) return Response.json('test-order-id');
    if (url.pathname.endsWith('/admin_dashboard')) return Response.json({counts:{orders:0}});
    return Response.json([]);
  };
  const handler = createApp({supabaseUrl:'https://fixture.supabase.co',key:'sb_publishable_fixture',upstreamFetch});
  const server = createServer(handler).listen(0,'127.0.0.1');
  t.after(() => { server.close(); });
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = (path, cookie) => fetch(origin + path, {headers:cookie ? {cookie} : {}});
  const post = (path, body, cookie, source = origin) => fetch(origin + path, {method:'POST',
    headers:{origin:source,'content-type':'application/json',...(cookie ? {cookie} : {})}, body:JSON.stringify(body)});
  return {get,post,calls};
}

test('site serves both entry points and relays public market data without a user token', async t => {
  const {get,calls} = await fixture(t);
  for (const path of ['/','/admin']) {
    const result = await get(path);
    assert.equal(result.status,200);
    assert.match(await result.text(),/清音交易所/);
  }
  const result = await get('/api/data/markets');
  assert.deepEqual(await result.json(),[{symbol:'BTC/USDT'}]);
  assert.equal(calls[0].path,'/rest/v1/public_markets');
  assert.equal(calls[0].authorization,undefined);
  assert.equal((await get('/.env.example')).status,404);
  const health = await get('/healthz');
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{status:'ok'});
});

test('login keeps tokens in HTTP-only cookies and scopes private reads to the signed-in user', async t => {
  const {get,post,calls} = await fixture(t);
  const result = await post('/api/auth/login',{email:'test@example.com',password:'fixture-password'});
  assert.deepEqual(await result.json(),{user:authSession.user,role:null});
  const setCookies = result.headers.getSetCookie();
  assert.equal(setCookies.length,2);
  assert.ok(setCookies.every(value => value.includes('HttpOnly') && value.includes('SameSite=Strict')));
  const cookie = setCookies.map(value => value.split(';')[0]).join('; ');
  assert.equal((await get('/api/data/orders',cookie)).status,200);
  assert.equal(calls.at(-1).query.get('user_id'),'eq.' + userId);
  assert.equal(calls.at(-1).authorization,'Bearer ' + token);
  const balance = await get('/api/data/balances',cookie);
  assert.deepEqual(await balance.json(),[{available_balance:'99999999999999999.123456789',locked_balance:0}]);
  assert.equal((await get('/api/data/orders')).status,401);
  assert.equal((await post('/api/rpc/admin_dashboard',{},cookie)).status,403);
  const loggedOut = await post('/api/auth/logout',{},cookie);
  assert.ok(loggedOut.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
});

test('mutation passes exact decimal strings and retry IDs and rejects foreign origins', async t => {
  const {post,calls} = await fixture(t);
  const body = {market_symbol:'BTC/USDT', side:'buy', price:'60000.12345678',quantity:'0.00000001',client_order_id:'test-retry'};
  const cookie = 'qy_access=' + token;
  assert.equal((await post('/api/rpc/submit_limit_order',body,cookie,'https://elsewhere.example')).status,403);
  assert.equal((await post('/api/rpc/submit_limit_order',{...body,customer_id:userId},cookie)).status,400);
  assert.equal((await post('/api/rpc/submit_limit_order',body,cookie)).status,200);
  assert.equal(calls[0].body.p_quantity,body.quantity);
  assert.equal(calls[0].body.p_price,body.price);
  assert.equal(calls[0].body.p_client_order_id,body.client_order_id);
});

test('admin calls use the admin user token and non-operators cannot read the admin catalog', async t => {
  const {get,post,calls} = await fixture(t,'finance');
  const cookie = 'qy_access=' + token;
  assert.equal((await get('/api/data/adminAssets',cookie)).status,403);
  assert.equal((await post('/api/rpc/admin_dashboard',{},cookie)).status,200);
  assert.equal(calls.at(-1).authorization,'Bearer ' + token);
  assert.equal((await post('/api/rpc/qingyin_platform',{},cookie)).status,404);
});
