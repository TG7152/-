import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';

const file = readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
async function windowFixture(pathname, hash, currentUser) {
  const nodes = Object.fromEntries(['#main','#modal','#nav','#account','#footer-content','#notice','#chart','#chart-price','#chart-metrics','#chart-info','#market-depth'].map(id => [id, {
    innerHTML:'', setAttribute(){}, addEventListener(){}, textContent:''
  }]));
  const market = {id:'btc', symbol:'BTC/USDT', base_asset:'BTC', quote_asset:'USDT', price_precision:8, quantity_precision:8, min_quantity:'0.01',status:'active'};
  const linkedData = {
    'data/markets':[market,{id:'btc-usdc',symbol:'BTC/USDC',base_asset:'BTC',quote_asset:'USDC',status:'inactive'}],
    'data/assets':[],
    'data/tickers':[],
    'data/settings':[{key:'spot_trading_enabled',value:true},{key:'balance_model',value:{type:'internal_credit'}},
      {key:'customer_service',value:{enabled:true,label:'联系客服',url:'mailto:support@example.test'}}],
    'auth/session':currentUser,
    'rpc/get_public_candles':[{open:90,close:100,high:105,low:85,open_time:'2026-11-17T15:00:00Z'}],
    'data/marketQuote':{source:'Binance',candles:[{open:90,close:100,high:105,low:85,open_time:'2026-11-17T15:00:00Z'}],
      ticker:{last_price:'100.25',price_change_pct:'0.63',updated_at:'2026-11-17T15:00:00Z'}},
    'rpc/get_public_order_book':[{side:'buy',price:'96.123456789',quantity:'1'}],
    'data/balances':[{symbol:'USDT',available_balance:'100.75',locked_balance:'0'}],
    'rpc/get_trading_usdt_balances':[{spot_available:'75',spot_locked:'0',contract_available:'20',contract_locked:'5'}],
    'rpc/get_contract_marks':[{market_id:'btc',price:'100.12',observed_at:'2026-11-17T15:00:00Z'}],
    'data/contractPositions':[{id:'pos',market_id:'btc',side:'long',margin:5,leverage:100,entry_price:100,quantity:5,state:'open'}],
    'rpc/admin_dashboard':{counts:{users:1,orders:0,trades:0,pending_withdrawals:0},users:[],deposits:[]},
    'rpc/admin_recharge_queue':[{email:'buyer@example.com',status:'pending',paid_amount:'100'}],
  };
  const location = {pathname,hash};
  const context = {
    document:{querySelector:selector => nodes[selector],addEventListener(){}},location,
    window:{addEventListener(){}}, URL, URLSearchParams, clearTimeout, setTimeout,setInterval(){},
    fetch:async path => new Response(JSON.stringify(linkedData[path.slice(5).split('?')[0]] ?? []))
  };
  await runInNewContext(file.replace('void boot();','boot();'),context);
  await new Promise(resolve => setImmediate(resolve));
  return nodes;
}
const guest = await windowFixture('/', '#trade', {user:null});
assert.match(guest['#main'].innerHTML,/BTC\/USDT/);
assert.doesNotMatch(guest['#main'].innerHTML,/BTC\/USDC/);
assert.match(guest['#main'].innerHTML,/登录交易/);
assert.match(guest['#chart'].innerHTML,/价格 K 线图/);
assert.match(guest['#chart-price'].innerHTML,/100\.25/);
assert.match(guest['#chart-info'].textContent,/参考行情/);
assert.doesNotMatch(guest['#chart-info'].textContent + guest['#main'].innerHTML,/Binance/);
assert.match(guest['#account'].innerHTML,/href="mailto:support@example.test"/);
assert.match(guest['#market-depth'].innerHTML,/96\.123456789/);
const member = await windowFixture('/', '#wallet', {user:{email:'buyer@example.com'}});
assert.match(member['#main'].innerHTML,/100\.75/);
const contracts = await windowFixture('/', '#contracts', {user:{email:'buyer@example.com'}});
assert.match(contracts['#main'].innerHTML,/name="leverage"[^>]*max="100"/);
assert.match(contracts['#main'].innerHTML,/现货账户/);
assert.match(contracts['#main'].innerHTML,/合约账户/);
assert.match(contracts['#main'].innerHTML,/0\.6/);
const locked = await windowFixture('/admin','#overview',{user:{email:'buyer@example.com'},role:null});
assert.match(locked['#main'].innerHTML,/没有|未被授予后台角色/);
const staff = await windowFixture('/admin','#finance',{user:{email:'admin@example.com'},role:'super_admin'});
assert.match(staff['#main'].innerHTML,/buyer@example\.com/);
assert.match(staff['#main'].innerHTML,/data-action="review-recharge"/);
console.log('Frontend rendering checks passed for trade, wallet, admin role gate and recharge queue.');
