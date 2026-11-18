create table public.usdt_deductions (
  request_id uuid primary key,
  actor_user_id uuid not null references auth.users(id),
  user_id uuid not null references auth.users(id),
  amount numeric not null check (amount > 0 and amount <= 1000000000000 and amount = round(amount,6)),
  reason text not null check (length(reason) between 1 and 500),
  ledger_transaction_id uuid references public.ledger_transactions(id),
  created_at timestamptz not null default now()
);
alter table public.usdt_deductions enable row level security;
revoke all on public.usdt_deductions from public, anon, authenticated;
grant select on public.usdt_deductions to authenticated;
create policy finance_read_usdt_deductions on public.usdt_deductions for select to authenticated
using (exists (select 1 from public.admin_members m where m.user_id = (select auth.uid()) and m.role in ('super_admin','finance')));

create function qingyin_admin.adjust_usdt(p_user_id uuid,p_direction text,p_amount numeric,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  actor uuid := auth.uid();
  asset uuid;
  issuer uuid;
  wallet uuid;
  tx uuid;
  balance numeric;
  item public.usdt_deductions%rowtype;
  result jsonb;
  reason text := btrim(coalesce(p_reason,''));
  action_name text;
begin
  if actor is null or not exists (select 1 from public.admin_members where user_id=actor and role in ('super_admin','finance')) then
    raise exception '需要超级管理员或财务权限' using errcode='42501';
  end if;
  if p_user_id is null or p_request_id is null or p_direction is null or p_direction not in ('credit','debit') or
     p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount <= 0 or p_amount > 1000000000000 or
     p_amount <> round(p_amount,6) or length(reason) not between 1 and 500 then
    raise exception '账户、方向、金额或依据无效';
  end if;
  perform 1 from auth.users where id=p_user_id and deleted_at is null for share;
  if not found then raise exception '用户不存在'; end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-usdt:'||p_request_id::text,0));
  if p_direction='credit' then
    if exists (select 1 from public.usdt_deductions where request_id=p_request_id) then raise exception '操作编号已用于扣减'; end if;
    result := qingyin_admin.allocate_internal_credit(p_user_id,p_amount,reason,p_request_id);
    if coalesce((result->>'replayed')::boolean,false) then return result; end if;
    tx := (result->>'ledger_transaction_id')::uuid;
    action_name := 'usdt_credited';
  else
    if exists (select 1 from public.internal_credit_allocations where request_id=p_request_id) then raise exception '操作编号已用于增加'; end if;
    select * into item from public.usdt_deductions where request_id=p_request_id;
    if found then
      if item.actor_user_id<>actor or item.user_id<>p_user_id or item.amount<>p_amount or item.reason<>reason then
        raise exception '操作编号已用于不同的扣减';
      end if;
      return jsonb_build_object('ledger_transaction_id',item.ledger_transaction_id,'replayed',true);
    end if;
    select id into asset from public.assets where symbol='USDT' and status='active';
    if asset is null then raise exception 'USDT 站内记账单位未启用'; end if;
    perform app_private.provision_user_wallets(p_user_id);
    insert into public.ledger_accounts(owner_user_id,asset_id,account_code) values(null,asset,'clearing')
      on conflict(owner_user_id,asset_id,account_code) do nothing;
    select id into issuer from public.ledger_accounts where owner_user_id is null and asset_id=asset and account_code='clearing';
    select id into wallet from public.ledger_accounts where owner_user_id=p_user_id and asset_id=asset and account_code='available';
    if issuer is null or wallet is null then raise exception '账本账户未初始化'; end if;
    perform 1 from public.ledger_accounts where id in (issuer,wallet) order by id for update;
    select coalesce(sum(case when side='credit' then amount else -amount end),0)
      into balance from public.ledger_entries where account_id=wallet;
    if balance < p_amount then raise exception '用户可用 USDT 余额不足'; end if;
    tx := app_private.post_ledger('internal_credit_deduction',p_request_id::text,'internal-debit:'||p_request_id::text,
      reason,jsonb_build_array(jsonb_build_object('account_id',wallet,'side','debit','amount',p_amount),
      jsonb_build_object('account_id',issuer,'side','credit','amount',p_amount)));
    insert into public.usdt_deductions(request_id,actor_user_id,user_id,amount,reason,ledger_transaction_id)
      values (p_request_id,actor,p_user_id,p_amount,reason,tx);
    insert into public.audit_logs(actor_user_id,action,resource_type,resource_id,metadata)
      values (actor,'internal_credit_deducted','usdt_deductions',p_request_id::text,
        jsonb_build_object('user_id',p_user_id,'amount',p_amount,'reason',reason));
    result := jsonb_build_object('ledger_transaction_id',tx,'available',balance-p_amount,'replayed',false);
    action_name := 'usdt_deducted';
  end if;
  insert into public.user_notifications(user_id,kind,title,body,resource_id)
    values (p_user_id,action_name,case when p_direction='credit' then 'USDT 额度已增加' else 'USDT 额度已扣减' end,
      p_amount::text||' USDT 站内记账额度',tx);
  return result;
end;
$function$;
revoke all on function qingyin_admin.adjust_usdt(uuid,text,numeric,text,uuid) from public,anon,authenticated;
grant execute on function qingyin_admin.adjust_usdt(uuid,text,numeric,text,uuid) to authenticated;

create function public.admin_adjust_usdt(p_user_id uuid,p_direction text,p_amount numeric,p_reason text,p_request_id uuid)
returns jsonb language sql security invoker set search_path = '' as $function$
  select qingyin_admin.adjust_usdt(p_user_id,p_direction,p_amount,p_reason,p_request_id);
$function$;
revoke all on function public.admin_adjust_usdt(uuid,text,numeric,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_adjust_usdt(uuid,text,numeric,text,uuid) to authenticated;

create index user_notifications_user_unread_created_idx
  on public.user_notifications (user_id,created_at desc,id desc) where read_at is null;
