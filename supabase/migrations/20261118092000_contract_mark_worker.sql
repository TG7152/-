create extension if not exists pg_cron;
create extension if not exists pg_net;

create table app_private.contract_quote_requests (
  id bigint primary key,
  queued_at timestamptz not null default now()
);
revoke all on app_private.contract_quote_requests from public,anon,authenticated;
revoke insert,update,delete,truncate on net._http_response from public,anon,authenticated;

create function app_private.refresh_contract_marks()
returns void language plpgsql security invoker set search_path='' as $$
declare
  queued record;
  quote record;
  position record;
  pairs jsonb;
  mark_time timestamptz;
begin
  delete from app_private.contract_quote_requests where queued_at<now()-interval '2 minutes';
  for queued in
    select q.id,r.content,r.status_code
    from app_private.contract_quote_requests q join net._http_response r on r.id=q.id
    order by q.queued_at
  loop
    delete from app_private.contract_quote_requests where id=queued.id;
    if queued.status_code=200 and left(btrim(queued.content),1)='[' then
      for quote in
        select m.id as market_id,(b.value->>'lastPrice')::numeric as price,(b.value->>'closeTime')::bigint as millis
        from jsonb_array_elements(queued.content::jsonb) b(value)
        join public.markets m on replace(m.symbol,'/','')=b.value->>'symbol'
        join public.assets q on q.id=m.quote_asset_id and q.symbol='USDT'
        where b.value->>'lastPrice' ~ '^[0-9]{1,12}(\.[0-9]{1,18})?$' and b.value->>'closeTime' ~ '^[0-9]{13}$'
      loop
        mark_time:=to_timestamp(quote.millis/1000.0);
        if quote.price>0 and quote.price<=1000000000000 and mark_time between now()-interval '20 seconds' and now()+interval '3 seconds' then
          insert into app_private.contract_marks values(quote.market_id,quote.price,mark_time)
          on conflict(market_id) do update set price=excluded.price,observed_at=excluded.observed_at
          where contract_marks.observed_at<excluded.observed_at;
        end if;
      end loop;
    end if;
  end loop;
  for position in
    select p.id,m.price
    from public.contract_positions p join app_private.contract_marks m on m.market_id=p.market_id
    where p.state='open' and m.observed_at>=now()-interval '20 seconds'
      and p.margin+app_private.contract_pnl(p.side,p.entry_price,m.price,p.quantity)<=m.price*p.quantity*0.005
    order by p.id limit 500 for update of p skip locked
  loop
    perform app_private.settle_usdt_contract(position.id,position.price,'liquidated');
  end loop;
  select jsonb_agg(symbol order by symbol) into pairs
  from (
    select distinct replace(m.symbol,'/','') as symbol
    from public.markets m join public.assets q on q.id=m.quote_asset_id and q.symbol='USDT'
    where m.status='active' or exists(select 1 from public.contract_positions p where p.market_id=m.id and p.state='open')
  ) usable;
  if pairs is not null then
    insert into app_private.contract_quote_requests(id)
    values(net.http_get(url:='https://data-api.binance.vision/api/v3/ticker/24hr',
      params:=jsonb_build_object('symbols',pairs::text),timeout_milliseconds:=5000));
  end if;
end
$$;
revoke all on function app_private.refresh_contract_marks() from public,anon,authenticated;
select cron.schedule('qingyin-contract-marks-and-liquidation','5 seconds','select app_private.refresh_contract_marks()');
