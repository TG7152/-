create function qingyin_admin.complete_withdrawal(p_withdrawal_id uuid,p_payment_reference text)
returns boolean language plpgsql security definer set search_path='' as $function$
declare
  actor uuid := auth.uid();
  w public.withdrawals%rowtype;
  locked_id uuid;
  clearing_id uuid;
  fee_id uuid;
  balance numeric;
  reference text := btrim(coalesce(p_payment_reference,''));
  lines jsonb;
begin
  if actor is null or not exists(select 1 from public.admin_members where user_id=actor and role in ('super_admin','finance')) then
    raise exception '需要超级管理员或财务权限' using errcode='42501';
  end if;
  if length(reference) not between 6 and 128 then raise exception '请输入 6–128 位付款流水号或链上交易哈希'; end if;
  select * into w from public.withdrawals where id=p_withdrawal_id for update;
  if not found then raise exception '提现申请不存在'; end if;
  if w.user_id=actor then raise exception '不能确认本人的提现付款'; end if;
  if w.status='completed' and w.tx_hash=reference then return true; end if;
  if w.status<>'approved' then raise exception '仅已通过审核的提现可以确认付款'; end if;
  perform pg_advisory_xact_lock(hashtextextended('withdrawal-payment:'||lower(reference),0));
  if exists(select 1 from public.withdrawals where id<>w.id and status='completed' and lower(tx_hash)=lower(reference)) then
    raise exception '这笔付款流水已用于另一笔提现';
  end if;
  insert into public.ledger_accounts(owner_user_id,asset_id,account_code)
    values(null,w.asset_id,'clearing'),(null,w.asset_id,'fee_revenue')
    on conflict(owner_user_id,asset_id,account_code) do nothing;
  select id into locked_id from public.ledger_accounts where owner_user_id=w.user_id and asset_id=w.asset_id and account_code='locked';
  select id into clearing_id from public.ledger_accounts where owner_user_id is null and asset_id=w.asset_id and account_code='clearing';
  select id into fee_id from public.ledger_accounts where owner_user_id is null and asset_id=w.asset_id and account_code='fee_revenue';
  if locked_id is null then raise exception '冻结账户不存在'; end if;
  perform 1 from public.ledger_accounts where id in (locked_id,clearing_id,fee_id) order by id for update;
  select coalesce(sum(case when side='credit' then amount else -amount end),0) into balance
    from public.ledger_entries where account_id=locked_id;
  if balance<w.amount+w.fee then raise exception '冻结余额不足，无法确认付款'; end if;
  lines:=jsonb_build_array(jsonb_build_object('account_id',locked_id,'side','debit','amount',w.amount+w.fee),
    jsonb_build_object('account_id',clearing_id,'side','credit','amount',w.amount));
  if w.fee>0 then
    lines:=lines||jsonb_build_array(jsonb_build_object('account_id',fee_id,'side','credit','amount',w.fee));
  end if;
  perform app_private.post_ledger('withdrawal_settlement',w.id::text,'withdrawal-settle:'||w.id::text,'提现付款核实',lines);
  update public.withdrawals set status='completed',tx_hash=reference where id=w.id;
  insert into public.user_notifications(user_id,kind,title,body,resource_id)
    values(w.user_id,'withdrawal_completed','提现付款已确认','付款已经由后台核实，详情请查看提现记录。',w.id);
  insert into public.audit_logs(actor_user_id,action,resource_type,resource_id,metadata)
    values(actor,'withdrawal_paid','withdrawals',w.id::text,jsonb_build_object('payment_reference',reference));
  return true;
end
$function$;
revoke all on function qingyin_admin.complete_withdrawal(uuid,text) from public,anon,authenticated;
grant execute on function qingyin_admin.complete_withdrawal(uuid,text) to authenticated;

create function public.admin_complete_withdrawal(p_withdrawal_id uuid,p_payment_reference text)
returns boolean language sql security invoker set search_path='' as $function$
  select qingyin_admin.complete_withdrawal(p_withdrawal_id,p_payment_reference);
$function$;
revoke all on function public.admin_complete_withdrawal(uuid,text) from public,anon,authenticated;
grant execute on function public.admin_complete_withdrawal(uuid,text) to authenticated;
