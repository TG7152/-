do $migration$
begin
  if exists (
    select 1
    from public.orders o
    join public.markets m on m.id = o.market_id
    join public.assets q on q.id = m.quote_asset_id
    where q.symbol <> 'USDT' and o.status in ('new','open','partially_filled')
  ) then
    raise exception '非 USDT 市场仍有未完成委托，须先按原规则撤单';
  end if;
end
$migration$;

update public.markets m
set status='inactive'
from public.assets quote
where quote.id=m.quote_asset_id and quote.symbol<>'USDT' and m.status='active';

create function app_private.guard_usdt_market()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  if (tg_op='INSERT' or new.status='active' or new.quote_asset_id is distinct from old.quote_asset_id)
    and not exists (select 1 from public.assets where id=new.quote_asset_id and symbol='USDT') then
    raise exception '现货交易对仅支持站内 USDT 计价' using errcode='23514';
  end if;
  return new;
end;
$function$;

create trigger markets_usdt_only
before insert or update of quote_asset_id,status on public.markets
for each row execute function app_private.guard_usdt_market();

create function app_private.guard_usdt_order()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  if not exists (select 1 from public.markets m join public.assets a on a.id=m.quote_asset_id
    where m.id=new.market_id and a.symbol='USDT') then
    raise exception '买入与卖出仅支持站内 USDT 计价' using errcode='23514';
  end if;
  return new;
end;
$function$;

create trigger orders_usdt_only
before insert or update of market_id on public.orders
for each row execute function app_private.guard_usdt_order();

create function app_private.enqueue_spot_trade_notifications()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare market_symbol text;
begin
  select symbol into market_symbol from public.markets where id=new.market_id;
  insert into public.user_notifications(user_id,kind,title,body,resource_id)
  values
    (new.buyer_user_id,'spot_trade','现货买入已成交',market_symbol||' · 数量 '||new.quantity::text||' · 成交价 '||new.price::text,new.id),
    (new.seller_user_id,'spot_trade','现货卖出已成交',market_symbol||' · 数量 '||new.quantity::text||' · 成交价 '||new.price::text,new.id);
  return new;
end;
$function$;

revoke all on function app_private.guard_usdt_market() from public,anon,authenticated;
revoke all on function app_private.guard_usdt_order() from public,anon,authenticated;
revoke all on function app_private.enqueue_spot_trade_notifications() from public,anon,authenticated;

create trigger notify_spot_trade
after insert on public.trades
for each row execute function app_private.enqueue_spot_trade_notifications();
