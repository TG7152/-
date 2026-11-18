alter table public.ledger_accounts drop constraint ledger_accounts_account_code_check;
alter table public.ledger_accounts add constraint ledger_accounts_account_code_check check (
  account_code in ('available','locked','fee_revenue','hot_wallet','cold_wallet','clearing','contract_available','contract_locked')
);

create table public.trading_account_transfers (
  user_id uuid not null references auth.users(id),
  request_id uuid not null,
  direction text not null check (direction in ('spot_to_contract','contract_to_spot')),
  amount numeric not null check (amount > 0 and amount = round(amount,6)),
  ledger_transaction_id uuid not null references public.ledger_transactions(id),
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
alter table public.trading_account_transfers enable row level security;
revoke all on public.trading_account_transfers from public,anon,authenticated;
grant select on public.trading_account_transfers to authenticated;
create policy own_trading_transfers on public.trading_account_transfers for select to authenticated
using (user_id=(select auth.uid()));
create index trading_account_transfers_history on public.trading_account_transfers(user_id,created_at desc,request_id desc);

create function app_private.usdt_wallet_amount(p_account uuid)
returns numeric language sql stable security invoker set search_path='' as $$
  select coalesce(sum(case when le.side='credit' then le.amount else -le.amount end),0)
  from public.ledger_entries le join public.ledger_transactions lt on lt.id=le.transaction_id
  where le.account_id=p_account and lt.status='posted'
$$;

create function qingyin_admin.move_trading_usdt(p_direction text,p_amount numeric,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  member uuid := auth.uid();
  asset uuid;
  source_id uuid;
  target_id uuid;
  receipt public.trading_account_transfers%rowtype;
  tx uuid;
begin
  if member is null then raise exception '请先登录' using errcode='42501'; end if;
  if p_direction is null or p_direction not in ('spot_to_contract','contract_to_spot') or p_request_id is null
    or p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity')
    or p_amount<=0 or p_amount>1000000000000 or p_amount<>round(p_amount,6) then
    raise exception '划转方向或金额无效，金额最多 6 位小数';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('trading-usdt:'||member::text||':'||p_request_id::text,0));
  select * into receipt from public.trading_account_transfers where user_id=member and request_id=p_request_id;
  if found then
    if receipt.direction<>p_direction or receipt.amount<>p_amount then raise exception '该编号已用于另一笔划转'; end if;
    return receipt.ledger_transaction_id;
  end if;
  if not exists(select 1 from public.profiles where id=member and account_status='active') then
    raise exception '当前账户无法划转';
  end if;
  select id into asset from public.assets where symbol='USDT' and status='active';
  if asset is null then raise exception 'USDT 当前不可用'; end if;
  perform app_private.provision_user_wallets(member);
  insert into public.ledger_accounts(owner_user_id,asset_id,account_code)
    values(member,asset,'contract_available'),(member,asset,'contract_locked')
    on conflict(owner_user_id,asset_id,account_code) do nothing;
  select id into source_id from public.ledger_accounts where owner_user_id=member and asset_id=asset and
    account_code=case when p_direction='spot_to_contract' then 'available' else 'contract_available' end;
  select id into target_id from public.ledger_accounts where owner_user_id=member and asset_id=asset and
    account_code=case when p_direction='spot_to_contract' then 'contract_available' else 'available' end;
  if source_id is null or target_id is null then raise exception '钱包未初始化'; end if;
  perform 1 from public.ledger_accounts where id in(source_id,target_id) order by id for update;
  if app_private.usdt_wallet_amount(source_id)<p_amount then raise exception '转出账户可用 USDT 余额不足'; end if;
  tx:=app_private.post_ledger('trading_account_transfer',p_request_id::text,'trading-transfer:'||member::text||':'||p_request_id::text,
    case when p_direction='spot_to_contract' then '从现货划转至合约' else '从合约划转至现货' end,
    jsonb_build_array(jsonb_build_object('account_id',source_id,'side','debit','amount',p_amount),
      jsonb_build_object('account_id',target_id,'side','credit','amount',p_amount)));
  insert into public.trading_account_transfers(user_id,request_id,direction,amount,ledger_transaction_id)
    values(member,p_request_id,p_direction,p_amount,tx);
  insert into public.user_notifications(user_id,kind,title,body,resource_id)
    values(member,'trading_account_transfer','USDT 划转已完成',
      (case when p_direction='spot_to_contract' then '现货 → 合约' else '合约 → 现货' end)||' · '||p_amount::text||' USDT',tx);
  return tx;
end
$$;

create function public.transfer_trading_usdt(p_direction text,p_amount numeric,p_request_id uuid)
returns uuid language sql security invoker set search_path='' as $$
  select qingyin_admin.move_trading_usdt(p_direction,p_amount,p_request_id)
$$;

create function public.get_trading_usdt_balances()
returns table(spot_available numeric,spot_locked numeric,contract_available numeric,contract_locked numeric)
language sql stable security invoker set search_path='' as $$
  select
    coalesce(max(b.value) filter (where b.account_code='available'),0),
    coalesce(max(b.value) filter (where b.account_code='locked'),0),
    coalesce(max(b.value) filter (where b.account_code='contract_available'),0),
    coalesce(max(b.value) filter (where b.account_code='contract_locked'),0)
  from (
    select la.account_code,app_private.usdt_wallet_amount(la.id) as value
    from public.ledger_accounts la join public.assets a on a.id=la.asset_id
    where la.owner_user_id=(select auth.uid()) and a.symbol='USDT'
  ) b
$$;

revoke all on function app_private.usdt_wallet_amount(uuid),qingyin_admin.move_trading_usdt(text,numeric,uuid),
  public.transfer_trading_usdt(text,numeric,uuid),public.get_trading_usdt_balances() from public,anon,authenticated;
grant execute on function app_private.usdt_wallet_amount(uuid),qingyin_admin.move_trading_usdt(text,numeric,uuid),
  public.transfer_trading_usdt(text,numeric,uuid),public.get_trading_usdt_balances() to authenticated;
