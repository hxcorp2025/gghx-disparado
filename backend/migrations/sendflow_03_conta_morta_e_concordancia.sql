-- sendflow_03 (15/09/2026, 21h25 BR): gate rodada 2 do hotfix (revisor de confiabilidade): 3 obrigatórias + S1/S2/S4/S5/S6.
--
-- OBRIG 1 — o `delete` do cooldown do chip antigo (S2 da rodada 1) apagava a trava de um chip que
--   pode estar VIVO servindo outra campanha (VIP 01 e 02 no mesmo chip; troca só a 02): reabria o
--   risco de dois envios pelo mesmo número. Removido: cooldown de chip morto não bloqueia ninguém
--   (nenhum lote aponta mais pra ele) e expira sozinho.
-- OBRIG 2 — curto-circuito só por idade: (a) janela cega de 10 min logo depois da troca do chip
--   (dim fresca com a conta velha → POST 400 → lote error, o bug original de volta); (b) campanha
--   com accountIds = [] (Rox Prêmios) nunca curto-circuitava e pagava GET em todo envio.
--   Agora: o resolver só sai sem HTTP quando o cache é fresco E concorda com o lote (ou a campanha
--   não tem conta); discordância confirma ao vivo (p_max_idade = 0). E o envio ganhou a rede final:
--   POST 400 "Conta X não encontrada" → sendflow_reagendar_conta_morta confirma ao vivo e, se a conta
--   mudou, devolve o lote pra fila com a conta nova (o claim re-gateia) em vez de virar 'error'.
-- OBRIG 3 — sendflow_api foi redigitada na 02: conferido por query que, tirando comentários, o 2º
--   parâmetro e o `and p_arma_backoff`, o texto é IDÊNTICO ao backup (1284 = 1284 chars, sem
--   diferença). Smoke de 1 requisição real fica pra depois de 01:05 UTC (backoff), antes do coletor
--   das 03:00 UTC (registrado no fechamento).
-- S1 — ACL: no Supabase função nova nasce com EXECUTE pra anon/authenticated (default privileges);
--   sendflow_api(text,boolean), contas/conta_da_release e resolver ficaram expostas ~50 min. Revogado
--   às 21h13 BR por comando direto; repetido aqui (idempotente) e a regra foi pra lnk_36.
-- S2 — coalesce em intervalo_max/gids no fallback do cooldown. S4 — chave do lock confirmada por
--   query (claim usa hashtextextended('sfchip:'||account_id,0)). S5 — campanha fora da dim: upsert.
--   S6 — timeout de 15 s no curl da sendflow_api (query_canceled não é pego por OTHERS).
-- Rollback: `select distinct on (nome) def from sendflow_fn_backup where lote='sendflow_03' order by nome, id`
--   + refazer o revoke/grant de cada função (pg_get_functiondef não carrega ACL).

create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

insert into public.sendflow_fn_backup (lote, nome, def)
select 'sendflow_03', f, pg_get_functiondef(('public.' || f)::regproc)
from unnest(array['sendflow_api', 'sendflow_contas_da_release', 'sendflow_resolver_conta_lote', 'sendflow_send_lote']) f;

-- S1: ACL (idempotente)
revoke execute on function public.sendflow_api(text, boolean) from public, anon, authenticated;
revoke execute on function public.sendflow_conta_da_release(text) from public, anon, authenticated;
revoke execute on function public.sendflow_resolver_conta_lote(bigint) from public, anon, authenticated;

-- S6: timeout no curl (a mesma sessão do worker faz os POSTs: 15 s cobre o envio normal, que leva ~100 ms)
do $$
declare v text;
  s_old text := $x$  select status, content into r
  from extensions.http(($x$;
  s_new text := $x$  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000');
  select status, content into r
  from extensions.http(($x$;
begin
  v := pg_get_functiondef('public.sendflow_api'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_03: âncora do curl em sendflow_api: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- OBRIG 2 + S5: contas da campanha com idade parametrizável (0 = sempre ao vivo) e cache '{}' válido
drop function if exists public.sendflow_contas_da_release(text);
create or replace function public.sendflow_contas_da_release(p_release_id text, p_max_idade interval default interval '10 minutes')
returns text[] language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare r jsonb; v_ids text[]; v_item jsonb; v_dim text[]; v_dim_em timestamptz;
begin
  if coalesce(p_release_id, '') !~ '^[A-Za-z0-9_-]{1,64}$' then return null; end if;
  select d.account_ids, d.account_ids_em into v_dim, v_dim_em from sendflow_releases_dim d where d.release_id = p_release_id;
  -- cache fresco vale, inclusive '{}' (campanha sem conta, confirmada há pouco); p_max_idade = 0 força ao vivo
  if v_dim is not null and v_dim_em is not null and v_dim_em > now() - p_max_idade then
    return v_dim;
  end if;
  r := sendflow_api('/releases/' || p_release_id, false);
  if (r->>'status')::int = 200 and jsonb_typeof(r->'body'->'accountIds') = 'array' then
    v_ids := array(select jsonb_array_elements_text(r->'body'->'accountIds'));
  else
    perform pg_sleep(1);   -- 1 req/s
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
  insert into sendflow_releases_dim (release_id, account_ids, account_ids_em, atualizado_em)
  values (p_release_id, v_ids, now(), now())
  on conflict (release_id) do update set account_ids = excluded.account_ids, account_ids_em = now()
    where sendflow_releases_dim.account_ids is distinct from excluded.account_ids
       or sendflow_releases_dim.account_ids_em is null
       or sendflow_releases_dim.account_ids_em < now() - interval '5 minutes';
  return v_ids;
end $$;
revoke execute on function public.sendflow_contas_da_release(text, interval) from public, anon, authenticated;
grant execute on function public.sendflow_contas_da_release(text, interval) to service_role;
comment on function public.sendflow_contas_da_release(text, interval) is 'accountIds atuais da campanha: cache da dim se mais novo que p_max_idade (inclui {}), senão GET /releases/{id} (fallback /releases, sem armar backoff). null = não conseguiu. sendflow_03.';

-- OBRIG 1 + OBRIG 2 + S2: resolver sem delete, com concordância
create or replace function public.sendflow_resolver_conta_lote(p_id bigint)
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare it record; v_ids text[]; v_conta text; v_ocupado timestamptz; v_dim text[]; v_dim_em timestamptz;
begin
  select * into it from sendflow_envio_fila where id = p_id and status = 'sending' for update;
  if not found then return null; end if;
  -- cache fresco E concorda com o lote (ou campanha sem conta): zero HTTP
  select d.account_ids, d.account_ids_em into v_dim, v_dim_em from sendflow_releases_dim d where d.release_id = it.release_id;
  if v_dim is not null and v_dim_em is not null and v_dim_em > now() - interval '10 minutes'
     and (cardinality(v_dim) = 0 or it.account_id = any(v_dim)) then
    return it.account_id;
  end if;
  -- discordou (sinal de troca de chip) ou cache velho: confirma ao vivo
  v_ids := sendflow_contas_da_release(it.release_id, interval '0');
  if v_ids is null or cardinality(v_ids) = 0 then return it.account_id; end if;
  if it.account_id = any(v_ids) then return it.account_id; end if;
  v_conta := v_ids[1];
  if coalesce(v_conta, '') !~ '^[A-Za-z0-9_-]{1,64}$' then return it.account_id; end if;

  -- o claim gateou cooldown + lock no id ANTIGO; o novo nunca passou por isso. Re-gateia aqui,
  -- com a MESMA chave de lock do claim. Chip ocupado → volta pra fila já com o id novo.
  -- O cooldown do id antigo NÃO é apagado: ele pode ser um chip vivo de outra campanha.
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
    return null;
  end if;

  update sendflow_envio_fila
     set account_id = v_conta,
         account_id_original = coalesce(account_id_original, it.account_id),
         resolucao_nota = left('conta trocada ao vivo: ' || it.account_id || ' -> ' || v_conta, 200)
   where id = p_id;
  insert into sendflow_chip_cooldown (account_id, ocupado_ate, atualizado_em)
  values (v_conta,
          coalesce((select c.ocupado_ate from sendflow_chip_cooldown c where c.account_id = it.account_id),
                   now() + make_interval(secs => (coalesce(cardinality(it.gids), 1) * coalesce(it.intervalo_max, 60) + 120))),
          now())
  on conflict (account_id) do update
    set ocupado_ate = greatest(sendflow_chip_cooldown.ocupado_ate, excluded.ocupado_ate), atualizado_em = now();
  return v_conta;
end $$;
revoke execute on function public.sendflow_resolver_conta_lote(bigint) from public, anon, authenticated;
comment on function public.sendflow_resolver_conta_lote(bigint) is 'Lote em sending: cache fresco que concorda = zero HTTP; senão confirma ao vivo e, se a conta mudou, troca re-gateando cooldown + advisory lock no id novo (ocupado → volta pra pending com o id novo, devolve null). Nunca apaga cooldown alheio. sendflow_03.';

-- OBRIG 2 (rede final): POST 400 "conta não encontrada" → confirma ao vivo e reagenda com a conta atual
create or replace function public.sendflow_reagendar_conta_morta(p_id bigint, p_body jsonb default null)
returns boolean language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare it record; v_nova text;
begin
  select * into it from sendflow_envio_fila where id = p_id and status = 'sending' for update;
  if not found then return false; end if;
  begin
    perform pg_sleep(1);   -- 1 req/s: o POST acabou de sair
    v_nova := (sendflow_contas_da_release(it.release_id, interval '0'))[1];
  exception when others then v_nova := null;
  end;
  if v_nova is null or v_nova = it.account_id then return false; end if;
  update sendflow_envio_fila
     set status = 'pending', account_id = v_nova,
         account_id_original = coalesce(account_id_original, it.account_id),
         proximo_em = now() + interval '60 seconds', ultimo_erro = null,
         resolucao_nota = left('conta morta no envio (' || coalesce(p_body->>'message', '400') || '): ' || it.account_id || ' -> ' || v_nova || ', reagendado', 200)
   where id = p_id;
  return true;
end $$;
revoke execute on function public.sendflow_reagendar_conta_morta(bigint, jsonb) from public, anon, authenticated;
comment on function public.sendflow_reagendar_conta_morta(bigint, jsonb) is 'Depois de um POST 400 "Conta X não encontrada": confirma a conta ao vivo e, se mudou, devolve o lote pra pending com a conta nova (o claim re-gateia). false = não mudou (vira error normal). sendflow_03.';

do $$
declare v text;
  s_old text := $x$  else
    update sendflow_envio_fila set status='error', ultimo_erro='send '||v_send_status||' '||left((v_send->'body')::text,140) where id=it.id;
    return 'error '||v_send_status;
  end if;$x$;
  s_new text := $x$  else
    -- sendflow_03: conta morta no POST (chip trocado depois do cache): confirma ao vivo e reagenda
    if v_send_status = 400 and coalesce(v_send->'body'->>'message', '') ilike '%conta%encontrada%'
       and sendflow_reagendar_conta_morta(it.id, v_send->'body') then
      return 'conta morta no envio: reagendado com a conta atual';
    end if;
    update sendflow_envio_fila set status='error', ultimo_erro='send '||v_send_status||' '||left((v_send->'body')::text,140) where id=it.id;
    return 'error '||v_send_status;
  end if;$x$;
begin
  v := pg_get_functiondef('public.sendflow_send_lote'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'sendflow_03: ramo else em sendflow_send_lote: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;
