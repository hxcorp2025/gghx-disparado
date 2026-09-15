-- =====================================================================
-- lnk_27: aparelho / sistema / navegador a partir do UA + visitante hxv
-- PRD Links HX v2 (15/09/2026), F1 backend, complementos (a) e (b).
--
-- Antes: device/os/browser/ua_familia eram NULL em 100% das 14.603 linhas
-- (o Worker 1.1.0 nao parseava). O UA cru sempre esteve guardado, entao o
-- historico inteiro e reprocessavel. As regras vivem em DOIS lugares, na
-- mesma ordem: hx-links/src/index.js (parseUA) e aqui (lnk_parse_ua).
-- hx-links/scripts/testa-ua.mjs gera a fixture que confere a paridade.
-- =====================================================================

alter table public.lnk_cliques
  add column if not exists hxv text,
  add column if not exists hxv_novo boolean,
  add column if not exists ua_v smallint;

comment on column public.lnk_cliques.hxv is
  'cookie de 1a parte do visitante: uuid aleatorio, 1 ano, sem PII, host-only. Worker >= 1.2.0. Serve pra "pessoas" honestas e A/B por pessoa estavel.';
comment on column public.lnk_cliques.hxv_novo is
  'true quando o cookie nasceu neste acesso (1a visita, cookie apagado ou navegador que nao guarda cookie).';
comment on column public.lnk_cliques.ua_v is
  'versao das regras que preencheram ua_familia/device/os/browser (lnk_parse_ua). NULL = nunca parseado. Reprocessar: lnk_reclassificar_ua(versao).';

-- pessoas por link: count(distinct hxv) precisa disso quando a tabela crescer
create index if not exists lnk_cliques_link_hxv_idx
  on public.lnk_cliques (link_id, hxv) where hxv is not null;

-- ---------------------------------------------------------------------
-- Parse puro, imutavel, zero I/O. Mesma ordem do Worker.
-- Difere do JS so na sintaxe: \b vira \y no ARE do Postgres.
-- O UA moderno mente de proposito (reducao do Chrome): todo Android vira
-- "Android 10; K" e todo Windows "NT 10.0". Versao confiavel so no iOS e
-- nos in-app; a tela avisa isso.
-- ---------------------------------------------------------------------
create or replace function public.lnk_parse_ua(p_ua text)
returns jsonb
language plpgsql immutable
as $$
declare ua text := coalesce(p_ua, ''); v_os text; v_dev text; v_br text; v_fam text; m text[];
begin
  if ua = '' then
    return jsonb_build_object('ua_familia', null, 'device', null, 'os', null, 'browser', null);
  end if;
  if ua ~* 'facebookexternalhit|whatsapp|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|pinterest|redditbot|bingbot|googlebot|yandex|applebot|petalbot|ahrefs|semrush|bot\y|crawler|spider|preview|curl|wget|python-requests|axios|okhttp|headlesschrome|phantomjs|puppeteer' then
    return jsonb_build_object('ua_familia', 'robo', 'device', 'robo', 'os', null, 'browser', null);
  end if;

  -- sistema
  m := regexp_match(ua, '(?:iPhone|iPad|iPod).*?OS (\d+)[_.]');
  if m is not null then v_os := 'iOS ' || m[1];
  elsif ua ~* 'iPhone|iPad|iPod' then v_os := 'iOS';
  else
    m := regexp_match(ua, 'Android (\d+)', 'i');
    if m is not null then v_os := 'Android ' || m[1];
    elsif ua ~* 'Android' then v_os := 'Android';
    elsif ua ~* 'Windows NT|Windows' then v_os := 'Windows';
    elsif ua ~* 'Mac OS X|Macintosh' then v_os := 'macOS';
    elsif ua ~* 'CrOS' then v_os := 'ChromeOS';
    elsif ua ~* 'Linux|X11' then v_os := 'Linux';
    else v_os := 'outro';
    end if;
  end if;

  -- aparelho
  if ua ~* 'iPad|Tablet' or (ua ~* 'Android' and ua !~* 'Mobile') then v_dev := 'tablet';
  elsif ua ~* 'iPhone|iPod|Android|Mobile' then v_dev := 'celular';
  elsif ua ~* 'Windows|Macintosh|X11|Linux|CrOS' then v_dev := 'desktop';
  else v_dev := 'outro';
  end if;

  -- navegador: in-app ANTES do motor, senao Instagram viraria "Chrome"
  v_br := case
    when ua ~* 'Instagram' then 'Instagram'
    when ua ~* 'FBAN|FBAV|FB_IAB|FB4A|FBIOS' then 'Facebook'
    when ua ~* 'WA4A|WAiOS' then 'WhatsApp'
    when ua ~* 'TikTok|musical_ly|Bytedance' then 'TikTok'
    when ua ~* 'Telegram' then 'Telegram'
    when ua ~* 'Kwai' then 'Kwai'
    when ua ~* 'Snapchat' then 'Snapchat'
    when ua ~* '\yGSA/' then 'Google app'
    when ua ~* 'EdgiOS|EdgA|Edge?/' then 'Edge'
    when ua ~* 'OPR/|Opera|OPiOS|OPT/' then 'Opera'
    when ua ~* 'SamsungBrowser' then 'Samsung Internet'
    when ua ~* 'Firefox|FxiOS' then 'Firefox'
    when ua ~* 'CriOS|Chrome/|Chromium/' then 'Chrome'
    when ua ~* 'Version/[0-9.]+.*Safari/' then 'Safari'
    else 'outro' end;
  if v_br = 'Chrome' and ua ~* '; wv\)' then v_br := 'WebView Android'; end if;

  v_fam := case
    when ua ~* 'Instagram|FBAN|FBAV|FB_IAB|FB4A|FBIOS|WA4A|WAiOS|TikTok|musical_ly|Bytedance|Telegram|Kwai|Snapchat|\yGSA/' then 'in_app'
    when ua ~* 'Mozilla/' then 'navegador'
    else 'outro' end;

  return jsonb_build_object('ua_familia', v_fam, 'device', v_dev, 'os', v_os, 'browser', v_br);
end $$;
revoke execute on function public.lnk_parse_ua(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Backfill reprocessavel, por lote, idempotente: so toca linha com ua_v
-- abaixo da versao pedida. Nunca sobrescreve a classe (classificador_v e
-- outro dado). 404 antigos so tem o UA no payload; entra pelo coalesce.
-- ---------------------------------------------------------------------
create or replace function public.lnk_reclassificar_ua(p_versao smallint default 1, p_lote integer default 5000)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_n int := 0; v_total int := 0; v_rodadas int := 0; v_lote int := greatest(100, coalesce(p_lote, 5000));
begin
  loop
    update public.lnk_cliques c
       set ua_familia = a.p->>'ua_familia', device = a.p->>'device',
           os = a.p->>'os', browser = a.p->>'browser', ua_v = p_versao
      from (select id, ts, public.lnk_parse_ua(coalesce(ua, payload->>'ua')) as p
              from public.lnk_cliques
             where (ua_v is null or ua_v < p_versao)
               and coalesce(ua, payload->>'ua') is not null
             order by ts desc limit v_lote) a
     where c.id = a.id and c.ts = a.ts;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n; v_rodadas := v_rodadas + 1;
    exit when v_n < v_lote or v_rodadas >= 400;
  end loop;
  return jsonb_build_object('ok', true, 'versao', p_versao, 'linhas', v_total, 'rodadas', v_rodadas,
    'restam', (select count(*) from public.lnk_cliques
               where (ua_v is null or ua_v < p_versao) and coalesce(ua, payload->>'ua') is not null));
end $$;
revoke execute on function public.lnk_reclassificar_ua(smallint, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- lnk_contavel: expirado e inativo nao sao clique, como 404 nao e.
-- Universo do rateio continua sendo so gente.
-- ---------------------------------------------------------------------
create or replace function public.lnk_contavel(p_classe public.lnk_classe, p_motivo text[])
returns boolean
language sql immutable
as $$
  select p_classe = 'humano'
     and not (coalesce(p_motivo, '{}') && array['slug_inexistente', 'link_expirado', 'link_inativo', 'dominio_inativo']);
$$;

-- ---------------------------------------------------------------------
-- lnk_edge_clique v2: aceita hxv/hxv_novo/ua_v e, se o Worker nao mandou
-- aparelho (1.1.0 ainda no ar, ou linha de 404), parseia AQUI. Assim a
-- tela nunca depende do deploy do Worker pra ter aparelho preenchido.
-- ---------------------------------------------------------------------
create or replace function public.lnk_edge_clique(p_token text, p_evento jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare v_id uuid; v_ua text; v_p jsonb := '{}'::jsonb;
begin
  if public.lnk_edge_auth(p_token, 'clique') is null then
    return jsonb_build_object('ok', false, 'erro', 'nao_autorizado');
  end if;

  v_id := coalesce((p_evento->>'id')::uuid, gen_random_uuid());
  v_ua := coalesce(p_evento->>'ua', p_evento->'payload'->>'ua');
  if p_evento->>'device' is null and v_ua is not null then
    v_p := public.lnk_parse_ua(v_ua);
  end if;

  insert into public.lnk_cliques (
    id, ts, projeto_id, link_id, destino_id, dominio_id, url_id,
    host, slug, classe, classe_motivo, classificador_v,
    ip, ip_hash, ua, ua_familia, device, os, browser, ua_v,
    hxv, hxv_novo,
    referer, accept_language, pais, regiao, cidade, asn, as_org, colo,
    tls_version, http_protocol,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, utms_extra,
    fbclid, gclid, ttclid, kwai_click_id,
    campanha_ref, grupo_ref, cpu_us, kv_hit, fonte_destino, origem, worker_v,
    payload
  ) values (
    v_id,
    coalesce((p_evento->>'ts')::timestamptz, now()),
    nullif(p_evento->>'projeto_id','')::uuid,
    nullif(p_evento->>'link_id','')::uuid,
    nullif(p_evento->>'destino_id','')::uuid,
    nullif(p_evento->>'dominio_id','')::uuid,
    nullif(p_evento->>'url_id','')::uuid,
    p_evento->>'host', p_evento->>'slug',
    coalesce((p_evento->>'classe')::public.lnk_classe, 'desconhecido'),
    coalesce((select array_agg(x) from jsonb_array_elements_text(p_evento->'classe_motivo') x), '{}'),
    coalesce((p_evento->>'classificador_v')::smallint, 1),
    nullif(p_evento->>'ip','')::inet, p_evento->>'ip_hash',
    v_ua,
    coalesce(p_evento->>'ua_familia', v_p->>'ua_familia'),
    coalesce(p_evento->>'device',     v_p->>'device'),
    coalesce(p_evento->>'os',         v_p->>'os'),
    coalesce(p_evento->>'browser',    v_p->>'browser'),
    -- 1 = versao atual das regras (UA_V no Worker). Sobe junto com a regra.
    coalesce((p_evento->>'ua_v')::smallint, case when v_p <> '{}'::jsonb then 1::smallint end),
    nullif(p_evento->>'hxv',''), nullif(p_evento->>'hxv_novo','')::boolean,
    p_evento->>'referer', p_evento->>'accept_language',
    p_evento->>'pais', p_evento->>'regiao', p_evento->>'cidade',
    nullif(p_evento->>'asn','')::int, p_evento->>'as_org', p_evento->>'colo',
    p_evento->>'tls_version', p_evento->>'http_protocol',
    p_evento->>'utm_source', p_evento->>'utm_medium', p_evento->>'utm_campaign',
    p_evento->>'utm_content', p_evento->>'utm_term',
    coalesce(p_evento->'utms_extra', '{}'::jsonb),
    p_evento->>'fbclid', p_evento->>'gclid', p_evento->>'ttclid', p_evento->>'kwai_click_id',
    p_evento->>'campanha_ref', p_evento->>'grupo_ref',
    nullif(p_evento->>'cpu_us','')::int,
    nullif(p_evento->>'kv_hit','')::boolean,
    p_evento->>'fonte_destino',
    coalesce(nullif(p_evento->>'origem',''), 'worker'),
    p_evento->>'worker_v',
    -- GUARDAR TUDO: o evento cru inteiro, inclusive o que nao virou coluna
    coalesce(p_evento->'payload', p_evento)
  )
  on conflict (id, ts) do nothing;

  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
