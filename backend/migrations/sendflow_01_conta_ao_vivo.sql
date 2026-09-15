-- sendflow_01 (15/09/2026, 21h BR): conta do chip resolvida AO VIVO na hora do envio.
--
-- Bug (Peterson, 15/09 20h14): "sempre que cai um número e eu reponho no SendFlow, dá esse
-- erro quando vou disparar depois" → send 400 {"message": "Conta X não encontrada!"}.
-- Causa: sendflow_disparar escolhia a conta de cada campanha pela ÚLTIMA AÇÃO coletada
-- (sendflow_acoes). Trocar o chip no SendFlow cria conta com ID NOVO; a última ação ainda
-- aponta pro ID antigo, que não existe mais. Hoje: lotes 125/128 (14h52) e 130/131 (20h08)
-- falharam assim; 27 grupos das VIP 01/02 não receberam a mensagem.
--
-- Correção em camadas (nenhuma reenvia nada; lote 'error' fica como está):
--  1. sendflow_releases_dim.account_ids: o coletor diário (kind 'releases') passa a guardar
--     os accountIds de cada campanha.
--  2. sendflow_conta_da_release(release): GET /releases/{id} ao vivo (fallback: /releases),
--     atualiza a dim e devolve a conta atual. API fora/backoff → null (quem chamou segue).
--  3. sendflow_resolver_conta_lote(id) + sendflow_send_lote: antes do POST, resolve a conta
--     ao vivo; se mudou, troca no lote (original em account_id_original) e copia o cooldown
--     do chip pro id novo. Qualquer exceção na resolução é engolida: o envio segue como antes.
--  4. sendflow_disparar: prefere account_ids[1] da dim; senão a última ação (como antes).
--
-- As funções sendflow_* nasceram direto no banco (ago/set 2026, ponte SendFlow); esta é a
-- primeira migration versionada delas. Rollback: sendflow_fn_backup guarda o texto anterior
-- de cada função alterada → `select def from sendflow_fn_backup where lote = 'sendflow_01'`
-- e executar.

create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

create table if not exists public.sendflow_fn_backup (
  id bigserial primary key, lote text not null, nome text not null, def text not null, em timestamptz not null default now());
insert into public.sendflow_fn_backup (lote, nome, def)
select 'sendflow_01', f, pg_get_functiondef(('public.' || f)::regproc)
from unnest(array['sendflow_processar', 'sendflow_send_lote', 'sendflow_disparar']) f;

alter table public.sendflow_releases_dim
  add column if not exists account_ids text[],
  add column if not exists account_ids_em timestamptz;
comment on column public.sendflow_releases_dim.account_ids is 'accountIds da campanha no SendFlow (coletor diário + resolução ao vivo no envio); [1] é o chip que dispara';
alter table public.sendflow_envio_fila add column if not exists account_id_original text;
comment on column public.sendflow_envio_fila.account_id_original is 'conta que o lote tinha ao ser armado, quando o worker trocou pela conta ao vivo da campanha (sendflow_01)';

-- ---------------------------------------------------------------------------
-- 1. coletor diário guarda accountIds
-- ---------------------------------------------------------------------------
do $$
declare v text;
  s_old text := $x$      insert into sendflow_releases_dim(release_id,nome,tipo,slug,group_creation_mode,communidade,atualizado_em)
      values (a->>'id', a->>'name', a->>'type', a->>'slug',
              a->'group'->>'groupCreationMode', (a->'group'->>'communityEnabled')::boolean, now())
      on conflict (release_id) do update set nome=excluded.nome, tipo=excluded.tipo, slug=excluded.slug,
        group_creation_mode=excluded.group_creation_mode, communidade=excluded.communidade, atualizado_em=now();$x$;
  s_new text := $x$      insert into sendflow_releases_dim(release_id,nome,tipo,slug,group_creation_mode,communidade,atualizado_em,account_ids,account_ids_em)
      values (a->>'id', a->>'name', a->>'type', a->>'slug',
              a->'group'->>'groupCreationMode', (a->'group'->>'communityEnabled')::boolean, now(),
              case when jsonb_typeof(a->'accountIds') = 'array' then array(select jsonb_array_elements_text(a->'accountIds')) end,
              case when jsonb_typeof(a->'accountIds') = 'array' then now() end)
      on conflict (release_id) do update set nome=excluded.nome, tipo=excluded.tipo, slug=excluded.slug,
        group_creation_mode=excluded.group_creation_mode, communidade=excluded.communidade, atualizado_em=now(),
        account_ids = coalesce(excluded.account_ids, sendflow_releases_dim.account_ids),
        account_ids_em = coalesce(excluded.account_ids_em, sendflow_releases_dim.account_ids_em);$x$;
begin
  v := pg_get_functiondef('public.sendflow_processar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_01: releases em sendflow_processar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- ---------------------------------------------------------------------------
-- 2. conta atual da campanha, ao vivo
-- ---------------------------------------------------------------------------
create or replace function public.sendflow_conta_da_release(p_release_id text)
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare r jsonb; v_ids text[]; v_item jsonb;
begin
  if coalesce(p_release_id, '') !~ '^[A-Za-z0-9_-]{1,64}$' then return null; end if;
  r := sendflow_api('/releases/' || p_release_id);
  if (r->>'status')::int = 200 and jsonb_typeof(r->'body'->'accountIds') = 'array' then
    v_ids := array(select jsonb_array_elements_text(r->'body'->'accountIds'));
  else
    -- endpoint individual falhou: a lista inteira também traz accountIds
    r := sendflow_api('/releases');
    if (r->>'status')::int = 200 then
      select x into v_item from jsonb_array_elements(coalesce(r->'body'->'items', case when jsonb_typeof(r->'body') = 'array' then r->'body' else '[]'::jsonb end)) x
       where x->>'id' = p_release_id limit 1;
      if v_item is not null and jsonb_typeof(v_item->'accountIds') = 'array' then
        v_ids := array(select jsonb_array_elements_text(v_item->'accountIds'));
      end if;
    end if;
  end if;
  if v_ids is null then return null; end if;   -- API fora do ar ou em backoff: quem chamou segue com o que tinha
  update sendflow_releases_dim set account_ids = v_ids, account_ids_em = now() where release_id = p_release_id;
  return v_ids[1];
end $$;
revoke all on function public.sendflow_conta_da_release(text) from public;
comment on function public.sendflow_conta_da_release(text) is 'GET /releases/{id} (fallback /releases): accountIds atuais da campanha; grava na dim e devolve o 1º. null = não conseguiu. sendflow_01.';

-- ---------------------------------------------------------------------------
-- 3. lote usa a conta ao vivo
-- ---------------------------------------------------------------------------
create or replace function public.sendflow_resolver_conta_lote(p_id bigint)
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare it record; v_conta text;
begin
  select * into it from sendflow_envio_fila where id = p_id for update;
  if not found then return null; end if;
  v_conta := sendflow_conta_da_release(it.release_id);
  if v_conta is null or v_conta = it.account_id then return coalesce(v_conta, it.account_id); end if;
  update sendflow_envio_fila
     set account_id = v_conta, account_id_original = coalesce(account_id_original, it.account_id)
   where id = p_id;
  -- o claim registrou o cooldown do chip no id antigo: vale pro novo também
  insert into sendflow_chip_cooldown (account_id, ocupado_ate, atualizado_em)
  select v_conta, c.ocupado_ate, now() from sendflow_chip_cooldown c where c.account_id = it.account_id
  on conflict (account_id) do update
    set ocupado_ate = greatest(sendflow_chip_cooldown.ocupado_ate, excluded.ocupado_ate), atualizado_em = now();
  return v_conta;
end $$;
revoke all on function public.sendflow_resolver_conta_lote(bigint) from public;
comment on function public.sendflow_resolver_conta_lote(bigint) is 'Troca a conta do lote pela conta atual da campanha (ao vivo) quando mudou; guarda a original e copia o cooldown. sendflow_01.';

do $$
declare v text;
  s_old text := $x$  if not found then return 'lote nao esta em sending: '||coalesce(p_id::text,'null'); end if;
$x$;
  s_new text := $x$  if not found then return 'lote nao esta em sending: '||coalesce(p_id::text,'null'); end if;

  -- sendflow_01: chip trocado no SendFlow tem id novo; o guardado no lote pode ter morrido.
  -- Resolve ao vivo antes do POST; qualquer falha aqui NÃO derruba o envio (segue com o guardado).
  begin
    perform sendflow_resolver_conta_lote(it.id);
    select * into it from sendflow_envio_fila where id = p_id;
  exception when others then null;
  end;
$x$;
begin
  v := pg_get_functiondef('public.sendflow_send_lote'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_01: âncora em sendflow_send_lote: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- ---------------------------------------------------------------------------
-- 4. armar: prefere a conta da campanha
-- ---------------------------------------------------------------------------
do $$
declare v text;
  s_old text := $x$  contas as (
    select distinct on (release_id) release_id, account_id
    from sendflow_acoes where account_id is not null
    order by release_id, criada_em desc nulls last
  )$x$;
  s_new text := $x$  contas as (
    -- sendflow_01: primeiro a conta associada à campanha (coletor/ao vivo), senão a última ação
    select distinct on (release_id) release_id, account_id from (
      select d.release_id, d.account_ids[1] as account_id, 0 as ordem
        from sendflow_releases_dim d where d.account_ids is not null and cardinality(d.account_ids) > 0
      union all
      select a.release_id, a.account_id, 1
        from (select distinct on (release_id) release_id, account_id
                from sendflow_acoes where account_id is not null
               order by release_id, criada_em desc nulls last) a
    ) u
    order by release_id, ordem
  )$x$;
begin
  v := pg_get_functiondef('public.sendflow_disparar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_01: contas em sendflow_disparar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;
