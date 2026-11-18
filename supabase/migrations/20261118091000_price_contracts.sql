create table app_private.contract_marks (
  market_id uuid primary key references public.markets(id),
  price numeric not null check (price > 0 and price <= 1000000000000),
  observed_at timestamptz not null
);
create table public.contract_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  market_id uuid not null references public.markets(id),
  asset_id uuid not null references public.assets(id),
  side text not null check (side in ('long','short')),
  leverage smallint not null check (leverage between 1 and 100),
  margin numeric not null check (margin >= 1),
  quantity numeric not null check (quantity > 0),
  entry_price numeric not null check (entry_price > 0),
  state text not null default 'open' check (state in ('open','closed','liquidated')),
  realized_pnl numeric,
  exit_price numeric,
  request_id uuid not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  unique(user_id,request_id)
);
alter table public.contract_positions enable row level security;
revoke all on public.contract_positions from public,anon,authenticated;
grant select on public.contract_positions to authenticated;
create policy own_contract_positions on public.contract_positions for select to authenticated using(user_id=(select auth.uid()));
create index open_contract_positions on public.contract_positions(market_id,id) where state='open';
create index user_contract_positions on public.contract_positions(user_id,opened_at desc,id desc);

create function app_private.contract_pnl(p_side text,p_entry numeric,p_exit numeric,p_qty numeric)
returns numeric language sql immutable strict set search_path='' as $$
  select round((p_exit-p_entry)*p_qty*(case when p_side='long' then 1 else -1 end),6)
$$;

create function app_private.settle_usdt_contract(p_id uuid,p_price numeric,p_state text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  pos public.contract_positions%rowtype;
  available_id uuid;
  locked_id uuid;
  clearing_id uuid;
  pnl numeric;
  payout numeric;
  lines jsonb;
begin
  select * into pos from public.contract_positions where id=p_id for update;
  if not found or pos.state<>'open' then return false; end if;
  pnl:=greatest(-pos.margin,app_private.contract_pnl(pos.side,pos.entry_price,p_price,pos.quantity));
  payout:=pos.margin+pnl;
  select id into available_id from public.ledger_accounts where owner_user_id=pos.user_id and asset_id=pos.asset_id and account_code='contract_available';
  select id into locked_id from public.ledger_accounts where owner_user_id=pos.user_id and asset_id=pos.asset_id and account_code='contract_locked';
  insert into public.ledger_accounts(owner_user_id,asset_id,account_code) values(null,pos.asset_id,'clearing')
    on conflict(owner_user_id,asset_id,account_code) do nothing;
  select id into clearing_id from public.ledger_accounts where owner_user_id is null and asset_id=pos.asset_id and account_code='clearing';
  perform 1 from public.ledger_accounts where id in(available_id,locked_id,clearing_id) order by id for update;
  if app_private.usdt_wallet_amount(locked_id)<pos.margin then raise exception '合约保证金不一致'; end if;
  lines:=jsonb_build_array(jsonb_build_object('account_id',locked_id,'side','debit','amount',pos.margin));
  if payout>0 then
    lines:=lines||jsonb_build_array(jsonb_build_object('account_id',available_id,'side','credit','amount',payout));
  end if;
  if pnl<>0 then
    lines:=lines||jsonb_build_array(jsonb_build_object('account_id',clearing_id,'side',case when pnl>0 then 'debit' else 'credit' end,'amount',abs(pnl)));
  end if;
  perform app_private.post_ledger('contract_settlement',pos.id::text,'contract-settlement:'||pos.id::text,'合约盈亏结算',lines);
  update public.contract_positions set state=p_state,realized_pnl=pnl,exit_price=p_price,closed_at=now() where id=pos.id;
  insert into public.user_notifications(user_id,kind,title,body,resource_id)
    values(pos.user_id,'contract_'||p_state,case when p_state='liquidated' then '合约已强平' else '合约已平仓' end,
      '已实现盈亏 '||pnl::text||' USDT · 已结算至合约可用余额',pos.id);
  return true;
end
$$;

create function qingyin_admin.open_usdt_contract(p_market_symbol text,p_side text,p_leverage integer,p_margin numeric,p_expected_price numeric,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  member uuid := auth.uid();
  market uuid;
  asset uuid;
  mark numeric;
  available_id uuid;
  locked_id uuid;
  pos public.contract_positions%rowtype;
  result uuid;
begin
  if member is null then raise exception '请先登录' using errcode='42501'; end if;
  if p_side is null or p_side not in ('long','short') or p_leverage is null or p_leverage not between 1 and 100 or
    p_margin is null or p_margin::text in ('NaN','Infinity','-Infinity') or p_margin<1 or p_margin>1000000000 or p_margin<>round(p_margin,6)
    or p_expected_price is null or p_expected_price::text in ('NaN','Infinity','-Infinity') or p_expected_price<=0 or p_request_id is null then
    raise exception '请提供有效的金额、价格和 1–100 倍杠杆';
  end if;
  if not exists(select 1 from public.profiles where id=member and account_status='active' and jurisdiction_status='approved') then
    raise exception '账户须通过地区审核后才可开仓';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('contract-open:'||member::text||':'||p_request_id::text,0));
  select m.id,q.id into market,asset from public.markets m join public.assets q on q.id=m.quote_asset_id
    join public.assets b on b.id=m.base_asset_id
    where m.symbol=upper(btrim(p_market_symbol)) and m.status='active' and q.symbol='USDT'
    and q.status='active' and b.status='active' and q.trading_enabled and b.trading_enabled;
  if market is null then raise exception '该交易对当前不可开仓'; end if;
  select * into pos from public.contract_positions where user_id=member and request_id=p_request_id;
  if found then
    if pos.market_id<>market or pos.side<>p_side or pos.leverage<>p_leverage or pos.margin<>p_margin then raise exception '请求编号已用于另一笔开仓'; end if;
    return pos.id;
  end if;
  select price into mark from app_private.contract_marks where market_id=market and observed_at>=now()-interval '20 seconds';
  if mark is null then raise exception '实时结算价格暂不可用，请稍后重试'; end if;
  if abs(mark-p_expected_price)/p_expected_price>0.005 then raise exception '价格已变动超过 0.5%%，请刷新报价后重新确认'; end if;
  select id into available_id from public.ledger_accounts where owner_user_id=member and asset_id=asset and account_code='contract_available';
  select id into locked_id from public.ledger_accounts where owner_user_id=member and asset_id=asset and account_code='contract_locked';
  if available_id is null or locked_id is null then raise exception '请先划转 USDT 至合约账户'; end if;
  perform 1 from public.ledger_accounts where id in(available_id,locked_id) order by id for update;
  if app_private.usdt_wallet_amount(available_id)<p_margin then raise exception '合约可用 USDT 不足'; end if;
  insert into public.contract_positions(user_id,market_id,asset_id,side,leverage,margin,quantity,entry_price,request_id)
    values(member,market,asset,p_side,p_leverage,p_margin,round(p_margin*p_leverage/mark,12),mark,p_request_id) returning id into result;
  perform app_private.post_ledger('contract_margin',result::text,'contract-margin:'||result::text,'冻结合约保证金',
    jsonb_build_array(jsonb_build_object('account_id',available_id,'side','debit','amount',p_margin),
      jsonb_build_object('account_id',locked_id,'side','credit','amount',p_margin)));
  insert into public.user_notifications(user_id,kind,title,body,resource_id)
    values(member,'contract_open','合约已开仓',upper(btrim(p_market_symbol))||' · '||p_leverage::text||'×',result);
  return result;
end
$$;

create function qingyin_admin.close_usdt_contract(p_position_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare pos public.contract_positions%rowtype; mark numeric; liquidated boolean;
begin
  if auth.uid() is null then raise exception '请先登录' using errcode='42501'; end if;
  select * into pos from public.contract_positions where id=p_position_id and user_id=auth.uid() for update;
  if not found then raise exception '合约仓位不存在'; end if;
  if pos.state<>'open' then return true; end if;
  select price into mark from app_private.contract_marks where market_id=pos.market_id and observed_at>=now()-interval '20 seconds';
  if mark is null then raise exception '实时结算价格暂不可用，请稍后重试'; end if;
  liquidated:=pos.margin+app_private.contract_pnl(pos.side,pos.entry_price,mark,pos.quantity)<=mark*pos.quantity*0.005;
  return app_private.settle_usdt_contract(pos.id,mark,case when liquidated then 'liquidated' else 'closed' end);
end
$$;

create function public.open_usdt_contract(p_market_symbol text,p_side text,p_leverage integer,p_margin numeric,p_expected_price numeric,p_request_id uuid)
returns uuid language sql security invoker set search_path='' as $$
  select qingyin_admin.open_usdt_contract(p_market_symbol,p_side,p_leverage,p_margin,p_expected_price,p_request_id)
$$;
create function public.close_usdt_contract(p_position_id uuid)
returns boolean language sql security invoker set search_path='' as $$
  select qingyin_admin.close_usdt_contract(p_position_id)
$$;
create function public.get_contract_marks()
returns table(market_id uuid,price numeric,observed_at timestamptz)
language sql stable security invoker set search_path='' as $$
  select m.market_id,m.price,m.observed_at from app_private.contract_marks m
  where m.observed_at>=now()-interval '20 seconds'
$$;

revoke all on app_private.contract_marks from public,anon,authenticated;
grant select on app_private.contract_marks to authenticated;
revoke all on function app_private.contract_pnl(text,numeric,numeric,numeric),app_private.settle_usdt_contract(uuid,numeric,text),
  qingyin_admin.open_usdt_contract(text,text,integer,numeric,numeric,uuid),qingyin_admin.close_usdt_contract(uuid),
  public.open_usdt_contract(text,text,integer,numeric,numeric,uuid),public.close_usdt_contract(uuid),public.get_contract_marks()
  from public,anon,authenticated;
grant execute on function qingyin_admin.open_usdt_contract(text,text,integer,numeric,numeric,uuid),qingyin_admin.close_usdt_contract(uuid),
  public.open_usdt_contract(text,text,integer,numeric,numeric,uuid),public.close_usdt_contract(uuid),public.get_contract_marks() to authenticated;
