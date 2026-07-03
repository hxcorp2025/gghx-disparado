-- Métrica "disparos por campanha": vincula disparo -> campanha (lista) de origem.
-- JA APLICADO no banco (coluna + backfill exato + RPC).
alter table gghx_campanhas add column if not exists lista_id bigint;

update gghx_campanhas c set lista_id = l.id
from gghx_listas l
where c.lista_id is null
  and (select array_agg(gi.group_id order by gi.group_id) from gghx_campanha_itens gi where gi.campanha_id=c.id)
    = (select array_agg(x order by x) from jsonb_array_elements_text(l.group_ids) x);

create or replace function gghx_disparos_por_campanha()
returns table(lista_id bigint, campanha text, disparos bigint, enviadas bigint, entregues bigint, lidas bigint, ultimo timestamptz)
language sql security definer set search_path=public as $$
  with m as (
    select campanha_id, count(*) enviadas,
           count(*) filter (where delivered_at is not null) entregues,
           count(*) filter (where read_at is not null) lidas
    from gghx_mensagens group by campanha_id
  )
  select c.lista_id, coalesce(l.nome,'(sem campanha)'),
         count(distinct c.id)::bigint, coalesce(sum(m.enviadas),0)::bigint,
         coalesce(sum(m.entregues),0)::bigint, coalesce(sum(m.lidas),0)::bigint, max(c.criado_em)
  from gghx_campanhas c
  left join gghx_listas l on l.id=c.lista_id
  left join m on m.campanha_id=c.id::text
  group by c.lista_id, l.nome order by count(distinct c.id) desc, max(c.criado_em) desc nulls last;
$$;
revoke all on function gghx_disparos_por_campanha() from public, anon;
grant execute on function gghx_disparos_por_campanha() to authenticated;
