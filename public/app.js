const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main');
const modal = $('#modal');
const state = {
  session: null, role: null, sessionReady: false, markets: [], assets: [], tickers: {}, settings: {},
  market: '', interval: '1s', quoteSource: 'reference', filter: '', adminTab: 'overview', walletTab: 'balances',
  tradeTab: 'book', adminAccount: null, revision: 0, marketRevision: 0
};
const requestKeys = new Map();
const idempotentCalls = {
  submit_limit_order: 'client_order_id', transfer_asset: 'idempotency_key', submit_recharge: 'request_id',
  admin_adjust_usdt: 'request_id',
  request_bound_withdrawal: 'idempotency_key', request_fiat_withdrawal: 'idempotency_key',
  admin_allocate_internal_credit: 'request_id', admin_transfer_usdt: 'request_id'
};
const words = {
  active:'正常', inactive:'停用', halted:'暂停', delisted:'下架', pending:'待处理', pending_review:'待审核',
  approved:'已通过', restricted:'受限', rejected:'已拒绝', suspended:'封禁', closed:'已关闭', reviewed:'已审核',
  new:'新委托', open:'挂单中', partially_filled:'部分成交', filled:'已成交', cancelled:'已取消', failed:'失败',
  credited:'已入账', requested:'待审核', reviewing:'审核中', completed:'已完成', broadcasting:'处理中',
  crypto:'数字资产', fiat:'法币', credit:'贷记', debit:'借记', available:'可用', locked:'冻结',
  buy:'买入', sell:'卖出', incoming:'转入', outgoing:'转出', bank:'银行账户',
  super_admin:'超级管理员', finance:'财务管理员', operations:'运营管理员', compliance:'合规管理员', support:'客服'
};
const st = (value) => words[value] ?? value;
const isAdminPage = () => location.pathname === '/admin';
const current = () => (location.hash.slice(1) || (isAdminPage() ? 'overview' : 'trade'));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const safeHttps = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
};
function customerLink(value) {
  if (typeof value !== 'string') return '';
  return safeHttps(value) || (/^mailto:[^\s<>@?]+@[^\s<>@?]+\.[a-z]{2,}$/i.test(value) || /^tel:[+0-9().-]{3,32}$/.test(value) ? value : '');
}
const rows = (value) => Array.isArray(value) ? value : [];
const decimal = value => value === null || value === undefined || value === '' ? '—' : String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const short = value => String(value || '').slice(0, 8);
const marketName = id => state.markets.find(m => m.id === id)?.symbol || short(id);
const assetName = id => state.assets.find(a => a.id === id)?.symbol || short(id);
const amountValue = value => String(value).trim();
const e = esc;
const pendingOrder = s => ['new','open','partially_filled'].includes(s);
const pendingWithdrawal = s => ['requested','reviewing'].includes(s);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let refreshJob;
async function rawApi(path, body) {
  const options = body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) };
  let response;
  try {
    response = await fetch('/api/' + path, options);
  } catch {
    throw new ApiError(502, '网络连接中断，请重试。');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, result?.error || '请求失败，请检查服务是否在线。');
  if (result === null && !response.headers.get('content-type')?.includes('application/json')) throw new ApiError(502,'服务返回了无效响应。');
  return result;
}

async function refreshSession() {
  if (!refreshJob) {
    const refresh = () => rawApi('auth/refresh', {});
    const tryRefresh = navigator.locks ? () => navigator.locks.request('qingyin-session-refresh', async () => {
      const current = await rawApi('auth/session');
      return current.user ? current : refresh();
    }) : refresh;
    refreshJob = tryRefresh().then(useSession).finally(() => { refreshJob = null; });
  }
  return refreshJob;
}

function useSession(result) {
  if (state.session?.id !== result.user?.id) {
    unreadSeen = null;
    state.unreadCount = 0;
  }
  state.session = result.user || null;
  state.role = result.role || null;
  return result;
}

async function api(path, body) {
  try {
    return await rawApi(path, body);
  } catch (error) {
    if (error.status !== 401 || !state.session) throw error;
    const result = await refreshSession();
    if (result.user) return rawApi(path, body);
    renderNav();
    throw new ApiError(401, '登录已过期，请重新登录。');
  }
}
const data = (name, offset = 0) => api('data/' + name + (offset ? '?offset=' + offset : ''));
const rpc = (name, payload = {}) => api('rpc/' + name, payload);
async function mutation(name, payload) {
  const field = idempotentCalls[name];
  if (!field) return rpc(name, payload);
  const signature = name + JSON.stringify(payload);
  if (!requestKeys.has(signature)) requestKeys.set(signature, crypto.randomUUID());
  const result = await rpc(name, { ...payload, [field]: requestKeys.get(signature) });
  requestKeys.delete(signature);
  return result;
}

function showNotice(text) {
  const notice = $('#notice');
  notice.textContent = text;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.textContent = ''; }, 4500);
}

let unreadSeen = null;
let unreadLoading = false;
function updateUnreadBadge() {
  const badge = $('#nav-unread');
  if (!badge) return;
  const count = state.unreadCount || 0;
  badge.textContent = count === 100 ? '99+' : count || '';
  badge.hidden = count === 0;
}

async function refreshUnread() {
  if (!state.session?.id || unreadLoading) return;
  const userId = state.session.id;
  unreadLoading = true;
  try {
    const messages = rows(await data('unread'));
    if (userId !== state.session?.id) return;
    if (unreadSeen) {
      const added = messages.filter(message => !unreadSeen.has(message.id));
      if (added.length) {
        showNotice(added.length === 1 ? added[0].title : `有 ${added.length} 条新的业务消息`);
        if (typeof Notification === 'function' && Notification.permission === 'granted') {
          try { new Notification('清音交易所',{body:'有新业务消息，请进入交易所查看。',tag:'qingyin-inbox'}); } catch {}
        }
        if (!isAdminPage() && current() === 'inbox' && pageOffset('inbox') === 0) void render();
      }
    }
    unreadSeen = new Set(messages.map(message => message.id));
    state.unreadCount = messages.length;
    updateUnreadBadge();
  } catch {
    // The next check retries without disturbing the current operation.
  } finally {
    unreadLoading = false;
  }
}

const button = (label, action, value = '', classes = '') => `<button type="button" class="button ${classes}" data-action="${e(action)}" data-value="${e(value)}">${e(label)}</button>`;
const submit = (label, disabled = false) => `<button type="submit" class="button primary${disabled ? ' block' : ''}" ${disabled ? 'disabled' : ''}>${e(label)}</button>`;
const stateTag = value => `<span class="pill">${e(st(value) || '—')}</span>`;
const empty = (label = '暂无记录') => `<div class="empty">${e(label)}</div>`;
const errorBlock = error => `<div class="panel-body"><p class="error">${e(error.message)}</p></div>`;
const section = (title, contents, actions = '', cls = '') => `<section class="panel ${cls}"><div class="panel-head"><h2>${e(title)}</h2>${actions}</div>${contents}</section>`;
const body = contents => `<div class="panel-body">${contents}</div>`;
const hero = (title, subtitle, aside = '') => `<div class="hero"><div><h1>${e(title)}</h1><p>${e(subtitle)}</p></div>${aside}</div>`;
const num = value => `<span class="number">${e(decimal(value))}</span>`;
const date = value => e(time(value));
const wrap = value => `<span class="wrap-cell">${e(value || '—')}</span>`;
const table = (headers, entries, render, fallback) => !entries.length ? empty(fallback) :
  `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th scope="col">${e(header)}</th>`).join('')}</tr></thead><tbody>${entries.map(record => '<tr>' + render(record).map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('')}</tbody></table></div>`;
const tabs = (items, active, action) => `<div class="tabs">${items.map(([id,label]) => `<button type="button" class="tab" ${active === id ? 'aria-current="true"' : ''} data-action="${e(action)}" data-value="${e(id)}">${e(label)}</button>`).join('')}</div>`;
const fields = (label, name, options = {}) => {
  const { type = 'text', value = '', required = true, wide = false, values, hint, autocomplete, mode, max, min, maxlen, readonly } = options;
  let input;
  if (values) {
    input = `<select name="${e(name)}" ${required ? 'required' : ''}>${values.map(option => {
      const [key, title] = Array.isArray(option) ? option : [option, option];
      return `<option value="${e(key)}" ${String(key) === String(value) ? 'selected' : ''}>${e(title)}</option>`;
    }).join('')}</select>`;
  } else if (type === 'textarea') {
    input = `<textarea name="${e(name)}" ${required ? 'required' : ''} ${maxlen ? 'maxlength="' + maxlen + '"' : ''}>${e(value)}</textarea>`;
  } else {
    input = `<input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''} ${autocomplete ? 'autocomplete="' + e(autocomplete) + '"' : ''} ${mode ? 'inputmode="' + e(mode) + '"' : ''} ${min !== undefined ? 'min="' + e(min) + '"' : ''} ${max !== undefined ? 'max="' + e(max) + '"' : ''} ${maxlen ? 'maxlength="' + maxlen + '"' : ''}>`;
  }
  return `<label${wide ? ' class="wide"' : ''}>${e(label)}${input}${hint ? '<small>' + e(hint) + '</small>' : ''}</label>`;
};
const check = (label, name, enabled) => `<label class="inline-check"><input type="checkbox" name="${e(name)}" ${enabled ? 'checked' : ''}>${e(label)}</label>`;
const hidden = (name, value) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
const form = (kind, inputs, label, opt = {}) => `<form class="${opt.single ? 'stack' : 'form-grid'}" data-form="${e(kind)}">${inputs}<p class="form-status wide" role="status" aria-live="polite"></p><div class="actions wide">${submit(label, opt.disabled)}${opt.extra || ''}</div></form>`;
const formPanel = (title, kind, inputs, label, opt) => section(title, body(form(kind, inputs, label, opt)), '', 'form-panel');
const facts = (details) => `<dl class="pre-facts">${details.map(([key,value]) => `<dt>${e(key)}</dt><dd>${e(value ?? '—')}</dd>`).join('')}</dl>`;
const errorOr = (result, view) => result.status === 'fulfilled' ? view(result.value) : errorBlock(result.reason);
const panelResults = (queries) => Promise.allSettled(queries);

function renderNav() {
  const page = current();
  const userPages = [['trade','现货交易'],['wallet','资产'],['orders','委托'],['inbox','消息']];
  const nav = isAdminPage() ? [['overview','后台概览'],['accounts','账户'],['finance','财务'],['catalog','资产与市场'],['settings','设置'],['audit','审计']] : userPages;
  const destination = isAdminPage() ? '/admin' : '/';
  $('#nav').innerHTML = nav.filter(([id]) => !isAdminPage() || adminAccess(id)).map(([id,label]) =>
    `<a class="nav-link" href="${destination}#${id}" ${page === id ? 'aria-current="page"' : ''}>${e(label)}${id === 'inbox' ? '<span class="unread-badge" id="nav-unread" hidden></span>' : ''}</a>`).join('');
  updateUnreadBadge();
  $('#account').innerHTML = isAdminPage() ?
    '<a class="button tiny" href="/">交易端</a>' :
    (state.role ? '<a class="button tiny" href="/admin">管理后台</a>' : '');
  $('#account').innerHTML += state.session ? `<span class="email muted">${e(state.session.email || st(state.role))}</span>${button('退出','logout','','tiny')}` :
    button(isAdminPage() ? '管理员登录' : '登录', 'login', '', 'primary tiny');
  const service = state.settings.customer_service;
  const url = service?.enabled && customerLink(service.url);
  if (!isAdminPage()) $('#account').innerHTML += url ? `<a class="button tiny" href="${e(url)}" rel="noopener noreferrer"${safeHttps(url) ? ' target="_blank"' : ''}>${e(service.label || '联系客服')}</a>` : button('联系客服','service','','tiny');
  $('#footer-content').textContent = 'USDT 为站内记账单位';
}

function renderModal(title, contents) {
  modal.innerHTML = `<div class="panel-head"><h2 id="modal-title">${e(title)}</h2>${button('关闭','close','','tiny')}</div>${body(contents)}`;
  if (!modal.open) modal.showModal();
}

function showAuth(signup = false) {
  const admin = isAdminPage();
  const kind = signup ? 'signup' : 'login';
  const toggle = admin ? '' : button(signup ? '使用已有账户登录' : '创建账户', signup ? 'login' : 'signup', '', 'tiny');
  renderModal(signup ? '创建清音账户' : admin ? '管理员登录' : '登录清音交易所', form(kind,
    fields('邮箱','email',{type:'email',autocomplete:'email',maxlen:254}) +
    fields('密码','password',{type:'password',autocomplete:signup ? 'new-password' : 'current-password',maxlen:200}),
    signup ? '注册' : '登录', { single:true, extra:toggle }));
}

function gate(title) {
  if (state.session) return '';
  return `<div class="mini-hero"><h2>${e(title)}</h2><p>请使用清音交易所账户登录。</p>${button('登录','login','','primary')}</div>`;
}

async function refreshCatalog() {
  const [markets, assets, tickers, settings] = await panelResults(['markets','assets','tickers','settings'].map(key => data(key)));
  if (markets.status === 'fulfilled') {
    state.markets = rows(markets.value);
    state.catalogError = null;
  } else state.catalogError = markets.reason;
  if (assets.status === 'fulfilled') state.assets = rows(assets.value);
  if (tickers.status === 'fulfilled') state.tickers = Object.fromEntries(rows(tickers.value).map(row => [row.market_id,row]));
  if (settings.status === 'fulfilled') state.settings = Object.fromEntries(rows(settings.value).map(row => [row.key,row.value]));
  if (!state.markets.some(m => m.symbol === state.market)) {
    state.market = (state.markets.find(m => m.symbol === 'BTC/USDT') || state.markets[0])?.symbol || '';
  }
}

function marketList() {
  const filter = state.filter.trim().toUpperCase();
  const matches = state.markets.filter(m => m.symbol.includes(filter));
  return matches.map(m => {
    const base = m.base_asset || m.symbol.split('/')[0];
    const ticker = state.tickers[m.id];
    return `<button class="market-item" data-action="market" data-value="${e(m.symbol)}" aria-pressed="${m.symbol === state.market}">
      <span class="row"><span class="coin" aria-hidden="true">${e(base.slice(0,2))}</span><span><strong>${e(m.symbol)}</strong><small>${e(m.status === 'active' ? m.quote_asset : st(m.status))}</small></span></span>
      <span class="number">${e(decimal(ticker?.last_price))}</span></button>`;
  }).join('') || empty(state.catalogError ? state.catalogError.message : '没有匹配的交易对');
}

function chartPrices(ticker, reference) {
  const change = reference ? ticker?.price_change_pct : ticker?.price_change_24h;
  return `<strong class="number">${e(decimal(ticker?.last_price))}</strong>` + (change == null ? '' :
    `<span class="${Number(change) >= 0 ? 'gain' : 'loss'} number">${e(decimal(change))}${reference ? '%' : ''} 24h 变动</span>`);
}

function chartMetrics(ticker, reference) {
  const metrics = [[reference ? '参考最新价' : '最新成交价',ticker?.last_price],['24h 最高',ticker?.high_24h],
    ['24h 最低',ticker?.low_24h],['24h 成交量',ticker?.volume_24h]];
  return metrics.map(([title,value]) => `<div class="metric"><small>${e(title)}</small><strong>${e(decimal(value))}</strong></div>`).join('');
}

function tradeShell() {
  const market = state.markets.find(m => m.symbol === state.market);
  const reference = state.quoteSource === 'reference';
  const ticker = !reference && market ? state.tickers[market.id] : null;
  const sourceTabs = tabs([['reference','参考行情'],['exchange','本站成交 K 线']],state.quoteSource,'quote-source');
  const levels = (reference ? ['1s','1m','5m','15m','1h','4h','1d'] : ['1m','5m','15m','1h','4h','1d']).map(i => [i,i]);
  const canTrade = Boolean(market?.status === 'active' && state.settings.spot_trading_enabled === true);
  const orderForm = state.session ?
    form('submit_limit_order',
      hidden('market_symbol', state.market) +
      fields('方向','side',{values:[['buy','买入'],['sell','卖出']]}) +
      fields('限价 · ' + (market?.quote_asset || ''),'price',{mode:'decimal',hint:market ? '最多 ' + market.price_precision + ' 位小数' : ''}) +
      fields('数量 · ' + (market?.base_asset || ''),'quantity',{mode:'decimal',hint:market ? '最低 ' + decimal(market.min_quantity) + '，最多 ' + market.quantity_precision + ' 位小数' : ''}),
      '提交限价委托', { single:true, disabled:!canTrade }) :
    `<p class="muted">登录后可提交限价委托。</p>${button('登录交易','login','','primary block')}`;
  const controls = '<div class="actions">' +
    (state.settings.balance_model?.type === 'internal_credit' ? '<span class="pill">站内记账</span>' : '') +
    button('刷新行情','refresh-market','','tiny') + '</div>';
  return hero('现货交易', '查看行情、订单簿与历史成交', controls) +
    `<div class="layout">
      ${section('交易对', `<input id="market-search" class="search" aria-label="搜索交易对" placeholder="搜索交易对" value="${e(state.filter)}"><div class="market-list" id="market-list">${marketList()}</div>`)}
      <div class="stack">
        ${section(market?.symbol || '市场行情', `<div class="panel-head">${sourceTabs}</div>
          <div id="chart-price" class="price-top">${chartPrices(ticker,reference)}</div>
          <div id="chart" class="chart-wrap">${empty(market ? '正在读取 K 线…' : '暂无交易对')}</div>
          <div class="panel-head"><small id="chart-info" class="muted">${reference ? '正在连接参考行情…' : (ticker?.updated_at ? '行情更新 ' + date(ticker.updated_at) : '')}</small></div>`, tabs(levels,state.interval,'interval'))}
        ${section(reference ? '参考市场数据' : '本站市场数据', body(`<div id="chart-metrics" class="grid-two">${chartMetrics(ticker,reference)}</div>`))}
      </div>
      <div class="stack trade-actions">
        ${section('本站市场深度', `<div id="market-depth">${empty(market ? '正在读取…' : '暂无交易对')}</div>`, tabs([['book','订单簿'],['trades','成交']],state.tradeTab,'trade-tab'), 'compact')}
        ${section('限价委托', body(orderForm))}
      </div>
    </div>`;
}

function candleChart(input) {
  const values = rows(input).filter(row => [row.open,row.close,row.high,row.low].every(v => v !== null && Number.isFinite(Number(v)))).sort((a,b) => Date.parse(a.open_time) - Date.parse(b.open_time));
  if (!values.length) return '<div class="chart-empty">这个周期暂无 K 线数据</div>';
  const bounds = values.flatMap(r => [Number(r.high),Number(r.low)]);
  const high = Math.max(...bounds);
  const low = Math.min(...bounds);
  const range = high - low || Math.max(1, Math.abs(high) * .01);
  const span = 620 / values.length;
  const y = price => high === low ? 125 : 14 + (high - Number(price)) * 220 / range;
  const grid = Array.from({length:5}, (_, i) => {
    const price = high - (high - low) * i / 4;
    const line = 14 + 55 * i;
    return `<path d="M0 ${line}H625" stroke="#34483b"/><text x="632" y="${line + 4}" fill="#9aafa4" font-size="10">${e(decimal(Number(price.toPrecision(7))))}</text>`;
  }).join('');
  const bars = values.map((r,i) => {
    const x = (i + .5) * span;
    const color = Number(r.close) >= Number(r.open) ? '#a5f080' : '#ff8991';
    const width = Math.max(2, Math.min(17, span * .64));
    return `<g><title>${e(time(r.open_time))} 开 ${e(decimal(r.open))} 高 ${e(decimal(r.high))} 低 ${e(decimal(r.low))} 收 ${e(decimal(r.close))}</title><line x1="${x}" x2="${x}" y1="${y(r.high)}" y2="${y(r.low)}" stroke="${color}"/><rect x="${x - width / 2}" y="${Math.min(y(r.open),y(r.close))}" width="${width}" height="${Math.max(2,Math.abs(y(r.open) - y(r.close)))}" fill="${color}"/></g>`;
  }).join('');
  return `<svg viewBox="0 0 715 260" role="img" aria-label="价格 K 线图">${grid}${bars}<text x="0" y="253" fill="#9aafa4" font-size="10">${e(time(values[0].open_time))}</text><text x="625" y="253" text-anchor="end" fill="#9aafa4" font-size="10">${e(time(values.at(-1).open_time))}</text></svg>`;
}

let activeMarketLoad = 0;
let referenceStream;
let referenceSnapshot;
let lastCandleEvent = 0;

function stopReferenceStream() {
  referenceStream?.close();
  referenceStream = undefined;
  referenceSnapshot = undefined;
  lastCandleEvent = 0;
}

function displayReference(updateChart,updateTicker) {
  const {candles,ticker,interval,updated_at} = referenceSnapshot;
  if (updateChart) $('#chart').innerHTML = candleChart(candles);
  if (updateTicker) {
    $('#chart-price').innerHTML = chartPrices(ticker,true);
    $('#chart-metrics').innerHTML = chartMetrics(ticker,true);
  }
  const mode = lastCandleEvent ? (interval === '1s' ? '秒级推送' : '实时推送') : '快照';
  $('#chart-info').textContent = `参考行情 · ${mode} · ${time(updated_at || ticker.updated_at)} · 仅供参考`;
}

function connectReferenceStream(market,interval) {
  if (referenceStream || typeof EventSource !== 'function') return;
  const stream = new EventSource('/api/data/marketStream?' + new URLSearchParams({symbol:market,interval}));
  referenceStream = stream;
  stream.addEventListener('message',event => {
    if (referenceStream !== stream || !referenceSnapshot) return;
    const update = JSON.parse(event.data);
    if (update.candle) {
      const bars = referenceSnapshot.candles;
      const index = bars.findIndex(bar => bar.open_time === update.candle.open_time);
      if (index >= 0) bars[index] = update.candle;
      else if (!bars.length || update.candle.open_time > bars.at(-1).open_time) bars.push(update.candle);
      if (bars.length > 90) bars.shift();
      lastCandleEvent = Date.now();
    }
    if (update.ticker) referenceSnapshot.ticker = update.ticker;
    const eventTime = update.updated_at || update.ticker?.updated_at;
    if (eventTime && eventTime > (referenceSnapshot.updated_at || '')) referenceSnapshot.updated_at = eventTime;
    displayReference(Boolean(update.candle),Boolean(update.ticker));
  });
  stream.addEventListener('error',() => {
    if (referenceStream !== stream || !referenceSnapshot) return;
    lastCandleEvent = 0;
    displayReference(false,false);
  });
}

async function loadMarket({chartOnly = false} = {}) {
  if (!state.market || !$('#chart')) return;
  const revision = ++state.marketRevision;
  activeMarketLoad = revision;
  const {market,interval,quoteSource,tradeTab} = state;
  const reference = quoteSource === 'reference';
  const started = Date.now();
  const chartRequest = reference
    ? api('data/marketQuote?' + new URLSearchParams({symbol:market,interval}))
    : rpc('get_public_candles',{market_symbol:market,interval,limit:90});
  const chartView = (async () => {
    try {
      const result = await chartRequest;
      if (revision !== state.marketRevision) return;
      if (!reference) {
        $('#chart').innerHTML = candleChart(result);
        return;
      }
      if (lastCandleEvent > started) return;
      lastCandleEvent = 0;
      referenceSnapshot = result;
      displayReference(true,true);
      connectReferenceStream(market,interval);
    } catch (error) {
      if (revision !== state.marketRevision) return;
      if (!chartOnly || !$('#chart svg')) $('#chart').innerHTML = errorBlock(error);
      if (reference) $('#chart-info').textContent = '参考行情更新失败，稍后自动重试。';
    }
  })();
  const bookView = chartOnly ? null : (async () => {
    const [book] = await panelResults([tradeTab === 'book' ? rpc('get_public_order_book',{market_symbol:market,depth:15}) : rpc('get_public_trades',{market_symbol:market,limit:30})]);
    if (revision !== state.marketRevision) return;
    $('#market-depth').innerHTML = errorOr(book,value => tradeTab === 'book' ?
      table(['方向','价格','数量'],rows(value),r => [`<span class="${r.side === 'buy' ? 'gain' : 'loss'}">${e(st(r.side))}</span>`,num(r.price),num(r.quantity)],'暂无挂单') :
      table(['价格','数量','成交时间'],rows(value),r => [num(r.price),num(r.quantity),date(r.executed_at)],'暂无成交'));
  })();
  try {
    await Promise.all([chartView,bookView]);
  } finally {
    if (activeMarketLoad === revision) activeMarketLoad = 0;
  }
}

function ordersView(value, admin = false) {
  return table(['交易对','方向','限价','数量','已成交','状态','时间',admin ? '用户' : '操作'], rows(value), r => [
    e(marketName(r.market_id)), e(st(r.side)), num(r.price), num(r.quantity), num(r.filled_quantity),
    stateTag(r.status), date(r.created_at), admin ? e(r.user_id) :
      pendingOrder(r.status) ? button('撤单','cancel-order',r.id,'tiny danger') : '—'
  ], '暂无委托');
}

async function pagedPanel(title, name, view, offset = 0) {
  const records = await data(name, offset);
  const previous = offset ? button('上一页','page',name + '|' + (offset - 100),'tiny') : '';
  const next = records.length === 100 ? button('下一页','page',name + '|' + (offset + 100),'tiny') : '';
  return section(title, view(records), '<div class="actions">' + previous + next + '</div>');
}
const offsets = {};
const pageOffset = name => offsets[name] || 0;

async function renderOrders() {
  const title = hero('我的委托', '查看订单状态并撤销未完成的限价委托');
  if (!state.session) return title + gate('登录查看委托');
  const [orders,trades] = await panelResults([
    pagedPanel('委托记录','orders',ordersView,pageOffset('orders')),
    pagedPanel('我的成交','myTrades',value => table(['交易对','方向','价格','数量','手续费','时间'],rows(value),r =>
      [e(marketName(r.market_id)),e(st(r.side)),num(r.price),num(r.quantity),num(r.fee),date(r.executed_at)]),pageOffset('myTrades'))
  ]);
  return title + `<div class="stack">${errorOr(orders,v=>v)}${errorOr(trades,v=>v)}</div>`;
}

async function renderInbox() {
  const title = hero('消息', '入账与审核通知');
  if (!state.session) return title + gate('登录查看消息');
  const messages = await data('inbox',pageOffset('inbox'));
  const controls = (typeof Notification === 'function' && Notification.permission === 'default' ? button('启用桌面提醒','notifications','','tiny') : '') +
    ((state.unreadCount || messages.some(r => !r.read_at)) ? button('全部标记已读','read-all','','tiny') : '') +
    (pageOffset('inbox') ? button('上一页','page','inbox|' + (pageOffset('inbox') - 100),'tiny') : '') +
    (messages.length === 100 ? button('下一页','page','inbox|' + (pageOffset('inbox') + 100),'tiny') : '');
  return title + section('站内通知', messages.length ? messages.map(r =>
    `<article class="message-entry ${r.read_at ? '' : 'unread'}"><strong>${e(r.title)}</strong><p>${e(r.body)}</p><small class="muted">${date(r.created_at)}${r.read_at ? '' : ' · 未读'}</small></article>`).join('') : empty('暂无通知'), '<div class="actions">' + controls + '</div>');
}

const walletTabs = [['balances','余额'],['recharge','充值'],['withdraw','提现'],['transfer','站内转账'],['ledger','账本'],['profile','账户信息']];

async function renderWallet() {
  const title = hero('资产', '查看余额与账本，管理收付款申请', '<span class="pill">站内记账</span>');
  if (!state.session) return title + gate('登录查看资产');
  const tab = state.walletTab;
  let content;
  if (tab === 'balances') {
    content = await pagedPanel('账户余额','balances', value =>
      table(['资产','可用','冻结'],rows(value),r => [`<strong>${e(r.symbol)}</strong> <small class="muted">${e(r.asset_name)}</small>`,num(r.available_balance),num(r.locked_balance)],'暂无资产余额'),pageOffset('balances'));
  } else if (tab === 'recharge') {
    content = await rechargePanel();
  } else if (tab === 'withdraw') {
    content = await withdrawalPanel();
  } else if (tab === 'transfer') {
    const result = await panelResults([rpc('get_my_transfer_history',{limit:50})]);
    content = `<div class="grid-two">
      ${formPanel('发起站内转账','transfer_asset',
        fields('收款人邮箱','recipient_email',{type:'email',wide:true,maxlen:254}) +
        fields('资产','asset_symbol',{values:state.assets.map(r => r.symbol),value:'USDT'}) +
        fields('数量','amount',{mode:'decimal'}),'提交转账')}
      ${section('最近 50 笔转账',errorOr(result[0], value => table(['方向','资产','数量','时间'],rows(value),r => [e(st(r.direction)),e(r.asset_symbol),num(r.amount),date(r.created_at)])))}
    </div>`;
  } else if (tab === 'ledger') {
    content = await pagedPanel('账本明细','ledger', value => table(['类型','资产','账户','方向','数量','说明','时间'],rows(value),
      r => [e(r.reference_type),e(r.symbol),e(st(r.account_code)),e(st(r.side)),num(r.amount),wrap(r.description),date(r.created_at)]),pageOffset('ledger'));
  } else {
    const [profile, cases] = await panelResults([data('profile'),data('kyc')]);
    content = `<div class="grid-two">${section('账户信息', errorOr(profile,value => {
      const r = rows(value)[0] || {};
      return body(facts([['邮箱',state.session.email],['用户名',r.username],['账户状态',st(r.account_status)],['地区审核',st(r.jurisdiction_status)]])) +
        body(form('edit-profile',fields('显示名称','display_name',{value:r.display_name,required:false,maxlen:100}) +
          fields('偏好语言','preferred_language',{value:r.preferred_language || 'zh-CN',values:[['zh-CN','简体中文'],['en','English'],...['id','ja','ko','th','es','pt-BR','fr','de','tr','vi']]}) +
          fields('偏好时区','preferred_timezone',{value:r.preferred_timezone || 'Asia/Shanghai',maxlen:64}) +
          fields('偏好法币','preferred_fiat',{value:r.preferred_fiat || 'USDT',values:['USDT','USD','EUR','IDR','SGD','JPY','KRW']}),'保存资料'));
    }))}${section('身份审核记录',errorOr(cases,value => table(['服务商','等级','状态','创建时间'],rows(value),r => [e(r.provider),e(r.level),stateTag(r.status),date(r.created_at)])))}</div>`;
  }
  return title + `<div class="stack">${tabs(walletTabs,tab,'wallet-tab')}${content}</div>`;
}

async function rechargePanel() {
  const receiving = state.settings.payment_receiving || {};
  const [recharge, deposits] = await panelResults([
    pagedPanel('充值申请','recharges',value => table(['付款币种','付款金额','站内记账数量','状态','审核说明','时间'],rows(value),r =>
      [e(r.fiat_currency || st(r.payment_type)),num(r.paid_amount),num(r.token_amount),stateTag(r.status),wrap(r.review_note),date(r.created_at)]),pageOffset('recharges')),
    pagedPanel('入账记录','deposits',value => table(['资产','网络或渠道','数量','状态','时间'],rows(value),r =>
      [e(assetName(r.asset_id)),e(r.network),num(r.amount),stateTag(r.status),date(r.created_at)]),pageOffset('deposits'))
  ]);
  let details = empty('当前法币收款通道未启用');
  if (receiving.enabled && receiving.payment_type === 'fiat') {
    const image = safeHttps(receiving.qr_image_url);
    const paymentLink = safeHttps(receiving.qr_payload);
    details = body(facts([['付款币种',receiving.fiat_currency],['收款人',receiving.receiver_name],['开户行',receiving.bank_name],['收款账号',receiving.account_number],
      ['每 1 站内记账单位对应的法币金额',decimal(receiving.rate)],['付款说明',receiving.instructions]]) +
      (image ? `<img class="payment-qr" alt="收款二维码" src="${e(image)}">` : '') +
      (paymentLink ? `<p><a class="button tiny" href="${e(paymentLink)}" target="_blank" rel="noopener noreferrer">打开付款链接</a></p>` :
        receiving.qr_payload ? `<p class="muted wrap-cell">支付码内容 ${e(receiving.qr_payload)}</p>` : '') +
      '<p class="form-help section-gap">付款后提交核实申请，审核结果会发送到站内消息。</p>');
  }
  const rechargeForm = receiving.enabled && receiving.payment_type === 'fiat' ? formPanel('提交付款核实','submit_recharge',
    fields('实付金额 · ' + receiving.fiat_currency,'amount',{mode:'decimal'}) +
    fields('付款流水号','reference',{maxlen:128}) +
    fields('备注','note',{type:'textarea',wide:true,required:false,maxlen:500}),'提交核实') : '';
  return `<div class="stack"><div class="grid-two">${section('收款信息',details)}${rechargeForm}</div>${errorOr(recharge,v => v)}${errorOr(deposits,v => v)}</div>`;
}

const fiatList = ['CNY','USD','EUR','GBP','SGD','IDR','JPY','KRW','HKD'];
async function withdrawalPanel() {
  const [accounts, history] = await panelResults([
    data('accounts'), pagedPanel('提现申请','withdrawals',value => table(['类型','资产','申请数量','手续费','法币到账金额','状态','付款流水','审核说明','时间','操作'],rows(value),r =>
      [e(st(r.payout_type)),e(assetName(r.asset_id)),num(r.amount),num(r.fee), e(r.fiat_amount == null ? '—' : decimal(r.fiat_amount) + ' ' + r.fiat_currency),
        stateTag(r.status),wrap(r.tx_hash),wrap(r.rejection_reason || r.review_note),date(r.created_at),
        pendingWithdrawal(r.status) ? button('取消','cancel-withdrawal',r.id,'tiny danger') : '—']),pageOffset('withdrawals'))
  ]);
  const active = rows(accounts.value).filter(r => r.is_active);
  const cashout = state.settings.fiat_cashout || {};
  const receiving = state.settings.deposit_receiving || {};
  const onchain = state.settings.onchain_withdrawals_enabled === true;
  const bankAccounts = active.filter(a => a.account_type === 'bank' && a.fiat_currency === cashout.fiat_currency);
  const cryptoAccounts = active.filter(a => a.account_type === 'crypto');
  const opts = list => list.map(a => [a.id, a.label + (a.account_last4 ? ' · ' + a.account_last4 : '')]);
  const bankBind = formPanel('绑定银行账户','bind_bank_account',
    fields('标签','label',{maxlen:80}) + fields('法币','currency',{values:fiatList,value:cashout.fiat_currency || 'CNY'}) +
    fields('银行名称','bank_name',{maxlen:100}) + fields('账户持有人','account_holder',{maxlen:100}) +
    fields('银行账号','account_number',{maxlen:34,autocomplete:'off'}) + fields('国家或地区代码','country_code',{maxlen:2,hint:'两位代码，例如 CN'}),'绑定账户');
  const cryptoBind = onchain ? formPanel('绑定链上账户','bind_withdrawal_account',
    fields('资产','asset_symbol',{values:state.assets.filter(r => r.asset_type === 'crypto').map(a => a.symbol),value:receiving.asset_symbol || 'USDT'}) +
    fields('标签','label',{maxlen:80}) + fields('网络代码','network_code',{value:receiving.network_code || '',maxlen:32}) +
    fields('收款地址','address',{wide:true,maxlen:256}) + fields('备注标签','memo',{wide:true,required:false,maxlen:120}),'绑定地址') : '';
  const bankWithdraw = cashout.enabled && bankAccounts.length ?
    formPanel('申请法币提现','request_fiat_withdrawal',
      fields('绑定账户','account_id',{values:opts(bankAccounts)}) +
      fields('申请数量 · 站内记账单位','amount',{mode:'decimal',hint:'最低 ' + decimal(cashout.minimum) + '，手续费 ' + decimal(cashout.fee)}),
      '提交申请') : section('法币提现',empty(cashout.enabled ? '请先绑定对应币种的银行账户' : '当前法币提现通道未启用'));
  const cryptoWithdraw = onchain && cryptoAccounts.length ? formPanel('申请链上提现','request_bound_withdrawal',
    fields('绑定地址','account_id',{values:opts(cryptoAccounts)}) + fields('申请数量','amount',{mode:'decimal'}),'提交申请') : '';
  const accountList = section('已绑定账户',errorOr(accounts, value => table(['标签','类型','银行／网络','账号尾号','操作'], rows(value).filter(r => r.is_active),r =>
    [e(r.label),e(st(r.account_type)),e(r.bank_name || r.network_code),e(r.account_last4 || '—'),button('解绑','unbind',r.id,'tiny danger')],'暂无已绑定账户')));
  return `<div class="stack"><div class="grid-two">${bankWithdraw}${bankBind}${cryptoWithdraw}${cryptoBind}</div>${accountList}${errorOr(history,v => v)}</div>`;
}

const financeRole = () => ['super_admin','finance'].includes(state.role);
const opsRole = () => ['super_admin','operations'].includes(state.role);
const topRole = () => state.role === 'super_admin';
function adminAccess(page) {
  if (!state.role) return false;
  if (page === 'overview') return true;
  if (page === 'accounts' || page === 'finance') return financeRole();
  if (page === 'catalog') return opsRole();
  if (page === 'settings') return topRole();
  return page === 'audit' && ['super_admin','operations','compliance','support'].includes(state.role);
}

async function renderAdmin() {
  if (!state.session) return hero('管理后台','管理清音交易所业务') + gate('管理员登录');
  if (!state.role) return hero('管理后台','管理员访问控制') + section('访问受限',empty('当前账号未被授予后台角色'));
  const page = current();
  const role = `<span class="pill">${e(st(state.role))}</span>`;
  if (!adminAccess(page)) return hero('管理后台','管理员访问控制',role) + section('访问受限',empty('当前角色无权访问此模块'));
  if (page === 'accounts') return hero('账户管理','查询账户、查看状态与进行合规审核',role) + await adminAccounts();
  if (page === 'finance') return hero('财务管理','审核充提申请并管理站内记账额度',role) + await adminFinance();
  if (page === 'catalog') return hero('资产与市场','配置资产、交易对和交易状态',role) + await adminCatalog();
  if (page === 'settings') return hero('平台设置','配置客服、收款和法币提现通道',role) + adminSettings();
  if (page === 'audit') return hero('审计与风控','查看关键操作与风险记录',role) + await adminAudit();
  return hero('后台概览','清音交易所运营数据',role) + await adminOverview();
}

async function adminOverview() {
  if (!financeRole()) {
    const panels = [];
    if (opsRole()) panels.push('<a class="button" href="/admin#catalog">资产与市场</a>');
    if (adminAccess('audit')) panels.push('<a class="button" href="/admin#audit">查看审计与风控</a>');
    return section('工作台',body(`<div class="actions">${panels.join('')}</div>`));
  }
  const dashboard = await rpc('admin_dashboard');
  const counts = dashboard?.counts || {};
  const metrics = [['用户',counts.users],['订单',counts.orders],['成交',counts.trades],['待处理提现',counts.pending_withdrawals]];
  return `<div class="metrics">${metrics.map(([name,value]) => `<div class="metric"><small>${e(name)}</small><strong>${e(decimal(value))}</strong></div>`).join('')}</div>
  <div class="grid-two">
  ${section('最近账户',table(['邮箱','名称','账户状态','地区审核'],rows(dashboard.users),r => [e(r.email),e(r.display_name || '—'),stateTag(r.account_status),stateTag(r.jurisdiction_status)]))}
  ${section('最近入账',table(['资产','渠道','数量','状态','时间'],rows(dashboard.deposits),r => [e(r.symbol),e(r.network),num(r.amount),stateTag(r.status),date(r.created_at)]))}
  </div>`;
}

async function adminAccounts() {
  const account = state.adminAccount;
  const dashboard = await panelResults([rpc('admin_dashboard')]);
  const query = formPanel('查询账户','find-account',fields('完整邮箱、用户名或 UID','identifier',{wide:true,maxlen:254}),'查询');
  const result = account ? section('账户详情',body(facts([['UID',account.id],['邮箱',account.email],['名称',account.display_name],['用户名',account.username],
    ['账户状态',st(account.account_status)],['可用站内记账额度',decimal(account.available)]]))) : '';
  const review = topRole() ? formPanel('账户审核','admin_review_account',
    fields('用户 UID','user_id',{value:account?.id || '',wide:true,maxlen:36}) +
    fields('账户状态','status',{values:[['active','正常'],['suspended','封禁']],value:account?.account_status}) +
    fields('地区审核状态','jurisdiction',{values:[['approved','通过'],['pending_review','待审核'],['restricted','受限']],value:'pending_review'}) +
    fields('审核依据','reference',{wide:true,maxlen:500}), '确认审核') : '';
  return `<div class="stack"><div class="grid-two">${query}${result}${review}</div>${section('最近 100 个账户',errorOr(dashboard[0],v =>
    table(['邮箱','名称','账户','地区审核','注册时间','操作'],rows(v.users),r => [e(r.email),e(r.display_name || '—'),stateTag(r.account_status),
      stateTag(r.jurisdiction_status),date(r.created_at),button('查看','account-find',r.id,'tiny')])))}</div>`;
}

async function adminFinance() {
  const tab = state.adminTab;
  const tools = tabs([['overview','充值审核'],['withdrawals','提现审核'],['credit','站内记账额度']],tab,'finance-tab');
  let content;
  if (tab === 'withdrawals') {
    const [dashboard] = await panelResults([rpc('admin_dashboard')]);
    content = section('最近 100 笔提现申请',errorOr(dashboard,v => table(
      ['申请人','类型','资产','数量','手续费','法币金额','状态','申请时间','操作'],rows(v.withdrawals),r => [
        e(r.user_id),e(st(r.payout_type)),e(r.symbol),num(r.amount),num(r.fee),e(r.fiat_amount == null ? '—' : decimal(r.fiat_amount) + ' ' + r.fiat_currency),
        stateTag(r.status),date(r.created_at),
        '<div class="actions">' + (r.payout_type === 'fiat' && r.withdrawal_account_id && ['requested','reviewing','approved'].includes(r.status) ?
          button('结算账户','bank-details',r.id,'tiny') : '') + (pendingWithdrawal(r.status) ?
          button('审核','review-withdraw',r.id,'tiny') : '') + (r.status === 'approved' ? button('确认已付款','settle-withdraw',r.id,'tiny') : '') + '</div>'
      ])));
  } else if (tab === 'credit') {
    const adjustments = (title,key,userField) => pagedPanel(title,key,value => table(['用户 UID','数量','依据','时间'],rows(value),r => [e(r[userField]),
      num(r.amount),wrap(r.reason),date(r.created_at)]),pageOffset(key));
    const [credits,deductions] = await panelResults([
      adjustments('增加记录','adminCredit','recipient_user_id'),adjustments('扣减记录','adminDeductions','user_id')
    ]);
    content = `<div class="grid-two">
      ${formPanel('调整用户 USDT 余额','admin_adjust_usdt',
        fields('用户 UID','user_id',{value:state.adminAccount?.id || '',wide:true,maxlen:36}) +
        fields('方向','direction',{values:[['credit','增加 USDT'],['debit','扣减 USDT']]}) +
        fields('数量','amount',{mode:'decimal',hint:'扣减仅从可用余额扣除'}) +
        fields('记账依据','reason',{wide:true,type:'textarea',maxlen:500}),'确认调整')}
      ${formPanel('管理员账户转账','admin_transfer_usdt',
        fields('收款用户 UID','recipient_user_id',{wide:true,maxlen:36}) + fields('数量','amount',{mode:'decimal'}) +
        fields('转账依据','reason',{wide:true,type:'textarea',maxlen:500}),'确认转账')}
    </div>${errorOr(credits,v => v)}${errorOr(deductions,v => v)}`;
  } else {
    const [recharges] = await panelResults([rpc('admin_recharge_queue')]);
    content = section('最近 100 笔充值申请',errorOr(recharges,value => table(
      ['申请人','实付币种','实付金额','记账数量','流水号','状态','时间','操作'],rows(value),r => [
        e(r.email),e(r.fiat_currency || st(r.payment_type)),num(r.paid_amount),num(r.token_amount),e(r.payment_reference),
        stateTag(r.status),date(r.created_at),r.status === 'pending' ? button('审核','review-recharge',r.id,'tiny') : wrap(r.review_note)
      ])));
  }
  return `<div class="stack">${tools}${content}</div>`;
}

async function adminCatalog() {
  const assetStatus = [['active','正常'],['inactive','停用'],['delisted','下架']];
  const marketStatus = [['active','正常'],['inactive','停用'],['halted','暂停']];
  const [assets, markets] = await panelResults([
    pagedPanel('资产列表','adminAssets',v => table(['代码','名称','类别','精度','状态','交易','操作'],rows(v),r =>
      [e(r.symbol),e(r.name),e(st(r.asset_type)),num(r.decimals),stateTag(r.status),e(r.trading_enabled ? '启用' : '停用'),
        button('更改状态','asset-status',[r.symbol,r.status,r.trading_enabled].join('|'),'tiny')]),pageOffset('adminAssets')),
    pagedPanel('交易对列表','adminMarkets',v => table(['交易对','价格精度','数量精度','最小数量','状态','操作'],rows(v),r =>
      [e(r.symbol),num(r.price_precision),num(r.quantity_precision),num(r.min_quantity),stateTag(r.status),
        button('更改状态','market-status',[r.symbol,r.status].join('|'),'tiny')]),pageOffset('adminMarkets'))
  ]);
  state.assetStatus = assetStatus;
  state.marketStatus = marketStatus;
  const choices = state.assets.map(r => r.symbol);
  return `<div class="stack"><div class="grid-two">
    ${formPanel('登记资产','admin_create_asset',
      fields('资产代码','symbol',{maxlen:30}) + fields('名称','name',{maxlen:100}) +
      fields('类型','asset_type',{values:[['crypto','数字资产'],['fiat','法币']]}) +
      fields('小数精度','decimals',{type:'number',value:8,min:0,max:18}) +
      fields('网络代码','network_code',{required:false,maxlen:32}) + fields('网络名称','network_name',{required:false,maxlen:100}) +
      fields('合约地址','contract_address',{wide:true,required:false,maxlen:256}), '登记资产')}
    ${formPanel('创建交易对','admin_create_market',
      fields('基础资产','base_asset_symbol',{values:choices,value:'BTC'}) + fields('计价资产','quote_asset_symbol',{values:choices,value:'USDT'}) +
      fields('价格精度','price_precision',{type:'number',value:8,min:0,max:18}) +
      fields('数量精度','quantity_precision',{type:'number',value:8,min:0,max:18}) +
      fields('最低数量','min_quantity',{mode:'decimal',value:0}), '创建市场')}
  </div>${errorOr(assets,v => v)}${errorOr(markets,v => v)}</div>`;
}

function adminSettings() {
  const cust = state.settings.customer_service || {};
  const dep = state.settings.deposit_receiving || {};
  const cash = state.settings.fiat_cashout || {};
  const pay = state.settings.payment_receiving || {};
  return `<div class="grid-two">
    ${formPanel('法币收款','payment-settings',
      fields('法币','fiat_currency',{values:fiatList,value:pay.fiat_currency}) + fields('每 1 记账单位的法币金额','rate',{mode:'decimal',value:decimal(pay.rate) === '—' ? '' : decimal(pay.rate),required:false}) +
      fields('收款人','receiver_name',{value:pay.receiver_name,required:false,maxlen:100}) + fields('银行名称','bank_name',{value:pay.bank_name,required:false,maxlen:100}) +
      fields('收款账号','account_number',{value:pay.account_number,required:false,maxlen:34}) +
      fields('二维码图像 URL','qr_image_url',{type:'url',value:pay.qr_image_url,required:false,maxlen:1000}) +
      fields('支付码内容','qr_payload',{value:pay.qr_payload,wide:true,required:false,maxlen:2000}) +
      fields('支付说明','instructions',{type:'textarea',value:pay.instructions,wide:true,required:false,maxlen:1000}) +
      check('启用法币收款','enabled',pay.enabled),'保存法币收款')}
    <div class="stack">
    ${formPanel('法币提现参数','admin_set_fiat_cashout',
      fields('法币','currency',{values:fiatList,value:cash.fiat_currency}) + fields('每 1 记账单位的法币金额','rate',{mode:'decimal',value:cash.rate ?? ''}) +
      fields('手续费','fee',{mode:'decimal',value:cash.fee ?? 0}) + fields('最低申请数量','minimum',{mode:'decimal',value:cash.minimum ?? 10}) +
      check('启用法币提现','enabled',cash.enabled),'保存提现参数')}
    ${formPanel('在线客服','admin_set_customer_service',
      fields('按钮文字','label',{value:cust.label || '联系客服',maxlen:30}) +
      fields('客服地址','url',{value:cust.url,required:false,maxlen:1000,hint:'支持 HTTPS 链接、mailto:邮箱或 tel:电话'}) +
      check('启用客服链接','enabled',cust.enabled),'保存客服设置')}
    </div>
    ${formPanel('链上收款配置','admin_set_deposit_receiving',
      fields('资产','asset_symbol',{value:dep.asset_symbol || 'USDT',maxlen:30}) + fields('网络代码','network_code',{value:dep.network_code,required:false,maxlen:32}) +
      fields('网络名称','network_name',{value:dep.network_name,required:false,maxlen:100}) + fields('地址','address',{value:dep.address,required:false,maxlen:256}) +
      fields('备注标签','memo',{value:dep.memo,required:false,maxlen:120}) +
      fields('说明','instructions',{type:'textarea',value:dep.instructions,wide:true,required:false,maxlen:1000}) +
      check('启用链上收款配置','enabled',dep.enabled),'保存链上配置')}
  </div>`;
}

async function adminAudit() {
  const items = [
    pagedPanel('风险标记','adminRisk',v => table(['用户','对象','等级','原因','状态','时间'],rows(v),r =>
      [e(r.user_id),e(r.subject_type),e(r.severity),wrap(r.reason),stateTag(r.status),date(r.created_at)]),pageOffset('adminRisk')),
    pagedPanel('订单记录','adminOrders',v => ordersView(v,true),pageOffset('adminOrders')),
    pagedPanel('身份审核记录','adminKyc',v => table(['用户','服务商','级别','状态','时间'],rows(v),r =>
      [e(r.user_id),e(r.provider),e(r.level),stateTag(r.status),date(r.created_at)]),pageOffset('adminKyc'))
  ];
  if (state.role !== 'support') items.unshift(pagedPanel('操作日志','adminAudit',v => table(['操作','资源','编号','时间'],rows(v),r =>
    [e(r.action),e(r.resource_type),e(r.resource_id),date(r.created_at)]),pageOffset('adminAudit')));
  return `<div class="stack">${(await panelResults(items)).map(r => errorOr(r,v => v)).join('')}</div>`;
}

function reviewModal(kind, id) {
  const withdraw = kind === 'withdraw';
  renderModal(withdraw ? '审核提现' : '审核充值',
    form(withdraw ? 'admin_review_withdrawal' : 'admin_review_recharge',
      hidden(withdraw ? 'withdrawal_id' : 'recharge_id', id) +
      fields('审核决定','decision',{values:[['','请选择'],['approved','通过'],['rejected','拒绝']]}) +
      fields('核实或拒绝理由','reason',{type:'textarea',maxlen:1000,hint:'请填写 3–1000 字'}),
      '提交审核',{single:true}));
}

const mutationLabels = {
  submit_limit_order:'委托已提交', cancel_order:'撤单请求已处理', transfer_asset:'转账已完成',
  bind_bank_account:'银行账户已绑定', bind_withdrawal_account:'链上地址已绑定', unbind_withdrawal_account:'账户已解绑',
  request_bound_withdrawal:'提现申请已提交', request_fiat_withdrawal:'法币提现申请已提交', cancel_withdrawal:'提现申请已取消',
  submit_recharge:'付款核实申请已提交', mark_notifications_read:'通知已标记为已读',
  admin_review_account:'账户审核已保存', admin_review_recharge:'充值审核已保存', admin_review_withdrawal:'提现审核已保存',
  admin_complete_withdrawal:'提现付款已确认',
  admin_allocate_internal_credit:'记账额度已分配', admin_transfer_usdt:'管理员转账已完成',
  admin_adjust_usdt:'用户 USDT 余额已调整',
  admin_create_asset:'资产已登记', admin_set_asset_status:'资产状态已保存', admin_create_market:'交易对已创建',
  admin_set_market_status:'交易对状态已保存', admin_set_customer_service:'客服设置已保存',
  admin_set_deposit_receiving:'链上配置已保存', admin_set_fiat_cashout:'法币提现设置已保存', admin_set_payment_receiving:'法币收款设置已保存'
};
const confirmBefore = new Set([
  'transfer_asset','request_bound_withdrawal','request_fiat_withdrawal','admin_allocate_internal_credit','admin_adjust_usdt','admin_transfer_usdt',
  'admin_review_account','admin_review_recharge','admin_review_withdrawal','admin_complete_withdrawal','admin_set_asset_status','admin_set_market_status',
  'admin_set_payment_receiving','admin_set_fiat_cashout','admin_set_deposit_receiving'
]);
const catalogMutations = new Set(['admin_create_asset','admin_set_asset_status','admin_create_market','admin_set_market_status',
  'admin_set_customer_service','admin_set_deposit_receiving','admin_set_fiat_cashout','admin_set_payment_receiving']);
const numericFields = new Set(['amount','quantity','price','min_quantity','rate','fee','minimum','decimals','price_precision','quantity_precision']);
const decimalPattern = /^\d+(?:\.\d+)?$/;
function normalizePayload(node) {
  const inputs = new FormData(node);
  const payload = Object.fromEntries([...inputs].map(([k,v]) => [k,String(v).trim()]));
  for (const input of node.querySelectorAll('input[type=checkbox]')) payload[input.name] = input.checked;
  for (const [field,value] of Object.entries(payload)) {
    if (!numericFields.has(field)) continue;
    if (value === '' && !node.elements[field].required) continue;
    if (!decimalPattern.test(amountValue(value))) {
      throw new Error('请填写有效数字，支持十进制小数。');
    }
    if (node.elements[field].type === 'number') payload[field] = Number(value);
  }
  return payload;
}

async function processForm(node) {
  const name = node.dataset.form;
  if (name === 'login' || name === 'signup') {
    const input = new FormData(node);
    const result = await rawApi('auth/' + name, {email:String(input.get('email')).trim(),password:input.get('password')});
    if (result.confirmationRequired) {
      const info = $('.form-status', node);
      info.textContent = '请查收验证邮件。完成验证后，在此使用邮箱和密码登录。';
      return;
    }
    useSession(result);
    requestKeys.clear();
    modal.close();
    await render();
    void refreshUnread();
    return;
  }
  const payload = normalizePayload(node);
  if (name === 'edit-profile') {
    await api('profile',payload);
    await render();
    showNotice('账户资料已保存');
    return;
  }
  if (name === 'find-account') {
    state.adminAccount = await rpc('admin_find_account', payload);
    await render();
    return;
  }
  const nameToCall = name === 'payment-settings' ? 'admin_set_payment_receiving' : name;
  if (confirmBefore.has(nameToCall)) {
    const detail = nameToCall === 'admin_adjust_usdt' ? `\n用户 ${payload.user_id}\n${payload.direction === 'credit' ? '增加' : '扣减'} ${payload.amount} USDT` :
      payload.amount ? '\n数量：' + payload.amount : payload.decision ? '\n审核决定：' + st(payload.decision) : '';
    if (!window.confirm('确认执行此操作？' + detail)) return;
  }
  const args = name === 'payment-settings' ? {config:{...payload,payment_type:'fiat'}} : payload;
  await performMutation(nameToCall, args);
}

async function performMutation(name, payload = {}) {
  const result = await mutation(name,payload);
  if (result === false) throw new Error('当前记录无法执行此操作，请刷新后查看状态。');
  if (modal.open) modal.close();
  if (catalogMutations.has(name)) await refreshCatalog();
  await render();
  void refreshUnread();
  showNotice(mutationLabels[name] || '操作已完成');
}

async function render() {
  const revision = ++state.revision;
  ++state.marketRevision;
  stopReferenceStream();
  if (!state.sessionReady) return;
  renderNav();
  main.setAttribute('aria-busy','true');
  let contents;
  const page = current();
  try {
    if (isAdminPage()) contents = await renderAdmin();
    else if (page === 'wallet') contents = await renderWallet();
    else if (page === 'orders') contents = await renderOrders();
    else if (page === 'inbox') contents = await renderInbox();
    else contents = tradeShell();
  } catch (error) {
    contents = section('加载失败',errorBlock(error),button('重试','retry','','tiny'));
  }
  if (revision !== state.revision) return;
  main.innerHTML = contents;
  main.setAttribute('aria-busy','false');
  if (page === 'trade' && !isAdminPage()) void loadMarket();
}

document.addEventListener('input', event => {
  if (event.target.id === 'market-search') {
    state.filter = event.target.value;
    $('#market-list').innerHTML = marketList();
  }
});

document.addEventListener('submit', async event => {
  const node = event.target.closest('[data-form]');
  if (!node) return;
  event.preventDefault();
  const control = $('button[type=submit]',node);
  if (control.disabled) return;
  const status = $('.form-status',node);
  control.disabled = true;
  status.textContent = '';
  status.classList.remove('error');
  try {
    await processForm(node);
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    control.disabled = false;
  }
});

document.addEventListener('click', async event => {
  const control = event.target.closest('button[data-action]');
  if (!control) return;
  const {action,value} = control.dataset;
  if (control.disabled) return;
  control.disabled = true;
  try {
    if (action === 'close') modal.close();
    else if (action === 'service') {
      const settings = await data('settings');
      state.settings = Object.fromEntries(settings.map(row => [row.key,row.value]));
      renderNav();
      const service = state.settings.customer_service;
      const url = service?.enabled && customerLink(service.url);
      if (url) renderModal('联系客服',`<a class="button primary" href="${e(url)}" rel="noopener noreferrer"${safeHttps(url) ? ' target="_blank"' : ''}>${e(service.label || '联系客服')}</a>`);
      else showNotice('客服联系方式尚未在后台启用。');
    } else if (action === 'notifications') {
      const permission = await Notification.requestPermission();
      showNotice(permission === 'granted' ? '已开启桌面提醒' : '站内提醒仍可使用');
      await render();
    }
    else if (action === 'login' || action === 'signup') showAuth(action === 'signup');
    else if (action === 'logout') {
      await rawApi('auth/logout',{});
      useSession({user:null});
      state.adminAccount = null;
      requestKeys.clear();
      await render();
    } else if (action === 'market' || action === 'interval' || action === 'trade-tab' || action === 'quote-source') {
      state[{market:'market',interval:'interval','trade-tab':'tradeTab','quote-source':'quoteSource'}[action]] = value;
      if (state.quoteSource === 'exchange' && state.interval === '1s') state.interval = '1m';
      await render();
    } else if (action === 'wallet-tab' || action === 'finance-tab') {
      state[action === 'wallet-tab' ? 'walletTab' : 'adminTab'] = value;
      await render();
    } else if (action === 'page') {
      const [name,offset] = value.split('|');
      offsets[name] = Math.max(0,Number(offset));
      await render();
    } else if (action === 'retry' || action === 'refresh-market') {
      await refreshCatalog();
      await render();
    } else if (action === 'read-all') await performMutation('mark_notifications_read');
    else if (action === 'cancel-order' && confirm('确认撤销这笔委托？')) await performMutation('cancel_order',{order_id:value});
    else if (action === 'cancel-withdrawal' && confirm('确认取消这笔提现申请？')) await performMutation('cancel_withdrawal',{withdrawal_id:value});
    else if (action === 'unbind' && confirm('确认解绑这个账户？')) await performMutation('unbind_withdrawal_account',{account_id:value});
    else if (action === 'account-find') {
      state.adminAccount = await rpc('admin_find_account',{identifier:value});
      await render();
    } else if (action === 'review-recharge' || action === 'review-withdraw') {
      reviewModal(action === 'review-withdraw' ? 'withdraw' : 'recharge',value);
    } else if (action === 'settle-withdraw') {
      renderModal('确认提现已付款',form('admin_complete_withdrawal',hidden('withdrawal_id',value) +
        fields('付款流水号或交易哈希','payment_reference',{maxlen:128,hint:'在外部付款已经核实后填写。提交后结算冻结余额。'}),'确认已付款',{single:true}));
    } else if (action === 'bank-details') {
      if (!confirm('查看完整结算资料会记录审计日志，确认继续？')) return;
      const result = await rpc('admin_reveal_withdrawal_bank',{withdrawal_id:value});
      renderModal('银行结算账户',facts([['银行',result.bank_name],['账户持有人',result.account_holder],
        ['账号',result.account_number],['国家或地区',result.country_code],['法币',result.fiat_currency || result.currency]]));
    } else if (action === 'asset-status' || action === 'market-status') {
      const [symbol,status,enabled] = value.split('|');
      const isAsset = action === 'asset-status';
      renderModal(isAsset ? '修改资产状态' : '修改市场状态', form(isAsset ? 'admin_set_asset_status' : 'admin_set_market_status',
        fields(isAsset ? '资产' : '交易对','symbol',{value:symbol,readonly:true}) +
        fields('状态','status',{values:isAsset ? state.assetStatus : state.marketStatus,value:status}) +
        (isAsset ? check('允许交易','trading_enabled',enabled === 'true') : ''),'保存状态',{single:true}));
    }
  } catch (error) {
    showNotice(error.message);
  } finally {
    control.disabled = false;
  }
});

modal.addEventListener('close', () => {
  modal.replaceChildren();
});
window.addEventListener('hashchange', () => { void render(); });

setInterval(() => {
  if (!document.hidden && !isAdminPage() && current() === 'trade' && state.quoteSource === 'reference' && !activeMarketLoad && Date.now() - lastCandleEvent > 6500) {
    void loadMarket({chartOnly:true});
  }
},10_000);
setInterval(() => { void refreshUnread(); },5000);
window.addEventListener('focus',() => { void refreshUnread(); });

async function boot() {
  try {
    await Promise.all([
      refreshCatalog(),
      rawApi('auth/session').then(result => {
        if (result.canRefresh) return refreshSession();
        return useSession(result);
      }).catch(error => { showNotice(error.message); })
    ]);
  } finally {
    state.sessionReady = true;
    await render();
    void refreshUnread();
  }
}
void boot();
