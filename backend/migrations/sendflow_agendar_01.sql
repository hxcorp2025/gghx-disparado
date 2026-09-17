-- sendflow_agendar_01 (17/09/2026, noite BR): agendar disparo com dia e hora na Mesa de Disparo.
-- PRD: contexto/GESTOR_GRUPOS_HX/PRD_mesa_agendar_disparo_2026-09-17.md (decisões do Matheus 17/09).
--
-- Tese: a fila JÁ agenda. sendflow_claim_lote só pega pending com proximo_em <= now(); o reaper só
-- mexe em sending. O que travava era o clamp de 600 s em sendflow_disparar e a tela. Aqui:
--  1. coluna agendado_para (a hora escolhida; proximo_em é reescrito nas retentativas, não serve
--     de "hora agendada") + gids_removidos (grupos que sumiram entre agendar e enviar).
--  2. sendflow_disparar ganha p_agendar_para (5 min a 7 dias). Assinatura antiga DROPPADA e
--     recriada na mesma transação: o front antigo (7 chaves) continua funcionando porque o
--     parâmetro novo tem default.
--  3. sendflow_disparo_reagendar: muda a hora enquanto TODOS os lotes estão pending.
--  4. sendflow_disparos_listar: 1 linha por disparo (agendados, vivo, histórico) pro cartão
--     "Agendados" e pro painel vivo (a tela deixa de depender do localStorage de 1 id).
--  5. sendflow_disparo_status devolve agendado_para (partida_em segue = min proximo_em pending,
--     que é a verdade do worker).
--  6. sendflow_send_lote: SÓ o filtro de grupos sumidos antes do POST (cirúrgico; a resolução
--     de conta do hotfix sendflow_01/02/03 não é tocada).
--  7. sendflow_disparo_aviso + sendflow_agendado_avisar + sendflow_agendado_avisos_tick (cron 1 min):
--     "partiu" quando o 1º lote de um disparo agendado sai; "terminou" quando não resta fila.
--     HTTP só no tick, nunca no claim/envio. Grupo resolvido pelo NOME (Logs SendHX), via evo_api
--     (evolution.hx-corp.com), assinado, linkPreview false, retry 3x, dedup por (disparo, evento).
-- Rollback: `select def from sendflow_fn_backup where lote = 'agendar_01'` e executar cada def
-- (refazer revoke/grant: pg_get_functiondef não carrega ACL) + `cron.unschedule('sendflow_agendado_avisos_1min')`.

-- 0) backup das funções que mudam
insert into public.sendflow_fn_backup (lote, nome, def)
select 'agendar_01', f, pg_get_functiondef(('public.' || f)::regproc)
from unnest(array['sendflow_disparar', 'sendflow_disparo_status', 'sendflow_send_lote']) f;

-- 1) colunas
alter table public.sendflow_envio_fila
  add column if not exists agendado_para timestamptz,
  add column if not exists gids_removidos text[];
comment on column public.sendflow_envio_fila.agendado_para is
  'hora escolhida pelo operador ao agendar (agendar_01). proximo_em é a hora de trabalho do worker e é reescrito nas retentativas; a hora "de verdade" do agendamento é esta.';
comment on column public.sendflow_envio_fila.gids_removidos is
  'grupos tirados do lote na hora do envio porque sumiram (sendflow_grupo_estado.sumiu_em) entre agendar e enviar (agendar_01)';
create index if not exists sendflow_envio_fila_agendado_idx
  on public.sendflow_envio_fila (agendado_para) where agendado_para is not null;

-- 2) sendflow_disparar com p_agendar_para
drop function if exists public.sendflow_disparar(text[], bigint[], boolean, integer, integer, jsonb, integer);
create or replace function public.sendflow_disparar(
  p_gids text[], p_variacao_ids bigint[], p_mencao boolean default null,
  p_intervalo_min integer default 80, p_intervalo_max integer default 160,
  p_blocos jsonb default null, p_partida_em_s integer default 0,
  p_agendar_para timestamptz default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_disparo uuid := gen_random_uuid();
  v_email text := coalesce(auth.jwt()->>'email','painel');
  v_nvar int := array_length(p_variacao_ids,1);
  v_rows int := 0; v_grupos int := 0; v_ignorados text[];
  v_partida timestamptz;
  v_agendado timestamptz := null;
begin
  if not mod_is_operador() then raise exception 'nao autorizado'; end if;
  if v_nvar is null or v_nvar = 0 then raise exception 'sem variacoes'; end if;
  if array_length(p_gids,1) is null then raise exception 'sem grupos'; end if;
  if p_intervalo_min < 50 or p_intervalo_max < p_intervalo_min or p_intervalo_max > 600 then
    raise exception 'intervalo invalido (min>=50, min<=max<=600)';
  end if;

  -- agendar_01: hora marcada (5 min a 7 dias) OU partida curta (0 a 600 s, comportamento original)
  if p_agendar_para is not null then
    if p_agendar_para < now() + interval '5 minutes' then
      raise exception 'agendamento precisa ser pelo menos 5 minutos a frente';
    end if;
    if p_agendar_para > now() + interval '7 days' then
      raise exception 'agendamento no maximo 7 dias a frente';
    end if;
    v_partida := p_agendar_para;
    v_agendado := p_agendar_para;
  else
    if coalesce(p_partida_em_s,0) < 0 or coalesce(p_partida_em_s,0) > 600 then
      raise exception 'partida invalida (0 a 600 segundos)';
    end if;
    v_partida := now() + make_interval(secs => coalesce(p_partida_em_s,0));
  end if;

  if exists (select 1 from unnest(p_variacao_ids) vid
             left join hx_copy_variacoes v on v.id = vid
             where v.id is null or v.aprovada is not true) then
    raise exception 'variacao inexistente ou nao aprovada';
  end if;

  if p_blocos is not null then
    perform public.sendflow_blocos_resolver(p_blocos, 'probe');
  end if;

  with alvo as (
    select g.gid, g.release_id,
           p_variacao_ids[ 1 + ((row_number() over (order by g.release_id, g.numero_grupo nulls last, g.gid) - 1) % v_nvar) ] as variacao_id
    from sendflow_grupo_estado g
    where g.gid = any(p_gids) and g.sumiu_em is null
  ),
  agrupado as (
    select a.release_id, a.variacao_id, array_agg(a.gid order by a.gid) as gids
    from alvo a group by a.release_id, a.variacao_id
  ),
  contas as (
    -- sendflow_01: primeiro a conta associada à campanha (coletor/ao vivo), senão a última ação
    select distinct on (release_id) release_id, account_id from (
      select d.release_id, d.account_ids[1] as account_id, 0 as ordem
        from sendflow_releases_dim d where d.account_ids is not null and coalesce(d.account_ids[1], '') ~ '^[A-Za-z0-9_-]{6,64}$'
      union all
      select a.release_id, a.account_id, 1
        from (select distinct on (release_id) release_id, account_id
                from sendflow_acoes where account_id is not null
               order by release_id, criada_em desc nulls last) a
    ) u
    order by release_id, ordem
  )
  insert into sendflow_envio_fila(disparo_id, release_id, variacao_id, texto, mencao_todos, braco_ab, account_id, gids, criado_por, intervalo_min, intervalo_max, mensagens, proximo_em, agendado_para)
  select v_disparo, ag.release_id, ag.variacao_id, v.texto,
         coalesce(p_mencao, v.usa_mencao_todos), v.braco_ab, c.account_id, ag.gids, v_email, p_intervalo_min, p_intervalo_max,
         public.sendflow_blocos_resolver(p_blocos, v.texto), v_partida, v_agendado
  from agrupado ag
  join hx_copy_variacoes v on v.id = ag.variacao_id
  left join contas c on c.release_id = ag.release_id;

  get diagnostics v_rows = row_count;
  select coalesce(sum(cardinality(gids)),0) into v_grupos from sendflow_envio_fila where disparo_id = v_disparo;
  select coalesce(array_agg(x),'{}') into v_ignorados from unnest(p_gids) x
    where not exists (select 1 from sendflow_grupo_estado g where g.gid=x and g.sumiu_em is null);

  return jsonb_build_object('ok', true, 'disparo_id', v_disparo,
    'lotes', v_rows, 'grupos', v_grupos, 'variacoes', v_nvar,
    'mencao', p_mencao, 'intervalo_min', p_intervalo_min, 'intervalo_max', p_intervalo_max,
    'blocos', case when p_blocos is null then 0 else jsonb_array_length(p_blocos) end,
    'partida_em', v_partida, 'agendado_para', v_agendado,
    'ignorados', v_ignorados, 'ignorados_n', coalesce(cardinality(v_ignorados),0));
end $function$;

-- 3) mudar a hora de um disparo que ainda não saiu
create or replace function public.sendflow_disparo_reagendar(p_disparo uuid, p_quando timestamptz)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_n int; v_fora int;
begin
  if not mod_is_operador() then raise exception 'nao autorizado'; end if;
  if p_quando is null then raise exception 'sem hora'; end if;
  if p_quando < now() + interval '5 minutes' then
    raise exception 'agendamento precisa ser pelo menos 5 minutos a frente';
  end if;
  if p_quando > now() + interval '7 days' then
    raise exception 'agendamento no maximo 7 dias a frente';
  end if;
  -- só enquanto NENHUM lote saiu (sending/done/error/incerto) nem está pausado
  select count(*) into v_fora from sendflow_envio_fila
   where disparo_id = p_disparo and status not in ('pending','cancelled');
  if v_fora > 0 then
    return jsonb_build_object('ok', false, 'erro', 'Algum lote ja saiu ou esta pausado; agora so da pra cancelar o que falta.');
  end if;
  update sendflow_envio_fila
     set proximo_em = p_quando, agendado_para = p_quando
   where disparo_id = p_disparo and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'erro', 'Nenhum lote pendente neste disparo.');
  end if;
  return jsonb_build_object('ok', true, 'lotes', v_n, 'agendado_para', p_quando);
end $function$;

-- 4) lista de disparos (agendados, vivo, histórico) pro painel
create or replace function public.sendflow_disparos_listar(p_dias integer default 7)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v jsonb;
begin
  if not mod_is_operador() then raise exception 'nao autorizado'; end if;
  with d as (
    select f.disparo_id,
           min(f.criado_em) as criado_em,
           min(f.criado_por) as criado_por,
           max(f.agendado_para) as agendado_para,
           min(f.proximo_em) filter (where f.status = 'pending') as partida_em,
           count(*)::int as total,
           count(*) filter (where f.status = 'pending')::int as pending,
           count(*) filter (where f.status = 'paused')::int as paused,
           count(*) filter (where f.status = 'sending')::int as sending,
           count(*) filter (where f.status = 'done')::int as done,
           count(*) filter (where f.status in ('error','incerto'))::int as error,
           count(*) filter (where f.status = 'cancelled')::int as cancelled,
           coalesce(sum(cardinality(f.gids)),0)::int as grupos_total,
           coalesce(sum(cardinality(f.gids)) filter (where f.status = 'done'),0)::int as grupos_feitos,
           coalesce(sum(cardinality(f.gids_removidos)),0)::int as grupos_removidos,
           bool_or(f.mencao_todos) as mencao,
           min(f.intervalo_min) as intervalo_min,
           max(f.intervalo_max) as intervalo_max,
           max(case when f.mensagens is null then 0 else jsonb_array_length(f.mensagens) end) as blocos,
           array_agg(distinct f.release_id) as releases,
           array_agg(distinct f.variacao_id) as variacoes
    from sendflow_envio_fila f
    where f.criado_em >= now() - make_interval(days => greatest(1, least(coalesce(p_dias,7), 60)))
       or f.status in ('pending','paused','sending')
    group by f.disparo_id
  ),
  sit as (
    select d.*,
      case
        when d.cancelled = d.total then 'cancelado'
        when d.pending + d.paused + d.sending = 0 and d.error = 0 then 'entregue'
        when d.pending + d.paused + d.sending = 0 then 'erro'
        when d.done + d.sending + d.error = 0 and d.paused = 0 and d.partida_em > now() + interval '2 minutes' then 'agendado'
        when d.done + d.sending + d.error = 0 and d.paused = 0 then 'armado'
        else 'rodando'
      end as situacao
    from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'disparo_id', s.disparo_id,
      'situacao', s.situacao,
      'criado_em', s.criado_em,
      'criado_por', s.criado_por,
      'criado_por_nome', coalesce((select o.nome from painel_operadores o where o.email = s.criado_por limit 1), split_part(s.criado_por, '@', 1)),
      'agendado_para', s.agendado_para,
      'partida_em', s.partida_em,
      'resumo', jsonb_build_object(
        'total', s.total, 'pending', s.pending, 'paused', s.paused, 'sending', s.sending,
        'done', s.done, 'error', s.error, 'cancelled', s.cancelled,
        'grupos_total', s.grupos_total, 'grupos_feitos', s.grupos_feitos, 'grupos_removidos', s.grupos_removidos),
      'mencao', s.mencao,
      'intervalo_min', s.intervalo_min, 'intervalo_max', s.intervalo_max,
      'blocos', s.blocos,
      'campanhas', (select coalesce(jsonb_agg(coalesce(r.nome, left(x.rid, 8)) order by coalesce(r.nome, x.rid)), '[]'::jsonb)
                    from unnest(s.releases) x(rid) left join sendflow_releases_dim r on r.release_id = x.rid),
      'variacoes', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'fila_id', v.fila_id, 'idx', v.idx, 'angulo', v.angulo, 'origem', v.origem) order by v.fila_id, v.idx), '[]'::jsonb)
                    from hx_copy_variacoes v where v.id = any(s.variacoes)),
      'previa', (select left(regexp_replace(f2.texto, '\s+', ' ', 'g'), 140) from sendflow_envio_fila f2 where f2.disparo_id = s.disparo_id order by f2.id limit 1)
    ) order by
      case s.situacao when 'agendado' then 0 when 'armado' then 1 when 'rodando' then 2 else 3 end,
      case when s.situacao in ('agendado','armado','rodando') then s.partida_em end asc nulls last,
      s.criado_em desc), '[]'::jsonb)
  into v
  from (select * from sit order by criado_em desc limit 60) s;
  return v;
end $function$;

-- 5) status devolve agendado_para (partida_em continua sendo a verdade do worker)
create or replace function public.sendflow_disparo_status(p_disparo uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v jsonb;
begin
  if not mod_is_operador() then raise exception 'nao autorizado'; end if;
  select jsonb_build_object(
    'lotes', coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'release_id', f.release_id, 'braco_ab', f.braco_ab,
        'variacao_id', f.variacao_id, 'status', f.status,
        'n_gids', cardinality(f.gids),
        'n_removidos', coalesce(cardinality(f.gids_removidos), 0),
        'proximo_em', f.proximo_em, 'sending_em', f.sending_em, 'concluido_em', f.concluido_em,
        'ultimo_erro', f.ultimo_erro,
        'acao', case when a.action_id is null then null else jsonb_build_object(
          'processada', a.processada, 'sucesso', a.sucesso, 'erro', a.erro,
          'iniciada_em', a.iniciada_em, 'concluida_em', a.concluida_em) end
      ) order by f.id), '[]'::jsonb),
    'resumo', jsonb_build_object(
      'total', count(*),
      'pending', count(*) filter (where f.status='pending'),
      'paused', count(*) filter (where f.status='paused'),
      'sending', count(*) filter (where f.status='sending'),
      'done', count(*) filter (where f.status='done'),
      'error', count(*) filter (where f.status in ('error','incerto')),
      'cancelled', count(*) filter (where f.status='cancelled'),
      'grupos_total', coalesce(sum(cardinality(f.gids)),0),
      'grupos_feitos', coalesce(sum(cardinality(f.gids)) filter (where f.status='done'),0)),
    'partida_em', min(f.proximo_em) filter (where f.status='pending'),
    'agendado_para', max(f.agendado_para))
  into v
  from sendflow_envio_fila f
  left join sendflow_acoes a on a.action_id = f.action_id
  where f.disparo_id = p_disparo;
  return coalesce(v, jsonb_build_object('lotes','[]'::jsonb,'resumo',jsonb_build_object('total',0)));
end $function$;

-- 6) send_lote: grupo que sumiu entre agendar e enviar cai do lote (única mudança)
create or replace function public.sendflow_send_lote(p_id bigint)
returns text
language plpgsql security definer
set search_path to 'public', 'extensions'
set statement_timeout to '100s'
as $function$
declare it record; v_tpl jsonb; v_tpl_status int; v_template_id text;
        v_send jsonb; v_send_status int; v_action_id text; v_send_ok boolean := true; v_err text;
        v_template_arr jsonb;
        v_mortos text[]; v_vivos text[];
begin
  select * into it from sendflow_envio_fila where id=p_id and status='sending' for update;
  if not found then return 'lote nao esta em sending: '||coalesce(p_id::text,'null'); end if;

  -- sendflow_01/02: chip trocado no SendFlow tem id novo; o guardado no lote pode ter morrido.
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

  -- agendar_01: entre agendar e enviar o grupo pode ter sumido (ban/exclusão no SendFlow).
  -- Sai do lote antes do POST, fica registrado em gids_removidos. Lote sem grupo vivo é cancelado.
  select coalesce(array_agg(g order by g), '{}') into v_mortos
    from unnest(it.gids) g
   where exists (select 1 from sendflow_grupo_estado e where e.gid = g and e.sumiu_em is not null);
  if cardinality(v_mortos) > 0 then
    v_vivos := array(select g from unnest(it.gids) g where g <> all(v_mortos) order by g);
    if cardinality(v_vivos) = 0 then
      update sendflow_envio_fila
         set status='cancelled', gids_removidos=v_mortos, concluido_em=now(),
             ultimo_erro='todos os grupos do lote sumiram antes do envio'
       where id=it.id;
      return 'cancelado: todos os grupos sumiram';
    end if;
    update sendflow_envio_fila
       set gids=v_vivos, gids_removidos=v_mortos,
           resolucao_nota=left(coalesce(resolucao_nota||' | ','')||cardinality(v_mortos)||' grupo(s) sumiram antes do envio', 200)
     where id=it.id;
    select * into it from sendflow_envio_fila where id = p_id;
  end if;

  v_template_id := it.template_id;
  if v_template_id is null then
    -- monta o array (legado texto-só OU sequência de mídia via coluna mensagens)
    begin
      v_template_arr := sendflow_tpl_montar(it.mensagens, it.texto, it.mencao_todos);
    exception when others then
      update sendflow_envio_fila set status='error', ultimo_erro='mensagens invalidas: '||left(SQLERRM,140) where id=it.id;
      return 'mensagens invalidas';
    end;
    v_tpl := sendflow_api_post('/message-templates', jsonb_build_object(
      'title','HX '||left(it.disparo_id::text,8)||' v'||coalesce(it.variacao_id::text,'0'),
      'template', v_template_arr));
    v_tpl_status := (v_tpl->>'status')::int;
    if v_tpl_status not in (200,201) then
      update sendflow_envio_fila set
        status = case when tentativas>=5 and v_tpl_status not in (403,429) then 'error' else 'pending' end,
        proximo_em = now()+case when v_tpl_status in (403,429) then interval '61 minutes' else interval '5 minutes' end,
        ultimo_erro='template status '||v_tpl_status||' '||left((v_tpl->'body')::text,140)
      where id=it.id;
      return 'template falhou '||v_tpl_status;
    end if;
    v_template_id := coalesce(v_tpl->'body'->>'id', v_tpl->'body'->>'templateId');
    if v_template_id is null then
      update sendflow_envio_fila set status='error', ultimo_erro='template sem id: '||left((v_tpl->'body')::text,140) where id=it.id;
      return 'template sem id';
    end if;
    update sendflow_envio_fila set template_id=v_template_id where id=it.id;
  end if;

  -- PATH CORRETO: /actions/send-message-template com releaseId no body + chooseSpecificGroups/groupIds
  begin
    v_send := sendflow_api_post('/actions/send-message-template', jsonb_build_object(
      'releaseId', it.release_id,
      'accountId', it.account_id,
      'messageTemplateId', v_template_id,
      'chooseSpecificGroups', true,
      'groupIds', to_jsonb(it.gids),
      'options', jsonb_build_object('shippingSpeed','custom','customShippingSpeed', jsonb_build_object('min',it.intervalo_min,'max',it.intervalo_max))));
  exception when others then v_send_ok := false; v_err := SQLERRM; end;

  if not v_send_ok then
    update sendflow_envio_fila set status='incerto', ultimo_erro='excecao no send: '||left(v_err,140) where id=it.id;
    return 'incerto (excecao)';
  end if;
  v_send_status := (v_send->>'status')::int;

  if v_send_status in (200,201) then
    v_action_id := coalesce(v_send->'body'->>'id', v_send->'body'->>'actionId');
    if v_action_id is null then
      update sendflow_envio_fila set status='incerto', ultimo_erro='2xx sem action_id: '||left((v_send->'body')::text,140) where id=it.id;
      return 'incerto (2xx sem id)';
    end if;
    insert into sendflow_disparo_template(action_id, template_id, variacao_id, braco_ab, registrado_por, observacao)
    values (v_action_id, v_template_id, it.variacao_id, it.braco_ab, coalesce(it.criado_por,'painel'),
            'disparo '||left(it.disparo_id::text,8)||' • '||coalesce(cardinality(it.gids),0)||' grupos • ritmo '||it.intervalo_min||'-'||it.intervalo_max||'s'||
            case when it.mensagens is not null then ' • '||jsonb_array_length(it.mensagens)||' blocos (mídia)' else '' end);
    if it.variacao_id is not null then update hx_copy_variacoes set usada_em=now() where id=it.variacao_id and usada_em is null; end if;
    update sendflow_envio_fila set status='done', action_id=v_action_id, concluido_em=now(), ultimo_erro=null where id=it.id;
    return 'ok action '||v_action_id;
  elsif (v_send->'body'->>'code')='local-backoff' or v_send_status in (403,429) then
    update sendflow_envio_fila set status='pending', proximo_em=now()+interval '61 minutes', ultimo_erro='send recusado '||v_send_status where id=it.id;
    return 'recusado '||v_send_status;
  elsif v_send_status >= 500 then
    update sendflow_envio_fila set status='incerto', ultimo_erro='send 5xx: '||left((v_send->'body')::text,140) where id=it.id;
    return 'incerto 5xx';
  else
    -- sendflow_03: conta morta no POST (chip trocado depois do cache): confirma ao vivo e reagenda
    if v_send_status = 400 and coalesce(v_send->'body'->>'message', '') ilike '%conta%encontrada%'
       and sendflow_reagendar_conta_morta(it.id, v_send->'body') then
      return 'conta morta no envio: reagendado com a conta atual';
    end if;
    update sendflow_envio_fila set status='error', ultimo_erro='send '||v_send_status||' '||left((v_send->'body')::text,140) where id=it.id;
    return 'error '||v_send_status;
  end if;
end $function$;

-- 7) avisos "partiu" / "terminou" (WhatsApp, grupo Logs SendHX)
create table if not exists public.sendflow_disparo_aviso (
  id bigserial primary key,
  disparo_id uuid not null,
  evento text not null check (evento in ('partiu','terminou')),
  destino text not null,
  instancia text,
  ok boolean not null,
  http_status integer,
  resposta jsonb,
  texto text not null,
  enviado_em timestamptz not null default now()
);
comment on table public.sendflow_disparo_aviso is 'avisos de WhatsApp dos disparos agendados (agendar_01): 1 linha por tentativa; dedup = 1 ok por (disparo, evento)';
create unique index if not exists sendflow_disparo_aviso_ok_uq
  on public.sendflow_disparo_aviso (disparo_id, evento) where ok;
create index if not exists sendflow_disparo_aviso_disparo_idx on public.sendflow_disparo_aviso (disparo_id, evento);
alter table public.sendflow_disparo_aviso enable row level security;
revoke all on table public.sendflow_disparo_aviso from public, anon, authenticated;
revoke all on sequence public.sendflow_disparo_aviso_id_seq from public, anon, authenticated;

create or replace function public.sendflow_agendado_avisar(p_disparo uuid, p_evento text, p_destino text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  d record; v_inst text; v_gid text; v_num text; v_msg text; v_hora text; v_por text;
  v_camp text; v_res jsonb; v_status int := 0; v_try int := 0; v_ok boolean := false;
begin
  if p_evento not in ('partiu','terminou') then raise exception 'evento invalido'; end if;

  select
    max(f.agendado_para) as agendado_para,
    min(f.criado_por) as criado_por,
    count(*)::int as total,
    count(*) filter (where f.status = 'done')::int as done,
    count(*) filter (where f.status in ('error','incerto'))::int as error,
    count(*) filter (where f.status = 'cancelled')::int as cancelled,
    count(*) filter (where f.status in ('pending','paused','sending'))::int as abertos,
    coalesce(sum(cardinality(f.gids)),0)::int as grupos,
    coalesce(sum(cardinality(f.gids)) filter (where f.status = 'done'),0)::int as grupos_feitos,
    coalesce(sum(cardinality(f.gids_removidos)),0)::int as grupos_removidos,
    (select string_agg(distinct coalesce(r.nome, left(x.release_id, 8)), ', ')
       from sendflow_envio_fila x left join sendflow_releases_dim r on r.release_id = x.release_id
      where x.disparo_id = p_disparo) as campanhas,
    (select left(regexp_replace(x.texto, '\s+', ' ', 'g'), 90) from sendflow_envio_fila x
      where x.disparo_id = p_disparo order by x.id limit 1) as previa
  into d
  from sendflow_envio_fila f where f.disparo_id = p_disparo;
  if d.total is null or d.total = 0 then return jsonb_build_object('ok', false, 'erro', 'disparo nao encontrado'); end if;

  v_hora := to_char(coalesce(d.agendado_para, now()) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI');
  v_por := coalesce((select o.nome from painel_operadores o where o.email = d.criado_por limit 1), split_part(coalesce(d.criado_por,'painel'), '@', 1));
  v_camp := coalesce(d.campanhas, '?');

  if p_evento = 'partiu' then
    v_msg := '🗓️ Disparo agendado PARTIU' || E'\n'
          || 'Marcado pra ' || v_hora || ' · ' || d.grupos || ' grupos em ' || d.total || ' lotes' || E'\n'
          || 'Campanhas: ' || v_camp || E'\n'
          || 'Copy: ' || coalesce(d.previa, '') || E'\n'
          || 'Agendado por: ' || v_por || E'\n\n'
          || 'Cada lote vai pro motor do SendFlow na sua vez (um por chip). Aviso quando terminar.' || E'\n\n'
          || '⚡ Heimdall Claude HX';
  else
    v_msg := case when d.error > 0 then '⚠️ ' else '✅ ' end || 'Disparo agendado TERMINOU' || E'\n'
          || 'Marcado pra ' || v_hora || ' · ' || d.grupos_feitos || ' de ' || d.grupos || ' grupos entregues ao motor' || E'\n'
          || d.done || ' lotes ok · ' || d.error || ' com erro · ' || d.cancelled || ' cancelados'
          || case when d.grupos_removidos > 0 then ' · ' || d.grupos_removidos || ' grupo(s) sumiram antes do envio' else '' end || E'\n'
          || 'Campanhas: ' || v_camp || E'\n\n'
          || 'Entregue ao motor do SendFlow: o envio grupo a grupo segue o ritmo de lá.' || E'\n\n'
          || '⚡ Heimdall Claude HX';
  end if;

  -- instância conectada (barbosapersonal primeiro; nunca barbosa_pro) e o grupo pelo NOME
  select i.nome into v_inst from evo_instancias i
   where i.estado = 'open' and i.nome <> 'barbosa_pro'
   order by case i.nome when 'barbosapersonal' then 0 when 'cel_sorteio' then 1 else 9 end, i.nome
   limit 1;
  if v_inst is null then
    insert into sendflow_disparo_aviso(disparo_id, evento, destino, instancia, ok, texto, resposta)
    values (p_disparo, p_evento, coalesce(p_destino,'Logs SendHX'), null, false, v_msg, jsonb_build_object('erro','sem instancia conectada'));
    return jsonb_build_object('ok', false, 'erro', 'sem instancia conectada');
  end if;

  if p_destino is not null then
    v_num := p_destino; -- teste: número privado (ex.: 5551996064788)
  else
    select g.gid into v_gid from evo_grupos g where g.instancia = v_inst and g.assunto = 'Logs SendHX' limit 1;
    if v_gid is null then
      insert into sendflow_disparo_aviso(disparo_id, evento, destino, instancia, ok, texto, resposta)
      values (p_disparo, p_evento, 'Logs SendHX', v_inst, false, v_msg, jsonb_build_object('erro','grupo Logs SendHX nao encontrado na instancia'));
      return jsonb_build_object('ok', false, 'erro', 'grupo nao encontrado', 'instancia', v_inst);
    end if;
    v_num := v_gid || '@g.us';
  end if;

  loop
    v_try := v_try + 1;
    v_res := evo_api('POST', '/message/sendText/' || v_inst,
                     jsonb_build_object('number', v_num, 'text', v_msg, 'linkPreview', false));
    v_status := coalesce((v_res->>'status')::int, 0);
    v_ok := v_status in (200, 201);
    exit when v_ok or v_try >= 3;
    perform pg_sleep(2);
  end loop;

  insert into sendflow_disparo_aviso(disparo_id, evento, destino, instancia, ok, http_status, resposta, texto)
  values (p_disparo, p_evento, v_num, v_inst, v_ok, v_status, v_res, v_msg);
  return jsonb_build_object('ok', v_ok, 'status', v_status, 'destino', v_num, 'instancia', v_inst, 'tentativas', v_try);
end $function$;

create or replace function public.sendflow_agendado_avisos_tick()
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare d record; v_n int := 0; v_saida jsonb := '[]'::jsonb;
begin
  for d in
    select f.disparo_id,
           bool_or(f.status in ('sending','done','error','incerto')) as partiu,
           count(*) filter (where f.status in ('pending','paused','sending')) = 0 as terminou,
           count(*) filter (where f.status = 'cancelled') = count(*) as tudo_cancelado
      from sendflow_envio_fila f
     where f.agendado_para is not null
       and f.criado_em > now() - interval '14 days'
     group by f.disparo_id
  loop
    if d.partiu
       and not exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'partiu' and a.ok)
       and (select count(*) from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'partiu' and not a.ok) < 3 then
      v_saida := v_saida || jsonb_build_object('disparo', d.disparo_id, 'evento', 'partiu',
                                               'r', sendflow_agendado_avisar(d.disparo_id, 'partiu'));
      v_n := v_n + 1;
    end if;
    if d.partiu and d.terminou and not d.tudo_cancelado
       and exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'partiu' and a.ok)
       and not exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'terminou' and a.ok)
       and (select count(*) from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'terminou' and not a.ok) < 3 then
      v_saida := v_saida || jsonb_build_object('disparo', d.disparo_id, 'evento', 'terminou',
                                               'r', sendflow_agendado_avisar(d.disparo_id, 'terminou'));
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('avisos', v_n, 'detalhe', v_saida);
end $function$;

select cron.unschedule('sendflow_agendado_avisos_1min')
 where exists (select 1 from cron.job where jobname = 'sendflow_agendado_avisos_1min');
select cron.schedule('sendflow_agendado_avisos_1min', '* * * * *', $$select public.sendflow_agendado_avisos_tick()$$);

-- 8) ACL (lição lnk_36: o default privilege do Supabase dá EXECUTE a anon/authenticated em função nova)
revoke all on function public.sendflow_disparar(text[], bigint[], boolean, integer, integer, jsonb, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.sendflow_disparar(text[], bigint[], boolean, integer, integer, jsonb, integer, timestamptz) to authenticated, service_role;
revoke all on function public.sendflow_disparo_reagendar(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.sendflow_disparo_reagendar(uuid, timestamptz) to authenticated, service_role;
revoke all on function public.sendflow_disparos_listar(integer) from public, anon, authenticated;
grant execute on function public.sendflow_disparos_listar(integer) to authenticated, service_role;
revoke all on function public.sendflow_agendado_avisar(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sendflow_agendado_avisar(uuid, text, text) to service_role;
revoke all on function public.sendflow_agendado_avisos_tick() from public, anon, authenticated;
grant execute on function public.sendflow_agendado_avisos_tick() to service_role;

notify pgrst, 'reload schema';
