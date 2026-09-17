-- sendflow_agendar_02 (17/09/2026): as 7 CORREÇÕES OBRIGATÓRIAS do gate do agendamento.
-- Revisor (Engenheiro de Confiabilidade + Diretor de Dados) REPROVOU o agendar_01/01b.
-- Cada item abaixo tem o cenário de falha que ele reproduziu no banco com rollback.
--
-- 1. reagendar decidia sem travar a fila: o claim commitava 'sending' no meio (o tick usa dblink,
--    são DUAS transações), o UPDATE pulava o lote e a função devolvia {ok:true}. Disparo partia
--    em dois dias e o painel escondia o lote que já tinha saído. → for update nowait antes da guarda.
-- 2. retomar jogava o agendamento fora (proximo_em = now()): Agendados > Acompanhar > "Pausar o
--    que falta" > "Retomar" = disparo de sexta saindo na quarta, em 3 cliques, sem confirmação.
--    → retomar devolve pra hora marcada.
-- 3. gids_removidos era SOBRESCRITO a cada tentativa (403/429 = 61 min, template = 5 min, chip
--    ocupado): com 2 tentativas, grupo removido sumia da contabilidade e o aviso mentia o total.
--    → acumula ([[guardar_payload_completo]]).
-- 4. situacao mostrava "rodando" para disparo PAUSADO (tudo pausado, ou pausado + pendente):
--    o painel dizia que estava saindo e escondia o "Mudar horário". → estado 'pausado' de verdade.
--    🔴 sobe junto com o front (o mapa SITUACAO da tela precisa da chave nova).
-- 5. aviso "PARTIU" saía para disparo que NÃO partiu (lote que morre no claim, zero entrega).
--    → conta quantos lotes chegaram no motor e, se nenhum, a mensagem diz que não partiu.
-- 6. sem guarda de atraso: cooldown de ~62 min por lote no mesmo chip + backoff de 61 min + banco
--    fora do ar = agendado saindo horas depois, e a mensagem imprimia só a hora marcada.
--    → a mensagem conta o atraso real, e pendente com mais de 6h de atraso que NUNCA começou
--    é PAUSADO pra decisão humana (nunca cancelado, nada é destruído).
-- 7. o aviso morria com 3 minutos de Evolution fora: falha de infra gravava tentativa e o teto de
--    3 strikes queimava o orçamento em 3 ticks. → falha de infra não gasta tentativa, teto por
--    tempo (60 falhas reais de HTTP), e o grupo Logs SendHX só conta se estiver vivo.
--
-- Rollback: select def from sendflow_fn_backup where lote = 'agendar_02' (refazer revoke/grant).

insert into public.sendflow_fn_backup (lote, nome, def)
select 'agendar_02', f, pg_get_functiondef(('public.' || f)::regproc)
from unnest(array['sendflow_disparo_reagendar', 'sendflow_disparo_retomar', 'sendflow_send_lote',
                  'sendflow_disparos_listar', 'sendflow_agendado_avisar', 'sendflow_agendado_avisos_tick']) f;

-- ============ 1. reagendar trava os lotes antes de decidir ============
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

  -- agendar_02 (obrigatoria 1): trava os lotes ANTES de decidir. sendflow_claim_lote usa
  -- "for update skip locked": com a trava na mao ele PULA o lote; se ele chegou primeiro,
  -- o nowait estoura aqui e a gente recusa em vez de reagendar pela metade.
  begin
    perform 1 from sendflow_envio_fila where disparo_id = p_disparo for update nowait;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'erro',
      'O motor esta mexendo neste disparo agora. Tenta de novo em alguns segundos.');
  end;

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

-- ============ 2. retomar devolve pra HORA MARCADA, nao pra agora ============
create or replace function public.sendflow_disparo_retomar(p_disparo uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_n int;
begin
  if not mod_is_operador() then raise exception 'nao autorizado'; end if;
  -- agendar_02 (obrigatoria 2): retomar um disparo MARCADO volta pra hora marcada.
  -- Antes virava proximo_em = now() e o disparo de sexta saia na quarta.
  update sendflow_envio_fila
     set status='pending', proximo_em = greatest(now(), coalesce(agendado_para, now()))
   where disparo_id=p_disparo and status='paused';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'retomados', v_n);
end $function$;

-- ============ 4. situacao: estado 'pausado' de verdade ============
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
        -- agendar_02 (obrigatoria 4): disparo parado pela mao do operador e 'pausado'.
        -- Antes caia no else e a tela dizia "rodando" pra algo que nao estava saindo.
        when d.paused > 0 and d.sending = 0 and d.done + d.error = 0 then 'pausado'
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
      -- agendar_02: a tela precisa saber se o aviso do WhatsApp saiu (falha de aviso e silenciosa)
      'aviso_partiu_ok', exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = s.disparo_id and a.evento='partiu' and a.ok),
      'aviso_terminou_ok', exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = s.disparo_id and a.evento='terminou' and a.ok),
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
      case s.situacao when 'agendado' then 0 when 'armado' then 1 when 'pausado' then 2 when 'rodando' then 3 else 4 end,
      case when s.situacao in ('agendado','armado','pausado','rodando') then s.partida_em end asc nulls last,
      s.criado_em desc), '[]'::jsonb)
  into v
  -- agendar_02 (sugestao 1): disparo ABERTO nunca cai do limite, por mais antigo que seja
  from (select * from sit
         order by case when situacao in ('agendado','armado','pausado','rodando') then 0 else 1 end,
                  criado_em desc
         limit 60) s;
  return v;
end $function$;

-- ============ 3. send_lote acumula gids_removidos (resto byte-identico) ============
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
  -- agendar_02 (obrigatoria 3): ACUMULA. Cada retentativa pode remover mais gente; sobrescrever
  -- fazia o grupo removido na 1a tentativa evaporar da contabilidade e o aviso mentir o total.
  select coalesce(array_agg(g order by g), '{}') into v_mortos
    from unnest(it.gids) g
   where exists (select 1 from sendflow_grupo_estado e where e.gid = g and e.sumiu_em is not null);
  if cardinality(v_mortos) > 0 then
    v_vivos := array(select g from unnest(it.gids) g where g <> all(v_mortos) order by g);
    if cardinality(v_vivos) = 0 then
      update sendflow_envio_fila
         set status='cancelled',
             gids_removidos = coalesce(gids_removidos, '{}'::text[]) || v_mortos,
             concluido_em=now(),
             ultimo_erro='todos os grupos do lote sumiram antes do envio'
       where id=it.id;
      return 'cancelado: todos os grupos sumiram';
    end if;
    update sendflow_envio_fila
       set gids=v_vivos,
           gids_removidos = coalesce(gids_removidos, '{}'::text[]) || v_mortos,
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

-- ============ 5, 6a e 7: o aviso conta a verdade e nao morre por falha de infra ============
create or replace function public.sendflow_agendado_avisar(p_disparo uuid, p_evento text, p_destino text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  d record; v_inst text; v_gid text; v_num text; v_msg text; v_hora text; v_por text;
  v_camp text; v_res jsonb; v_status int := 0; v_try int := 0; v_ok boolean := false;
  v_atraso text := '';
begin
  if p_evento not in ('partiu','terminou') then raise exception 'evento invalido'; end if;
  if exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = p_disparo and a.evento = p_evento and a.ok) then
    return jsonb_build_object('ok', false, 'erro', 'ja avisado', 'dedup', true);
  end if;

  select
    max(f.agendado_para) as agendado_para,
    min(f.criado_por) as criado_por,
    count(*)::int as total,
    count(*) filter (where f.status = 'done')::int as done,
    count(*) filter (where f.status in ('error','incerto'))::int as error,
    count(*) filter (where f.status = 'cancelled')::int as cancelled,
    count(*) filter (where f.status in ('pending','paused','sending'))::int as abertos,
    -- agendar_02 (obrigatoria 5): quantos lotes REALMENTE chegaram no motor
    count(*) filter (where f.status in ('sending','done','incerto'))::int as no_motor,
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

  -- agendar_02 (obrigatoria 6a): a mensagem conta a hora REAL quando o disparo atrasou.
  -- Sem isto o operador lia "Marcado pra 09:00" as 23h e nao tinha como saber do atraso.
  v_atraso := case when d.agendado_para is not null and now() > d.agendado_para + interval '10 minutes'
    then ' ⚠️ SAINDO AGORA (' || to_char(now() at time zone 'America/Sao_Paulo','DD/MM HH24:MI')
         || ', ' || floor(extract(epoch from now() - d.agendado_para)/60)::int || ' min atrasado)'
    else '' end;

  if p_evento = 'partiu' then
    if d.no_motor = 0 then
      v_msg := '⛔ Disparo agendado NÃO partiu' || E'\n'
            || 'Marcado pra ' || v_hora || ' · nenhum lote chegou no motor do SendFlow' || E'\n'
            || 'Campanhas: ' || v_camp || E'\n'
            || d.error || ' lote(s) com erro · ' || d.cancelled || ' cancelados' || E'\n\n'
            || 'Abre a Mesa de Disparo pra ver o motivo. Nada foi enviado.' || E'\n\n'
            || '⚡ Heimdall Claude HX';
    else
      v_msg := '🗓️ Disparo agendado PARTIU' || E'\n'
            || 'Marcado pra ' || v_hora || v_atraso || ' · ' || d.grupos || ' grupos em ' || d.total || ' lotes' || E'\n'
            || 'Campanhas: ' || v_camp || E'\n'
            || 'Copy: ' || coalesce(d.previa, '') || E'\n'
            || 'Agendado por: ' || v_por || E'\n\n'
            || 'Cada lote vai pro motor do SendFlow na sua vez (um por chip). Aviso quando terminar.' || E'\n\n'
            || '⚡ Heimdall Claude HX';
    end if;
  else
    v_msg := case when d.error > 0 then '⚠️ ' else '✅ ' end || 'Disparo agendado TERMINOU' || E'\n'
          || 'Marcado pra ' || v_hora || v_atraso || ' · ' || d.grupos_feitos || ' de ' || d.grupos || ' grupos entregues ao motor' || E'\n'
          || d.done || ' lotes ok · ' || d.error || ' com erro · ' || d.cancelled || ' cancelados'
          || case when d.grupos_removidos > 0 then ' · ' || d.grupos_removidos || ' grupo(s) sumiram antes do envio' else '' end || E'\n'
          || 'Campanhas: ' || v_camp || E'\n\n'
          || 'Entregue ao motor do SendFlow: o envio grupo a grupo segue o ritmo de lá.' || E'\n\n'
          || '⚡ Heimdall Claude HX';
  end if;

  select i.nome into v_inst from evo_instancias i
   where i.estado = 'open' and i.nome <> 'barbosa_pro'
   order by case i.nome when 'barbosapersonal' then 0 when 'cel_sorteio' then 1 else 9 end, i.nome
   limit 1;
  -- agendar_02 (obrigatoria 7): falha de INFRA nao gasta tentativa. Antes, 3 minutos de
  -- Evolution fora (rotina) queimavam o orcamento de 3 strikes e o aviso morria pra sempre.
  if v_inst is null then
    return jsonb_build_object('ok', false, 'erro', 'sem instancia conectada', 'infra', true);
  end if;

  if p_destino is not null then
    v_num := p_destino; -- teste: numero privado (ex.: 5551996064788)
  else
    select g.gid into v_gid from evo_grupos g
     where g.instancia = v_inst and g.assunto = 'Logs SendHX' and g.sumiu_em is null limit 1;
    if v_gid is null then
      return jsonb_build_object('ok', false, 'erro', 'grupo Logs SendHX nao encontrado', 'instancia', v_inst, 'infra', true);
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

-- ============ 6b e 7: guarda de atraso + teto por tempo ============
create or replace function public.sendflow_agendado_avisos_tick()
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare d record; v_n int := 0; v_pausados int := 0; v_saida jsonb := '[]'::jsonb;
begin
  -- agendar_02 (obrigatoria 6b): agendado que passou 6h da hora marcada e NUNCA comecou vira
  -- 'paused' pra decisao humana. Nunca cancela (nada e destruido) e nao mexe na cauda de um
  -- disparo que ja comecou (essa serializa no chip de proposito: ~62 min por lote).
  update sendflow_envio_fila f
     set status='paused',
         ultimo_erro = left(coalesce(f.ultimo_erro||' | ','')
           ||'agendar_02: passou 6h da hora marcada sem o disparo comecar; pausado pra decisao humana', 200)
   where f.status='pending' and f.agendado_para is not null
     and now() > f.agendado_para + interval '6 hours'
     and not exists (select 1 from sendflow_envio_fila x
                      where x.disparo_id = f.disparo_id and x.status in ('sending','done'));
  get diagnostics v_pausados = row_count;

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
    -- teto por TEMPO (60 falhas reais de HTTP ~ 1h), nao 3 strikes: falha de infra nem chega aqui
    if d.partiu
       and not exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'partiu' and a.ok)
       and (select count(*) from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'partiu' and not a.ok) < 60 then
      v_saida := v_saida || jsonb_build_object('disparo', d.disparo_id, 'evento', 'partiu',
                                               'r', sendflow_agendado_avisar(d.disparo_id, 'partiu'));
      v_n := v_n + 1;
    end if;
    if d.partiu and d.terminou and not d.tudo_cancelado
       and exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'partiu' and a.ok)
       and not exists (select 1 from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'terminou' and a.ok)
       and (select count(*) from sendflow_disparo_aviso a where a.disparo_id = d.disparo_id and a.evento = 'terminou' and not a.ok) < 60 then
      v_saida := v_saida || jsonb_build_object('disparo', d.disparo_id, 'evento', 'terminou',
                                               'r', sendflow_agendado_avisar(d.disparo_id, 'terminou'));
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('avisos', v_n, 'pausados_por_atraso', v_pausados, 'detalhe', v_saida);
end $function$;

-- ACL (o default privilege do Supabase da EXECUTE pra anon/authenticated em funcao recriada)
revoke all on function public.sendflow_disparo_reagendar(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.sendflow_disparo_reagendar(uuid, timestamptz) to authenticated, service_role;
revoke all on function public.sendflow_disparo_retomar(uuid) from public, anon, authenticated;
grant execute on function public.sendflow_disparo_retomar(uuid) to authenticated, service_role;
revoke all on function public.sendflow_disparos_listar(integer) from public, anon, authenticated;
grant execute on function public.sendflow_disparos_listar(integer) to authenticated, service_role;
revoke all on function public.sendflow_agendado_avisar(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sendflow_agendado_avisar(uuid, text, text) to service_role;
revoke all on function public.sendflow_agendado_avisos_tick() from public, anon, authenticated;
grant execute on function public.sendflow_agendado_avisos_tick() to service_role;
revoke all on function public.sendflow_send_lote(bigint) from public, anon, authenticated;
grant execute on function public.sendflow_send_lote(bigint) to service_role, sendflow_dblink;

notify pgrst, 'reload schema';
