import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/admin', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
for (const [path, [file, type]] of assets) {
  assets.set(path, [readFileSync(new URL('./public/' + file, import.meta.url)), type]);
}

const markets = 'id,symbol,price_precision,quantity_precision,min_quantity,status,base_asset,quote_asset';
const openTables = {
  markets: ['public_markets', markets, 'symbol.asc'],
  tickers: ['market_tickers', 'market_id,last_price,bid_price,ask_price,high_24h,low_24h,volume_24h,quote_volume_24h,price_change_24h,source,updated_at'],
  assets: ['assets', 'id,symbol,name,asset_type,decimals,status,trading_enabled', 'symbol.asc'],
  settings: ['exchange_settings', 'key,value', 'key.asc']
};
const ownTables = {
  profile: ['profiles', 'username,display_name,account_status,jurisdiction_status,preferred_language,preferred_timezone,preferred_fiat', '', 'id'],
  balances: ['wallet_balances', 'asset_id,symbol,asset_name,decimals,available_balance,locked_balance', 'symbol.asc', 'user_id'],
  orders: ['orders', 'id,market_id,side,price,quantity,filled_quantity,status,created_at', 'created_at.desc', 'user_id'],
  recharges: ['recharge_requests', 'id,payment_type,fiat_currency,paid_amount,token_amount,status,review_note,created_at', 'created_at.desc', 'user_id'],
  withdrawals: ['withdrawals', 'id,asset_id,payout_type,fiat_currency,fiat_amount,amount,fee,status,review_note,rejection_reason,created_at', 'created_at.desc', 'user_id'],
  accounts: ['withdrawal_accounts', 'id,asset_id,label,network_code,account_type,fiat_currency,bank_name,account_last4,is_active', 'created_at.desc', 'user_id'],
  inbox: ['user_notifications', 'id,kind,title,body,read_at,created_at', 'created_at.desc', 'user_id'],
  adminRole: ['admin_members', 'role', '', 'user_id'],
  kyc: ['kyc_cases', 'id,provider,level,status,created_at,reviewed_at', 'created_at.desc', 'user_id'],
  deposits: ['deposits', 'id,asset_id,network,tx_hash,amount,confirmations,status,created_at', 'created_at.desc', 'user_id']
};
const adminTables = {
  adminAssets: ['assets', 'id,symbol,name,asset_type,decimals,status,trading_enabled', 'symbol.asc', ['super_admin','operations']],
  adminMarkets: ['markets', 'id,symbol,status,price_precision,quantity_precision,min_quantity', 'symbol.asc', ['super_admin','operations']],
  adminAudit: ['audit_logs', 'id,action,resource_type,resource_id,created_at', 'created_at.desc', ['super_admin','operations','compliance']],
  adminRisk: ['risk_flags', 'id,user_id,subject_type,severity,reason,status,created_at', 'created_at.desc', ['super_admin','operations','compliance','support']],
  adminCredit: ['internal_credit_allocations', 'id,recipient_user_id,amount,reason,created_at', 'created_at.desc', ['super_admin','finance']],
  adminOrders: ['orders', 'id,user_id,market_id,side,price,quantity,filled_quantity,status,created_at', 'created_at.desc', ['super_admin','operations','support','compliance']],
  adminKyc: ['kyc_cases', 'id,user_id,provider,level,status,created_at,reviewed_at', 'created_at.desc', ['super_admin','operations','compliance','support']]
};
const publicCalls = {
  get_public_candles: ['market_symbol','interval','limit'],
  get_public_order_book: ['market_symbol','depth'],
  get_public_trades: ['market_symbol','limit']
};
const userCalls = {
  submit_limit_order: ['market_symbol','side','price','quantity','client_order_id'],
  cancel_order: ['order_id'],
  get_my_transfer_history: ['limit'],
  transfer_asset: ['recipient_email','asset_symbol','amount','idempotency_key'],
  bind_withdrawal_account: ['asset_symbol','label','network_code','address','memo'],
  bind_bank_account: ['label','currency','bank_name','account_holder','account_number','country_code'],
  unbind_withdrawal_account: ['account_id'],
  request_bound_withdrawal: ['account_id','amount','idempotency_key'],
  request_fiat_withdrawal: ['account_id','amount','idempotency_key'],
  cancel_withdrawal: ['withdrawal_id'],
  submit_recharge: ['amount','reference','note','request_id'],
  mark_notifications_read: []
};
const adminCalls = {
  admin_dashboard: [],
  admin_find_account: ['identifier'],
  admin_review_account: ['user_id','status','jurisdiction','reference'],
  admin_recharge_queue: [],
  admin_review_recharge: ['recharge_id','decision','reason'],
  admin_review_withdrawal: ['withdrawal_id','decision','reason'],
  admin_reveal_withdrawal_bank: ['withdrawal_id'],
  admin_allocate_internal_credit: ['recipient_user_id','amount','reason','request_id'],
  admin_transfer_usdt: ['recipient_user_id','amount','reason','request_id'],
  admin_create_asset: ['symbol','name','asset_type','decimals','network_code','network_name','contract_address'],
  admin_set_asset_status: ['symbol','status','trading_enabled'],
  admin_create_market: ['base_asset_symbol','quote_asset_symbol','price_precision','quantity_precision','min_quantity'],
  admin_set_market_status: ['symbol','status'],
  admin_set_customer_service: ['label','url','enabled'],
  admin_set_deposit_receiving: ['asset_symbol','network_code','network_name','address','memo','instructions','enabled'],
  admin_set_fiat_cashout: ['currency','rate','fee','minimum','enabled'],
  admin_set_payment_receiving: ['config']
};

class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseUpstreamJson(raw) {
  // PostgreSQL numeric values can exceed JavaScript's precision.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  return JSON.parse(raw.replace(tokens, token => {
    if (token.startsWith('"')) return token;
    return /^-?\d+$/.test(token) && Number.isSafeInteger(Number(token)) ? token : '"' + token + '"';
  }));
}

function cookies(header = '') {
  return Object.fromEntries(header.split(/;\s*/).filter(piece => piece.includes('=')).map(piece => {
    const split = piece.indexOf('=');
    return [piece.slice(0, split), piece.slice(split + 1)];
  }));
}

function jwtSubject(token) {
  try {
    const subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
    return typeof subject === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(subject) ? subject : null;
  } catch {
    return null;
  }
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, '请求必须使用 JSON。');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 24_576) throw new HttpError(413, '请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, '请求内容格式错误。');
  }
}

export function createApp({ supabaseUrl, key, origin, codespacesPort, secureCookies = false, upstreamFetch = fetch }) {
  const upstreamUrl = new URL(supabaseUrl);
  if (upstreamUrl.protocol !== 'https:' || upstreamUrl.origin !== upstreamUrl.href.slice(0, -1) || upstreamUrl.username || upstreamUrl.password) {
    throw new Error('SUPABASE_URL 必须是无路径的 HTTPS 项目 URL。');
  }
  if (!key || /^sb_secret_/.test(key)) throw new Error('请配置 Supabase publishable key。');
  if (key.startsWith('eyJ')) {
    const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role;
    if (role !== 'anon') throw new Error('仅允许使用 publishable key 或旧版 anon key。');
  } else if (!key.startsWith('sb_publishable_')) {
    throw new Error('请配置 Supabase publishable key。');
  }

  async function upstream(path, token, body) {
    const headers = { apikey: key, accept: 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    let data;
    try {
      response = await upstreamFetch(new URL(path, upstreamUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(12_000)
      });
      const raw = await response.text();
      data = raw ? parseUpstreamJson(raw) : null;
    } catch {
      throw new HttpError(502, '暂时无法连接 Supabase。');
    }
    if (!response.ok) {
      const status = response.status >= 500 ? 502 : response.status;
      const code = data?.code || data?.error_code || '';
      const detail = data?.message || data?.msg || data?.error_description;
      const message = status === 502 ? 'Supabase 服务暂时不可用。' : String(detail || '请求被数据库拒绝。').slice(0, 350);
      throw new HttpError(status, message, code);
    }
    return data;
  }

  async function list([table, columns, sort, owner], token, subject, offset = 0) {
    const query = new URLSearchParams({ select: columns, limit: '100', offset: String(offset) });
    if (sort) query.set('order', sort);
    if (owner) query.set(owner, 'eq.' + subject);
    return upstream('/rest/v1/' + table + '?' + query, token);
  }

  function writeCookies(res, session) {
    const suffix = '; HttpOnly; SameSite=Strict; Path=/' + (secureCookies ? '; Secure' : '');
    const maxAge = Math.max(1, Math.min(86400, Number(session?.expires_in) || 3600));
    res.setHeader('Set-Cookie', [
      'qy_access=' + (session?.access_token || '') + suffix + '; Max-Age=' + (session ? maxAge : 0),
      'qy_refresh=' + (session?.refresh_token || '') + suffix + '; Max-Age=' + (session ? 604800 : 0)
    ]);
  }

  function send(res, status, data) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(data));
  }

  async function accountResponse(res, session) {
    writeCookies(res, session);
    const roles = await list(ownTables.adminRole, session.access_token, session.user.id);
    return { user: { id: session.user.id, email: session.user.email }, role: roles[0]?.role || null };
  }

  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'");
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-cache');
        res.end(file);
        return;
      }
      const { qy_access: token, qy_refresh: refresh } = cookies(req.headers.cookie);
      const subject = jwtSubject(token);
      const method = req.method;
      const offsetValue = url.searchParams.get('offset') ?? '0';
      const offset = /^[0-9]{1,7}$/.test(offsetValue) ? Number(offsetValue) : 0;
      if (method === 'POST' && path.startsWith('/api/')) {
        const expectedOrigin = origin || (secureCookies ? 'https://' : 'http://') + req.headers.host;
        // Codespaces rewrites the browser Origin to its internal localhost forwarding target.
        const proxyHost = `localhost:${codespacesPort}`;
        const fromCodespaces = codespacesPort && origin &&
          req.headers.origin === `https://${proxyHost}` &&
          req.headers.host === proxyHost &&
          req.headers['x-forwarded-host'] === new URL(origin).host &&
          req.headers['x-forwarded-proto'] === 'https' &&
          req.headers['sec-fetch-site'] === 'same-origin' &&
          ['cors', 'same-origin'].includes(req.headers['sec-fetch-mode']);
        if (req.headers.origin !== expectedOrigin && !fromCodespaces) throw new HttpError(403, '请求来源无效。');
      }
      if (method === 'POST' && ['/api/auth/login','/api/auth/signup'].includes(path)) {
        const { email, password } = await readJson(req);
        if (typeof email !== 'string' || typeof password !== 'string' || !email.includes('@') || !password) {
          throw new HttpError(400, '请填写有效的邮箱和密码。');
        }
        const signup = path.endsWith('/signup');
        const auth = await upstream(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', null, { email, password });
        return send(res, 200, auth.access_token ? await accountResponse(res, auth) : { confirmationRequired: true });
      }
      if (method === 'GET' && path === '/api/auth/session') {
        if (!subject) return send(res, 200, { user: null, canRefresh: Boolean(refresh) });
        try {
          const user = await upstream('/auth/v1/user', token);
          const roles = await list(ownTables.adminRole, token, user.id);
          return send(res, 200, { user: { id: user.id, email: user.email }, role: roles[0]?.role || null });
        } catch (error) {
          if (error.status === 401) return send(res, 200, { user: null, canRefresh: Boolean(refresh) });
          throw error;
        }
      }
      if (method === 'POST' && path === '/api/auth/refresh') {
        if (!refresh) return send(res, 200, { user: null });
        try {
          const auth = await upstream('/auth/v1/token?grant_type=refresh_token', null, { refresh_token: refresh });
          return send(res, 200, await accountResponse(res, auth));
        } catch (error) {
          if (![400, 401, 403].includes(error.status)) throw error;
          writeCookies(res, null);
          return send(res, 200, { user: null });
        }
      }
      if (method === 'POST' && path === '/api/auth/logout') {
        if (token) {
          try {
            await upstream('/auth/v1/logout?scope=local', token, {});
          } catch (error) {
            if (![401, 403, 502].includes(error.status)) throw error;
          }
        }
        writeCookies(res, null);
        return send(res, 200, { user: null });
      }
      const tableName = /^\/api\/data\/([a-zA-Z]+)$/.exec(path)?.[1];
      if (method === 'GET' && tableName) {
        if (Object.hasOwn(openTables, tableName)) return send(res, 200, await list(openTables[tableName], null, null, offset));
        if (!Object.hasOwn(ownTables, tableName) && !Object.hasOwn(adminTables, tableName) && tableName !== 'ledger') throw new HttpError(404, '接口不存在。');
        if (!subject) throw new HttpError(401, '请先登录。');
        if (Object.hasOwn(ownTables, tableName)) return send(res, 200, await list(ownTables[tableName], token, subject, offset));
        if (tableName === 'ledger') return send(res, 200, await list(['wallet_ledger_history', 'entry_id,reference_type,description,symbol,account_code,side,amount,created_at', 'created_at.desc'], token, null, offset));
        const [table, columns, sort, allowed] = adminTables[tableName];
        const roles = await list(ownTables.adminRole, token, subject);
        if (!allowed.includes(roles[0]?.role)) throw new HttpError(403, '当前后台角色无权读取此模块。');
        return send(res, 200, await list([table, columns, sort], token, null, offset));
      }
      const rpc = /^\/api\/rpc\/([a-z_]+)$/.exec(path)?.[1];
      if (method === 'POST' && rpc) {
        const isPublic = Object.hasOwn(publicCalls, rpc);
        const isAdmin = Object.hasOwn(adminCalls, rpc);
        if (!isPublic && !isAdmin && !Object.hasOwn(userCalls, rpc)) throw new HttpError(404, '接口不存在。');
        if (!isPublic && !subject) throw new HttpError(401, '请先登录。');
        if (isAdmin && !(await list(ownTables.adminRole, token, subject)).length) throw new HttpError(403, '当前账号没有后台权限。');
        const data = await readJson(req);
        const accepted = isPublic ? publicCalls[rpc] : isAdmin ? adminCalls[rpc] : userCalls[rpc];
        if (Object.keys(data).some(field => !accepted.includes(field))) throw new HttpError(400, '包含未定义的业务参数。');
        const args = Object.fromEntries(Object.entries(data).map(([k, v]) => ['p_' + k, v]));
        return send(res, 200, await upstream('/rest/v1/rpc/' + rpc, isPublic ? null : token, args));
      }
      throw new HttpError(404, '页面或接口不存在。');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, {
        error: error.status ? error.message : '服务器内部错误。',
        code: error.code || ''
      });
    }
  };
}

export function startupOptions(env) {
  const codespace = env.CODESPACES === 'true';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');

  let origin = env.APP_ORIGIN;
  if (codespace && !origin) {
    const name = env.CODESPACE_NAME || '';
    const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || '';
    if (!/^[a-z0-9-]+$/.test(name) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) {
      throw new Error('Codespaces 转发地址不可用，请在环境变量 APP_ORIGIN 中填写完整 HTTPS 地址。');
    }
    origin = `https://${name}-${port}.${domain}`;
  }
  const example = codespace ? parseEnv(readFileSync(new URL('./.env.example',import.meta.url),'utf8')) : {};
  return {
    port,
    host:env.HOST || (codespace ? '0.0.0.0' : '127.0.0.1'),
    origin,
    codespacesPort:codespace ? port : undefined,
    secureCookies:codespace || env.COOKIE_SECURE === 'true',
    supabaseUrl:env.SUPABASE_URL || 'https://plukopgifmrlyjwqryqu.supabase.co',
    key:env.SUPABASE_PUBLISHABLE_KEY || example.SUPABASE_PUBLISHABLE_KEY
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const options = startupOptions(process.env);
  const handler = createApp(options);
  const label = options.origin || `http://127.0.0.1:${options.port}`;
  createServer(handler).listen(options.port,options.host,() => console.log('清音交易所已启动 ' + label));
}
