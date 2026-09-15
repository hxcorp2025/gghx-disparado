-- ⚠ Corrigida pela lnk_31 (gate de revisao 15/09/2026): este arquivo ja traz o texto final.
-- =====================================================================
-- lnk_29: detalhe por link (lnk_painel_link) e lista v2 (lnk_painel_listar)
-- PRD Links HX v2 (15/09/2026), F1 (d).
--
-- Contratos:
--  * "cliques" = so gente, so link no ar (lnk_contavel). Robo, 404,
--    expirado e pausado NUNCA somam em cliques; aparecem em caixas proprias.
--  * "pessoas" = cookie hxv (Worker >= 1.2.0). Sem cookie a caixa vem NULL,
--    nao zero ([[zero_ou_nao_preenchido]]).
--  * Serie e dimensoes em America/Sao_Paulo. Grao: hora ate 2 dias, dia acima.
--  * Toda metrica derivada do UA carrega a nota da reducao do Chrome.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Dimensao generica (top N) sobre os cliques contaveis de um link
-- ---------------------------------------------------------------------
create or replace function public.lnk_painel_dim(p_link_id uuid, p_de timestamptz, p_ate timestamptz, p_col text, p_top integer default 10)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_expr text; v_out jsonb;
begin
  v_expr := case p_col
    when 'device' then 'device' when 'os' then 'os' when 'browser' then 'browser'
    when 'ua_familia' then 'ua_familia' when 'pais' then 'pais' when 'regiao' then 'regiao'
    when 'cidade' then 'cidade' when 'host' then 'host'
    when 'utm_source' then 'utm_source' when 'utm_medium' then 'utm_medium'
    when 'utm_campaign' then 'utm_campaign' when 'utm_content' then 'utm_content' when 'utm_term' then 'utm_term'
    when 'referer_host' then $x$substring(referer from '^https?://([^/?#]+)')$x$
    else null end;
  if v_expr is null then raise exception 'dimensao desconhecida: %', p_col; end if;

  execute format($q$
    with base as (
      select %s as k from public.lnk_cliques c
       where c.link_id = $1 and c.ts >= $2 and c.ts < $3
         and public.lnk_contavel(c.classe, c.classe_motivo)),
    tot as (select count(*) n from base),
    top as (select coalesce(k, '(não informado)') k, count(*) n from base group by 1 order by 2 desc, 1 limit $4)
    select jsonb_build_object(
      'itens', coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n,
                 'pct', round(100.0 * n / nullif((select n from tot), 0), 1)) order by n desc, k) from top), '[]'::jsonb),
      'total', (select n from tot),
      'restantes', (select n from tot) - coalesce((select sum(n) from top), 0),
      'sem_valor', (select count(*) from base where k is null))
  $q$, v_expr) into v_out using p_link_id, p_de, p_ate, greatest(1, least(coalesce(p_top, 10), 50));
  return v_out;
end $$;
revoke execute on function public.lnk_painel_dim(uuid, timestamptz, timestamptz, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Detalhe por link
-- ---------------------------------------------------------------------
create or replace function public.lnk_painel_link(p_link_id uuid, p_de timestamptz default null, p_ate timestamptz default null, p_grao text default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_tz text := 'America/Sao_Paulo';
  v_link jsonb; v_de timestamptz; v_ate timestamptz; v_grao text; v_dur interval;
  v_kpis jsonb; v_serie jsonb; v_dest jsonb; v_dom jsonb; v_ult jsonb; v_hist jsonb;
  v_ant bigint; v_cliques bigint; v_hoje_ini timestamptz; v_fech timestamptz;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  v_link := public.lnk_link_snapshot(p_link_id);
  if v_link is null then return jsonb_build_object('ok', false, 'erro', 'Link não encontrado.'); end if;

  v_ate := coalesce(p_ate, now());
  v_de := coalesce(p_de, (((now() at time zone v_tz)::date - 6)::timestamp at time zone v_tz));
  if v_de >= v_ate then v_de := v_ate - interval '1 day'; end if;
  if v_ate - v_de > interval '92 days' then v_de := v_ate - interval '92 days'; end if;
  v_dur := v_ate - v_de;
  v_grao := case when p_grao in ('hora', 'dia') then p_grao
                 when v_dur <= interval '2 days 1 hour' then 'hora' else 'dia' end;
  v_hoje_ini := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;

  -- ---------- KPIs ----------
  select jsonb_build_object(
    'acessos', count(*),
    'cliques', count(*) filter (where public.lnk_contavel(classe, classe_motivo)),
    'robos', count(*) filter (where classe in ('crawler', 'bot')),
    'crawlers', count(*) filter (where classe = 'crawler'),
    'internos', count(*) filter (where classe = 'interno'),
    -- so gente e desconhecido: robo/interno num link pausado continua em robos/internos (revisao 15/09)
    'bloqueados', count(*) filter (where classe in ('humano', 'desconhecido')
                     and classe_motivo && array['link_expirado', 'link_inativo', 'dominio_inativo', 'slug_inexistente']),
    'nao_classificados', count(*) filter (where classe = 'desconhecido'
                     and not (classe_motivo && array['link_expirado', 'link_inativo', 'dominio_inativo', 'slug_inexistente'])),
    'pct_robo', round(100.0 * count(*) filter (where classe in ('crawler', 'bot')) / nullif(count(*), 0), 1),
    'pessoas', nullif(count(distinct hxv) filter (where public.lnk_contavel(classe, classe_motivo) and hxv is not null), 0),
    'cliques_com_cookie', count(*) filter (where public.lnk_contavel(classe, classe_motivo) and hxv is not null),
    'pct_com_cookie', round(100.0 * count(*) filter (where public.lnk_contavel(classe, classe_motivo) and hxv is not null)
                            / nullif(count(*) filter (where public.lnk_contavel(classe, classe_motivo)), 0), 1),
    'visitas_repetidas', count(*) filter (where public.lnk_contavel(classe, classe_motivo) and hxv_novo = false),
    'ips_distintos', count(distinct ip_hash) filter (where public.lnk_contavel(classe, classe_motivo) and ip_hash is not null),
    'cliques_hoje', count(*) filter (where public.lnk_contavel(classe, classe_motivo) and ts >= v_hoje_ini),
    'primeiro_clique', min(ts) filter (where public.lnk_contavel(classe, classe_motivo)),
    'ultimo_clique', max(ts) filter (where public.lnk_contavel(classe, classe_motivo)),
    'completude', jsonb_build_object(
      'aparelho', round(100.0 * count(*) filter (where public.lnk_contavel(classe, classe_motivo) and device is not null)
                        / nullif(count(*) filter (where public.lnk_contavel(classe, classe_motivo)), 0), 1),
      'cidade', round(100.0 * count(*) filter (where public.lnk_contavel(classe, classe_motivo) and cidade is not null)
                      / nullif(count(*) filter (where public.lnk_contavel(classe, classe_motivo)), 0), 1),
      'referer', round(100.0 * count(*) filter (where public.lnk_contavel(classe, classe_motivo) and referer is not null)
                       / nullif(count(*) filter (where public.lnk_contavel(classe, classe_motivo)), 0), 1),
      'cookie', round(100.0 * count(*) filter (where public.lnk_contavel(classe, classe_motivo) and hxv is not null)
                      / nullif(count(*) filter (where public.lnk_contavel(classe, classe_motivo)), 0), 1)))
    into v_kpis
  from public.lnk_cliques c
  where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_ate;

  -- variacao so entre janelas FECHADAS: exclui o dia em curso dos dois lados, senao
  -- "hoje pela metade" contra "ontem inteiro" sai negativo o dia todo (revisao 15/09)
  v_fech := least(v_ate, v_hoje_ini);
  if v_fech > v_de then
    select count(*) into v_cliques from public.lnk_cliques c
     where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_fech
       and public.lnk_contavel(c.classe, c.classe_motivo);
    select count(*) into v_ant from public.lnk_cliques c
     where c.link_id = p_link_id and c.ts >= v_de - (v_fech - v_de) and c.ts < v_de
       and public.lnk_contavel(c.classe, c.classe_motivo);
  else
    v_cliques := null; v_ant := null;
  end if;
  v_kpis := v_kpis || jsonb_build_object(
    'cliques_periodo_fechado', v_cliques,
    'cliques_periodo_anterior', v_ant,
    'base_variacao', case when v_fech > v_de then 'dias completos (exclui hoje)' else 'sem dia completo no período' end,
    'periodo_parcial', v_ate > v_hoje_ini,
    'variacao_pct', case when v_ant > 0 then round(100.0 * (v_cliques - v_ant) / v_ant, 1) end);

  -- ---------- serie ----------
  if v_grao = 'hora' then
    select coalesce(jsonb_agg(jsonb_build_object(
             't', to_char(g.b, 'YYYY-MM-DD"T"HH24:MI'),
             'acessos', coalesce(s.a, 0), 'cliques', coalesce(s.h, 0), 'robos', coalesce(s.r, 0),
             'parcial', g.b = date_trunc('hour', now() at time zone v_tz)) order by g.b), '[]'::jsonb)
      into v_serie
    from generate_series(date_trunc('hour', v_de at time zone v_tz), date_trunc('hour', (v_ate - interval '1 second') at time zone v_tz), interval '1 hour') g(b)
    left join (select date_trunc('hour', ts at time zone v_tz) b, count(*) a,
                      count(*) filter (where public.lnk_contavel(classe, classe_motivo)) h,
                      count(*) filter (where classe in ('crawler', 'bot')) r
               from public.lnk_cliques c
               where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_ate
               group by 1) s on s.b = g.b;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             't', to_char(g.b, 'YYYY-MM-DD'),
             'acessos', coalesce(s.a, 0), 'cliques', coalesce(s.h, 0), 'robos', coalesce(s.r, 0),
             'parcial', g.b = date_trunc('day', now() at time zone v_tz)) order by g.b), '[]'::jsonb)
      into v_serie
    from generate_series(date_trunc('day', v_de at time zone v_tz), date_trunc('day', (v_ate - interval '1 second') at time zone v_tz), interval '1 day') g(b)
    left join (select date_trunc('day', ts at time zone v_tz) b, count(*) a,
                      count(*) filter (where public.lnk_contavel(classe, classe_motivo)) h,
                      count(*) filter (where classe in ('crawler', 'bot')) r
               from public.lnk_cliques c
               where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_ate
               group by 1) s on s.b = g.b;
  end if;

  -- ---------- destinos: peso configurado x real (janela desde a ultima mudanca de peso) ----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'rotulo', coalesce(d.rotulo, left(d.url, 60)), 'url', d.url, 'ativo', d.is_active,
           'peso', coalesce(d.peso_efetivo, d.peso), 'peso_base', d.peso,
           'pct_configurado', case when d.is_active then round(100.0 * greatest(coalesce(d.peso_efetivo, d.peso), 0) / nullif(w.soma, 0), 1) end,
           'cliques', k.n_periodo, 'cliques_janela', k.n_janela,
           'pct_real', case when t.total > 0 then round(100.0 * k.n_janela / t.total, 1) end,
           'margem_pp', case when t.total > 0 and w.soma > 0 and d.is_active
             then round((1.96 * sqrt((greatest(coalesce(d.peso_efetivo, d.peso), 0)::numeric / w.soma)
                  * (1 - greatest(coalesce(d.peso_efetivo, d.peso), 0)::numeric / w.soma) / t.total) * 100)::numeric, 1) end,
           'desde', w.janela, 'janela_truncada', w.janela > v_de,
           'comparavel', w.vivos > 1 and t.total >= 30) order by d.ordem, d.created_at), '[]'::jsonb)
    into v_dest
  from public.lnk_destinos d
  join lateral (
    -- so conta mudanca de verdade: destino nunca editado tem updated_at = created_at (sugestao 1)
    select greatest(v_de, coalesce(max(d2.updated_at) filter (where d2.updated_at > d2.created_at), v_de)) janela,
           sum(greatest(coalesce(d2.peso_efetivo, d2.peso), 0)) filter (where d2.is_active)::numeric soma,
           count(*) filter (where d2.is_active and coalesce(d2.peso_efetivo, d2.peso) > 0) vivos
    from public.lnk_destinos d2 where d2.link_id = p_link_id) w on true
  join lateral (
    select count(*) filter (where public.lnk_contavel(c.classe, c.classe_motivo) and c.ts >= w.janela) total
    from public.lnk_cliques c where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_ate) t on true
  left join lateral (
    select count(*) filter (where public.lnk_contavel(c.classe, c.classe_motivo)) n_periodo,
           count(*) filter (where public.lnk_contavel(c.classe, c.classe_motivo) and c.ts >= w.janela) n_janela
    from public.lnk_cliques c where c.link_id = p_link_id and c.destino_id = d.id and c.ts >= v_de and c.ts < v_ate) k on true
  where d.link_id = p_link_id;

  -- ---------- por dominio (URL curta) ----------
  select coalesce(jsonb_agg(jsonb_build_object('host', host, 'slug', slug, 'acessos', a, 'cliques', h, 'robos', r, 'ultimo', u)
           order by h desc), '[]'::jsonb) into v_dom
  from (select host, slug, count(*) a,
               count(*) filter (where public.lnk_contavel(classe, classe_motivo)) h,
               count(*) filter (where classe in ('crawler', 'bot')) r,
               max(ts) filter (where public.lnk_contavel(classe, classe_motivo)) u
        from public.lnk_cliques c where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_ate
        group by host, slug) s;

  -- ---------- ultimos acessos (todas as classes, pra depurar) ----------
  select coalesce(jsonb_agg(x order by x->>'ts' desc), '[]'::jsonb) into v_ult
  from (select jsonb_build_object(
          'id', c.id, 'ts', c.ts, 'classe', c.classe, 'motivos', to_jsonb(c.classe_motivo),
          'contavel', public.lnk_contavel(c.classe, c.classe_motivo),
          'device', c.device, 'os', c.os, 'browser', c.browser, 'familia', c.ua_familia,
          'cidade', c.cidade, 'regiao', c.regiao, 'pais', c.pais,
          'referer', substring(c.referer from '^https?://([^/?#]+)'),
          'destino', coalesce(d.rotulo, left(d.url, 50)),
          'utm_source', c.utm_source, 'utm_campaign', c.utm_campaign, 'utm_content', c.utm_content,
          'host', c.host, 'slug', c.slug, 'cookie', case when c.hxv is null then null when c.hxv_novo then 'novo' else 'volta' end,
          'worker_v', c.worker_v, 'fonte', c.fonte_destino) x
        from public.lnk_cliques c left join public.lnk_destinos d on d.id = c.destino_id
        where c.link_id = p_link_id and c.ts >= v_de and c.ts < v_ate
        order by c.ts desc limit 30) s;

  -- ---------- historico ----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', h.id, 'acao', h.acao, 'campos', to_jsonb(h.campos), 'por', h.por_email, 'em', h.em,
           'resumo', case h.acao
             when 'criado' then 'Link criado'
             when 'editado' then 'Editou: ' || array_to_string(h.campos, ', ')
             when 'estado' then 'Estado: ' || coalesce(h.campos[1], '?')
             when 'slug' then 'Slug em ' || coalesce(h.campos[1], '?') || ': ' || coalesce(h.campos[2], '?')
             else h.acao end,
           'antes', case when h.acao = 'editado' then (select jsonb_object_agg(k, h.antes->k) from unnest(h.campos) k where h.antes ? k) end,
           'depois', case when h.acao = 'editado' then (select jsonb_object_agg(k, h.depois->k) from unnest(h.campos) k where h.depois ? k) end)
           order by h.em desc), '[]'::jsonb) into v_hist
  from (select * from public.lnk_link_historico where link_id = p_link_id order by em desc limit 30) h;

  return jsonb_build_object(
    'ok', true,
    'link', v_link,
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate, 'grao', v_grao, 'tz', v_tz,
                                  'dias', round(extract(epoch from v_dur) / 86400.0, 2)),
    'kpis', v_kpis,
    'serie', v_serie,
    'por_aparelho', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'device', 10),
    'por_sistema', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'os', 10),
    'por_navegador', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'browser', 10),
    'por_familia', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'ua_familia', 10),
    'por_pais', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'pais', 10),
    'por_regiao', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'regiao', 10),
    'por_cidade', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'cidade', 10),
    'por_referer', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'referer_host', 10),
    'por_utm', jsonb_build_object(
      'source', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'utm_source', 10),
      'medium', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'utm_medium', 10),
      'campaign', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'utm_campaign', 10),
      'content', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'utm_content', 10),
      'term', public.lnk_painel_dim(p_link_id, v_de, v_ate, 'utm_term', 10)),
    'por_destino', v_dest,
    'por_dominio', v_dom,
    'ultimos_acessos', v_ult,
    'historico', v_hist,
    'frescor', jsonb_build_object(
      'ultimo_evento', (select max(ts) from public.lnk_cliques where link_id = p_link_id),
      'agora', now()),
    'notas', jsonb_build_object(
      'cliques', 'Cliques = só gente, com o link no ar. Robô, link pausado ou expirado nunca entram aqui.',
      'pessoas', 'Pessoas = cookie de 1ª parte (hxv), válido por 1 ano. Só existe a partir do Worker 1.2.0; antes disso a caixa fica vazia, não zero. Quem apaga cookie ou usa navegador que não guarda vira pessoa nova.',
      'ips', 'IP distinto não é pessoa: operadora de celular junta muita gente num IP (CGNAT) e troca o IP da mesma pessoa várias vezes ao dia. Serve de piso.',
      'robos', 'Robô = crawler de preview (WhatsApp, Meta, Telegram) e bots. O crawler do WhatsApp abre o link enquanto a pessoa ainda está digitando.',
      'bloqueados', 'Bloqueados = acessos com o link expirado ou pausado. A pessoa foi pro destino de expirado ou pra página do domínio.',
      'aparelho', 'Aparelho, sistema e navegador vêm do user agent. O Chrome moderno esconde a versão real: "Android 10" e "Windows" podem ser qualquer versão. iOS e navegadores in-app (Instagram, Facebook, WhatsApp) dizem a verdade.',
      'referer', 'Sem referer é normal: Instagram, Facebook e WhatsApp in-app quase nunca informam de onde a pessoa veio. Não é erro de rastreio.',
      'destinos', 'Peso real × configurado compara só os cliques depois da última mudança de peso (janela truncada). Diferença dentro da margem não é desvio.',
      'variacao', 'Variação compara com o período imediatamente anterior, de mesma duração.'));
end $$;
revoke execute on function public.lnk_painel_link(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.lnk_painel_link(uuid, timestamptz, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Lista v2. Assinatura antiga (3 parametros) sai pra nao deixar o
-- PostgREST em duvida; os 3 primeiros continuam iguais, o front atual
-- segue funcionando.
-- ---------------------------------------------------------------------
drop function if exists public.lnk_painel_listar(text, text, integer);

create or replace function public.lnk_painel_listar(
  p_busca text default null, p_projeto text default null, p_limite integer default 60,
  p_ordem text default 'recentes', p_tag text default null, p_estado text default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_tz text := 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_7d timestamptz; v_hoje_ini timestamptz;
  v_busca text := nullif(trim(coalesce(p_busca, '')), '');
  v_tag text := nullif(lower(trim(coalesce(p_tag, ''))), '');
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  v_7d := ((v_hoje - 6)::timestamp at time zone v_tz);
  v_hoje_ini := (v_hoje::timestamp at time zone v_tz);

  return coalesce((
    select jsonb_agg(x order by rn)
    from (
      select x, row_number() over (order by
               case when p_ordem = 'cliques' then -(x->>'cliques_7d')::int end,
               case when p_ordem = 'nome' then lower(x->>'nome') end,
               case when p_ordem = 'ultimo' then (x->>'ultimo_clique')::timestamptz end desc nulls last,
               (x->>'criado_em')::timestamptz desc) rn
      from (
        select jsonb_build_object(
          'id', l.id, 'nome', l.nome, 'projeto', pr.slug,
          'divisao', l.divisao, 'ativo', l.is_active, 'congelado', l.congelado,
          'estado', case when not l.is_active then 'pausado'
                         when l.expira_em is not null and l.expira_em < now() then 'expirado'
                         when l.congelado then 'congelado' else 'ativo' end,
          'expira_em', l.expira_em, 'tags', to_jsonb(l.tags), 'observacao', l.observacao,
          'protegido', exists (select 1 from public.lnk_urls u where u.link_id = l.id and u.protegida),
          'criado_em', l.created_at,
          'url_curta', (select 'https://' || dm.hostname || '/' || u.slug
                        from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
                        where u.link_id = l.id and u.is_active and dm.status = 'ativo'
                        order by dm.no_rodizio, dm.hostname limit 1),
          'destinos', (select jsonb_agg(jsonb_build_object(
                         'id', d.id, 'url', d.url, 'rotulo', d.rotulo, 'peso', d.peso,
                         'peso_efetivo', d.peso_efetivo, 'ativo', d.is_active,
                         'pct', case when not d.is_active then null
                               when (select sum(greatest(coalesce(d2.peso_efetivo, d2.peso), 0))
                                     from public.lnk_destinos d2 where d2.link_id = l.id and d2.is_active) > 0
                               then round(100.0 * greatest(coalesce(d.peso_efetivo, d.peso), 0) /
                                    (select sum(greatest(coalesce(d2.peso_efetivo, d2.peso), 0))
                                     from public.lnk_destinos d2 where d2.link_id = l.id and d2.is_active), 1) end)
                       order by d.ordem)
                       from public.lnk_destinos d where d.link_id = l.id),
          'params', (select jsonb_agg(jsonb_build_object('chave', p.chave, 'valor', p.valor,
                                                         'destino_id', p.destino_id) order by p.ordem)
                     from public.lnk_params p where p.link_id = l.id),
          'urls', (select jsonb_agg(jsonb_build_object('url', 'https://' || dm.hostname || '/' || u.slug,
                                                       'dominio', dm.hostname, 'slug', u.slug, 'estado', dm.status,
                                                       'entregas', u.entregas, 'protegida', u.protegida))
                   from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
                   where u.link_id = l.id and u.is_active),
          'cliques_7d', (select count(*) from public.lnk_cliques c
                         where c.link_id = l.id and c.ts >= v_7d
                           and public.lnk_contavel(c.classe, c.classe_motivo)),
          'acessos_7d', (select count(*) from public.lnk_cliques c
                         where c.link_id = l.id and c.ts >= v_7d),
          'cliques_hoje', (select count(*) from public.lnk_cliques c
                           where c.link_id = l.id and c.ts >= v_hoje_ini
                             and public.lnk_contavel(c.classe, c.classe_motivo)),
          'cliques_total', (select count(*) from public.lnk_cliques c
                            where c.link_id = l.id and public.lnk_contavel(c.classe, c.classe_motivo)),
          'pessoas_7d', (select nullif(count(distinct c.hxv), 0) from public.lnk_cliques c
                         where c.link_id = l.id and c.ts >= v_7d and c.hxv is not null
                           and public.lnk_contavel(c.classe, c.classe_motivo)),
          'sparkline_7d', (select jsonb_agg(coalesce(s.n, 0) order by g.d)
                           from generate_series(v_hoje - 6, v_hoje, interval '1 day') g(d)
                           left join (select (c.ts at time zone v_tz)::date d, count(*) n
                                      from public.lnk_cliques c
                                      where c.link_id = l.id and c.ts >= v_7d
                                        and public.lnk_contavel(c.classe, c.classe_motivo)
                                      group by 1) s on s.d = g.d::date),
          'ultimo_clique', (select max(c.ts) from public.lnk_cliques c
                            where c.link_id = l.id
                              and public.lnk_contavel(c.classe, c.classe_motivo)),
          'sem_braco', not exists (select 1 from public.lnk_params p
                                   where p.link_id = l.id and lower(p.chave) = 'utm_content')
                       and not exists (select 1 from public.lnk_destinos d
                                       where d.link_id = l.id and d.url ilike '%utm_content=%')
        ) as x
        from public.lnk_links l join public.lnk_projetos pr on pr.id = l.projeto_id
        where (p_projeto is null or pr.slug = p_projeto)
          and (v_busca is null
               or l.nome ilike '%' || v_busca || '%'
               or exists (select 1 from public.lnk_urls u where u.link_id = l.id and u.slug ilike '%' || v_busca || '%')
               or exists (select 1 from public.lnk_destinos d where d.link_id = l.id and d.url ilike '%' || v_busca || '%')
               or exists (select 1 from unnest(l.tags) t where t ilike '%' || v_busca || '%'))
          and (v_tag is null or v_tag = any (l.tags))
          and (p_estado is null or p_estado = case when not l.is_active then 'pausado'
                         when l.expira_em is not null and l.expira_em < now() then 'expirado'
                         when l.congelado then 'congelado' else 'ativo' end)
      ) s0
      order by rn
      limit greatest(1, least(coalesce(p_limite, 60), 200))
    ) s), '[]'::jsonb);
end $$;
revoke execute on function public.lnk_painel_listar(text, text, integer, text, text, text) from public, anon;
grant execute on function public.lnk_painel_listar(text, text, integer, text, text, text) to authenticated, service_role;

-- tags existentes no projeto (pro filtro da lista)
create or replace function public.lnk_painel_tags(p_projeto text default null)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select case when public.mod_is_operador() then
    coalesce((select jsonb_agg(jsonb_build_object('tag', t, 'n', n) order by n desc, t)
              from (select t, count(*) n
                    from public.lnk_links l join public.lnk_projetos pr on pr.id = l.projeto_id, unnest(l.tags) t
                    where p_projeto is null or pr.slug = p_projeto
                    group by t) s), '[]'::jsonb)
  else null end
$$;
revoke execute on function public.lnk_painel_tags(text) from public, anon;
grant execute on function public.lnk_painel_tags(text) to authenticated, service_role;
