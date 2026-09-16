-- sendflow_02 (15/09/2026, 21h20 BR): gate da sendflow_01 (revisor de confiabilidade), 2 obrigatórias + 6 sugestões.
--
-- OBRIG 1 — a conta NOVA entrava no envio sem passar pela trava de "um envio por chip":
--   o claim gateou cooldown + advisory lock no id ANTIGO, a troca acontecia depois. Dois lotes
--   de campanhas diferentes (ids mortos diferentes) podiam sair pelo MESMO chip ao mesmo tempo.
--   Agora o resolver re-gateia no id novo (cooldown + advisory lock com a MESMA chave do claim);
--   chip ocupado → o lote volta pra 'pending' já com o id novo (o claim passa a gatear certo)
--   e o send_lote devolve 'reagendado' sem enviar. Cópia do cooldown com fallback (nunca no-op).
-- OBRIG 2 — GET dentro da transação do envio podia armar o backoff GLOBAL de 61 min (para todos os
--   envios) e um /releases lento podia estourar o timeout (query_canceled não é pego por OTHERS):
--   curto-circuito pela dim (account_ids com menos de 10 min → zero HTTP; o 1º lote do disparo paga
--   o GET, os outros não), pg_sleep(1) antes do GET de fallback, e sendflow_api ganhou
--   p_arma_backoff (leitura respeita o backoff mas nunca o cria).
-- Sugestões: S1 conta do lote ainda válida ([chipA, chipB]) → não troca; S2 libera o cooldown do id
--   morto; S3 falha da resolução anotada em resolucao_nota; S4 dim só atualiza se mudou ou está velha;
--   S5 CTE do armar ignora conta com formato inválido na dim; S6 resolver só age em lote 'sending'.
-- Rollback: `select distinct on (nome) def from sendflow_fn_backup where lote = 'sendflow_02' order by nome, id`
--   (sendflow_api volta com 1 argumento: dropar a versão de 2 antes). Reverter reintroduz o bug do chip.
-- Testes desta migration: sem nenhum disparo (fila vazia; cenários em transação desfeita).

create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

insert into public.sendflow_fn_backup (lote, nome, def)
select 'sendflow_02', f, pg_get_functiondef(('public.' || f)::regproc)
from unnest(array['sendflow_api', 'sendflow_conta_da_release', 'sendflow_resolver_conta_lote', 'sendflow_send_lote', 'sendflow_disparar']) f;

alter table public.sendflow_envio_fila add column if not exists resolucao_nota text;
comment on column public.sendflow_envio_fila.resolucao_nota is 'o que a resolução de conta ao vivo fez neste lote (trocou, reagendou, falhou). sendflow_02.';

-- ---------------------------------------------------------------------------
-- OBRIG 2b: leitura que nunca arma o backoff global
-- ---------------------------------------------------------------------------
drop function if exists public.sendflow_api(text);
create or replace function public.sendflow_api(p_path text, p_arma_backoff boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare r record; v_backoff timestamptz; v_status int;
begin
  select backoff_until into v_backoff from sendflow_api_estado where id=1;
  if v_backoff is not null and now() < v_backoff then
    return jsonb_build_object('status', 429,
      'body', jsonb_build_object('code','local-backoff','until', v_backoff));
  end if;

  select status, content into r
  from extensions.http((
    'GET', 'https://sendapi.sendflow.pro' || p_path,
    array[extensions.http_header('Authorization', 'Bearer ' || get_secret('sendflow_sendapi_key'))],
    null, null
  )::extensions.http_request);
  v_status := r.status;

  -- api-key-blocked / 403 / 429: entra em backoff de 61 min pra não reiniciar a punição.
  -- Leitura de conveniência (p_arma_backoff = false) respeita o backoff mas NÃO o cria:
  -- um GET não pode parar todos os envios (sendflow_02).
  if v_status in (403, 429) and p_arma_backoff then
    update sendflow_api_estado set backoff_until = now() + interval '61 minutes',
      ultimo_status = v_status, atualizado_em = now() where id=1;
  else
    update sendflow_api_estado set ultimo_status = v_status, atualizado_em = now() where id=1;
  end if;

  return jsonb_build_object('status', v_status, 'body',
    case when left(coalesce(r.content,''), 1) in ('{','[') then r.content::jsonb
         else to_jsonb(left(coalesce(r.content,''), 500)) end);
end $$;
revoke all on function public.sendflow_api(text, boolean) from public;
grant execute on function public.sendflow_api(text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- OBRIG 2a: contas da campanha com curto-circuito pela dim
-- ---------------------------------------------------------------------------
create or replace function public.sendflow_contas_da_release(p_release_id text)
returns text[] language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare r jsonb; v_ids text[]; v_item jsonb; v_dim text[]; v_dim_em timestamptz;
begin
  if coalesce(p_release_id, '') !~ '^[A-Za-z0-9_-]{1,64}$' then return null; end if;
  select d.account_ids, d.account_ids_em into v_dim, v_dim_em from sendflow_releases_dim d where d.release_id = p_release_id;
  -- fresco (< 10 min): zero requisição. O 1º lote do disparo paga o GET, os outros não.
  if v_dim is not null and cardinality(v_dim) > 0 and v_dim_em > now() - interval '10 minutes' then
    return v_dim;
  end if;
  r := sendflow_api('/releases/' || p_release_id, false);
  if (r->>'status')::int = 200 and jsonb_typeof(r->'body'->'accountIds') = 'array' then
    v_ids := array(select jsonb_array_elements_text(r->'body'->'accountIds'));
  else
    -- endpoint individual falhou: a lista inteira também traz accountIds (1 req/s: espaça)
    perform pg_sleep(1);
    r := sendflow_api('/releases', false);
    if (r->>'status')::int = 200 then
      select x into v_item from jsonb_array_elements(coalesce(r->'body'->'items', case when jsonb_typeof(r->'body') = 'array' then r->'body' else '[]'::jsonb end)) x
       where x->>'id' = p_release_id limit 1;
      if v_item is not null and jsonb_typeof(v_item->'accountIds') = 'array' then
        v_ids := array(select jsonb_array_elements_text(v_item->'accountIds'));
      end if;
    end if;
  end if;
  if v_ids is null then return null; end if;   -- API fora do ar ou em backoff: quem chamou segue com o que tinha
  -- só escreve na dim se mudou ou está velha (não segurar lock de linha à toa dentro do envio)
  update sendflow_releases_dim set account_ids = v_ids, account_ids_em = now()
   where release_id = p_release_id and (account_ids is distinct from v_ids or account_ids_em is null or account_ids_em < now() - interval '5 minutes');
  return v_ids;
end $$;
revoke all on function public.sendflow_contas_da_release(text) from public;
comment on function public.sendflow_contas_da_release(text) is 'accountIds atuais da campanha: dim se fresca (<10 min), senão GET /releases/{id} (fallback /releases, sem armar backoff). null = não conseguiu. sendflow_02.';

create or replace function public.sendflow_conta_da_release(p_release_id text)
returns text language sql security definer set search_path to 'public' as $$
  select (public.sendflow_contas_da_release(p_release_id))[1]
$$;

-- ---------------------------------------------------------------------------
-- OBRIG 1: resolver re-gateia no id novo (mesma chave do claim)
-- ---------------------------------------------------------------------------
create or replace function public.sendflow_resolver_conta_lote(p_id bigint)
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare it record; v_ids text[]; v_conta text; v_ocupado timestamptz;
begin
  select * into it from sendflow_envio_fila where id = p_id and status = 'sending' for update;
  if not found then return null; end if;
  v_ids := sendflow_contas_da_release(it.release_id);
  if v_ids is null or cardinality(v_ids) = 0 then return it.account_id; end if;
  -- a conta do lote ainda é uma das contas da campanha: não mexe (S1)
  if it.account_id = any(v_ids) then return it.account_id; end if;
  v_conta := v_ids[1];
  if coalesce(v_conta, '') !~ '^[A-Za-z0-9_-]{1,64}$' then return it.account_id; end if;

  -- o claim gateou cooldown + lock no id ANTIGO; o novo nunca passou por isso. Re-gateia aqui,
  -- com a MESMA chave de lock do claim. Chip ocupado → volta pra fila já com o id novo.
  select c.ocupado_ate into v_ocupado from sendflow_chip_cooldown c where c.account_id = v_conta;
  if (v_ocupado is not null and v_ocupado > now())
     or not pg_try_advisory_xact_lock(hashtextextended('sfchip:' || v_conta, 0)) then
    update sendflow_envio_fila
       set status = 'pending',
           account_id = v_conta,
           account_id_original = coalesce(account_id_original, it.account_id),
           proximo_em = greatest(now() + interval '60 seconds', coalesce(v_ocupado, now())),
           resolucao_nota = left('chip ' || v_conta || ' ocupado: reagendado (conta antiga ' || it.account_id || ')', 200)
     where id = p_id;
    -- o cooldown que o claim registrou no id morto não protege ninguém: libera
    delete from sendflow_chip_cooldown where account_id = it.account_id;
    return null;
  end if;

  update sendflow_envio_fila
     set account_id = v_conta,
         account_id_original = coalesce(account_id_original, it.account_id),
         resolucao_nota = left('conta trocada ao vivo: ' || it.account_id || ' -> ' || v_conta, 200)
   where id = p_id;
  -- cooldown do chip novo: copia o do antigo; sem ele, a mesma conta que o claim usaria (nunca no-op)
  insert into sendflow_chip_cooldown (account_id, ocupado_ate, atualizado_em)
  values (v_conta,
          coalesce((select c.ocupado_ate from sendflow_chip_cooldown c where c.account_id = it.account_id),
                   now() + make_interval(secs => (coalesce(cardinality(it.gids), 0) * it.intervalo_max + 120))),
          now())
  on conflict (account_id) do update
    set ocupado_ate = greatest(sendflow_chip_cooldown.ocupado_ate, excluded.ocupado_ate), atualizado_em = now();
  delete from sendflow_chip_cooldown where account_id = it.account_id;   -- id morto (S2)
  return v_conta;
end $$;
revoke all on function public.sendflow_resolver_conta_lote(bigint) from public;
comment on function public.sendflow_resolver_conta_lote(bigint) is 'Lote em sending: se a conta dele não é mais da campanha, troca pela atual re-gateando cooldown + advisory lock no id novo; chip ocupado → lote volta pra pending com o id novo e devolve null. sendflow_02.';

-- send_lote: anota falha da resolução e não envia lote reagendado
do $$
declare v text;
  s_old text := $x$  -- sendflow_01: chip trocado no SendFlow tem id novo; o guardado no lote pode ter morrido.
  -- Resolve ao vivo antes do POST; qualquer falha aqui NÃO derruba o envio (segue com o guardado).
  begin
    perform sendflow_resolver_conta_lote(it.id);
    select * into it from sendflow_envio_fila where id = p_id;
  exception when others then null;
  end;
$x$;
  s_new text := $x$  -- sendflow_01/02: chip trocado no SendFlow tem id novo; o guardado no lote pode ter morrido.
  -- Resolve ao vivo antes do POST (curto-circuito pela dim: quase nunca faz HTTP). Exceções comuns
  -- são engolidas e anotadas no lote; cancelamento por timeout derruba o envio e o reaper marca 'incerto'.
  begin
    perform sendflow_resolver_conta_lote(it.id);
    select * into it from sendflow_envio_fila where id = p_id;
  exception when others then
    update sendflow_envio_fila set resolucao_nota = left('resolucao falhou: ' || SQLERRM, 200) where id = p_id;
  end;
  if it.status is distinct from 'sending' then
    return 'lote reagendado (chip ocupado): ' || p_id;
  end if;
$x$;
begin
  v := pg_get_functiondef('public.sendflow_send_lote'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_02: bloco em sendflow_send_lote: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- S5: armar ignora conta com formato inválido na dim
do $$
declare v text;
  s_old text := $x$from sendflow_releases_dim d where d.account_ids is not null and cardinality(d.account_ids) > 0$x$;
  s_new text := $x$from sendflow_releases_dim d where d.account_ids is not null and coalesce(d.account_ids[1], '') ~ '^[A-Za-z0-9_-]{6,64}$'$x$;
begin
  v := pg_get_functiondef('public.sendflow_disparar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_02: CTE em sendflow_disparar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- mitigação: lote pendente armado com id morto passa a gatear pelo chip real (hoje: 0 pendentes)
update public.sendflow_envio_fila f
   set account_id = d.account_ids[1],
       account_id_original = coalesce(f.account_id_original, f.account_id),
       resolucao_nota = left('alinhado à conta da campanha (sendflow_02)', 200)
  from public.sendflow_releases_dim d
 where d.release_id = f.release_id and f.status = 'pending'
   and coalesce(d.account_ids[1], '') ~ '^[A-Za-z0-9_-]{6,64}$'
   and f.account_id is distinct from d.account_ids[1];
