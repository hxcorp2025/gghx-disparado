-- FIX contabilização do painel de disparo.
-- gghx_mensagens tem RLS ligado e ZERO policies -> o front (authenticated) recebe deny-all
-- e lê 0 linhas, enquanto o motor (service_role) grava normal. Este RPC roda como definer
-- e devolve só os agregados, sem expor as linhas cruas.
-- APLICAR JUNTO COM O DEPLOY (não interrompe motor/disparo; é aditivo).

create or replace function gghx_disparo_metrics(p_disparo text)
returns table(enviadas bigint, entregues bigint, lidas bigint)
language sql
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where delivered_at is not null)::bigint,
    count(*) filter (where read_at is not null)::bigint
  from gghx_mensagens
  where campanha_id = p_disparo;
$$;

revoke all on function gghx_disparo_metrics(text) from public, anon;
grant execute on function gghx_disparo_metrics(text) to authenticated;
