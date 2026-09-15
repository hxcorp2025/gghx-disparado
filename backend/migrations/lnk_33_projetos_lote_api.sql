-- lnk_33 (15/09/2026, F3 do PRD Links v2): projetos, criação em lote e API com chave.
--
-- Direção do Matheus (15/09 19h20): a aba Links é ferramenta à parte, pra TODOS os
-- projetos da HX, e todo link novo nasce nela. Até aqui só existia o projeto
-- `hx-geral`, o editor não escolhia projeto e o domínio institucional estava
-- amarrado a esse projeto (link criado em outro projeto nasceria SEM endereço).
--
-- O que entra:
--   1. projetos: seed (pdm, ja, sortudao, lcy), `l.hx-corp.com` vira global,
--      domínio novo nasce global, `lnk_projetos_listar` / `lnk_projeto_criar`,
--      `lnk_link_editar` aceita `projeto` no patch (move o link e sincroniza URLs).
--   2. gate compartilhado `lnk_pode()`: operador do painel OU chamada de API
--      autenticada por token (flag `lnk.api` local à transação, só quem seta é
--      `lnk_api_*` depois de validar o token). Trocado nas RPCs que a API usa.
--   3. histórico grava o ator da API (`api:<nome da chave>`) quando não há JWT.
--   4. chaves de API em `lnk_edge_tokens` (escopos api:criar / api:ler / api:editar):
--      `lnk_token_criar` (devolve a chave UMA vez), `lnk_tokens_listar`,
--      `lnk_token_revogar` (nunca a do redirecionador), `lnk_api_auth` (conta uso).
--   5. `lnk_api_criar` / `lnk_api_ler` / `lnk_api_listar` / `lnk_api_editar`:
--      chamadas com a anon key + token; sem service_role. Toda resposta é JSON
--      {ok, ...}; erro de token = {ok:false, erro:'nao_autorizado'}.
--   6. `lnk_criar_lote(p_projeto, p_linhas, p_dry, p_defaults)`: até 500 linhas,
--      valida linha a linha (dry) e cria as válidas uma a uma em subtransação
--      (uma linha ruim não derruba as outras). A tela manda 50 por chamada.
--
-- Padrão da casa pra mexer em função existente: reescrita textual sobre
-- pg_get_functiondef com contagem de ocorrências (0 ou 2+ = aborta sem mexer).

create function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

-- ---------------------------------------------------------------------------
-- 1. projetos
-- ---------------------------------------------------------------------------
insert into public.lnk_projetos (slug, nome) values
  ('pdm', 'Pix do Milhão'), ('ja', 'JA Educação'), ('sortudao', 'Sortudão'), ('lcy', 'Lucrando com YouTube')
on conflict (slug) do nothing;

-- domínio institucional serve a todos os projetos (projeto_id null = global)
update public.lnk_dominios set projeto_id = null where hostname = 'l.hx-corp.com';

-- domínio novo nasce global (antes: preso ao hx-geral)
do $$
declare v text; s_old text := $x$p_projeto text DEFAULT 'hx-geral'::text$x$; s_new text := $x$p_projeto text DEFAULT NULL::text$x$;
begin
  v := pg_get_functiondef('public.lnk_dominio_cadastrar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_33: default de lnk_dominio_cadastrar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

create or replace function public.lnk_projetos_listar()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'slug', p.slug, 'nome', p.nome, 'ativo', p.is_active, 'rodizio_minimo', p.rodizio_minimo,
             'links', (select count(*) from public.lnk_links l where l.projeto_id = p.id),
             'links_no_ar', (select count(*) from public.lnk_links l where l.projeto_id = p.id and l.is_active),
             'criado_em', p.created_at)
           order by (p.slug <> 'hx-geral'), p.nome)
    from public.lnk_projetos p where p.is_active), '[]'::jsonb);
end $$;
revoke all on function public.lnk_projetos_listar() from public;
grant execute on function public.lnk_projetos_listar() to authenticated;
comment on function public.lnk_projetos_listar() is 'Projetos ativos com contagem de links (painel). lnk_33.';

create or replace function public.lnk_projeto_criar(p_nome text, p_slug text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_nome text := nullif(trim(coalesce(p_nome, '')), ''); v_slug text; v_id uuid;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  if v_nome is null then return jsonb_build_object('ok', false, 'erro', 'O projeto precisa de um nome.'); end if;
  v_slug := lower(trim(coalesce(p_slug, '')));
  if v_slug = '' then
    v_slug := lower(regexp_replace(translate(v_nome,
      'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'),
      '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9_-]{1,40}$' then
    return jsonb_build_object('ok', false, 'erro', 'Slug do projeto: 2 a 41 caracteres, letras minúsculas, números, traço e sublinhado.');
  end if;
  if exists (select 1 from public.lnk_projetos where slug = v_slug) then
    return jsonb_build_object('ok', false, 'erro', 'Já existe um projeto com o slug "' || v_slug || '".');
  end if;
  insert into public.lnk_projetos (slug, nome, criado_por) values (v_slug, v_nome, auth.uid()) returning id into v_id;
  return jsonb_build_object('ok', true, 'projeto', jsonb_build_object('slug', v_slug, 'nome', v_nome, 'id', v_id));
end $$;
revoke all on function public.lnk_projeto_criar(text, text) from public;
grant execute on function public.lnk_projeto_criar(text, text) to authenticated;
comment on function public.lnk_projeto_criar(text, text) is 'Cria projeto (slug derivado do nome quando não vem). lnk_33.';

-- ---------------------------------------------------------------------------
-- 2. gate compartilhado painel + API
-- ---------------------------------------------------------------------------
create or replace function public.lnk_pode()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.mod_is_operador() or coalesce(current_setting('lnk.api', true), '') = '1'
$$;
revoke all on function public.lnk_pode() from public;
comment on function public.lnk_pode() is 'Operador do painel (JWT em painel_operadores) OU chamada de API já autenticada por token (lnk.api = 1, local à transação, só lnk_api_* seta). lnk_33.';

do $$
declare f text; v text;
  g_old text := $g$if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;$g$;
  g_new text := $g$if not public.lnk_pode() then raise exception 'sem permissao' using errcode = '42501'; end if;$g$;
begin
  foreach f in array array['lnk_criar', 'lnk_link_estado', 'lnk_url_custom', 'lnk_painel_link', 'lnk_painel_listar'] loop
    v := pg_get_functiondef(('public.' || f)::regproc);
    if pg_temp.conta(v, g_old) <> 1 then raise exception 'lnk_33: gate em %: % ocorrências', f, pg_temp.conta(v, g_old); end if;
    execute replace(v, g_old, g_new);
  end loop;
end $$;

-- lnk_link_editar: gate + `projeto` no patch (move o link; URLs novas nos domínios do projeto)
do $$
declare v text;
  a1_old text := $g$if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;$g$;
  a1_new text := $g$if not public.lnk_pode() then raise exception 'sem permissao' using errcode = '42501'; end if;$g$;
  a2_old text := $g$v_tags text[]; v_prev jsonb; v_modo text; v_ativos int; v_aviso text[] := '{}';$g$;
  a2_new text := $g$v_tags text[]; v_prev jsonb; v_modo text; v_ativos int; v_aviso text[] := '{}'; v_proj uuid;$g$;
  a3_old text := $g$select coalesce(array_agg(k order by k), '{}') into v_campos from jsonb_object_keys(p_patch) k;
$g$;
  a3_new text := $g$select coalesce(array_agg(k order by k), '{}') into v_campos from jsonb_object_keys(p_patch) k;

  if p_patch ? 'projeto' then
    select id into v_proj from public.lnk_projetos where slug = p_patch->>'projeto' and is_active;
    if v_proj is null then
      return jsonb_build_object('ok', false, 'erro', 'Projeto não encontrado: ' || coalesce(p_patch->>'projeto', '(vazio)'));
    end if;
    if v_proj = l.projeto_id then v_proj := null; end if;
  end if;
$g$;
  a4_old text := $g$    nome = case when p_patch ? 'nome' then trim(p_patch->>'nome') else nome end,$g$;
  a4_new text := $g$    projeto_id = coalesce(v_proj, projeto_id),
    nome = case when p_patch ? 'nome' then trim(p_patch->>'nome') else nome end,$g$;
  a5_old text := $g$  where id = p_link_id;

  if p_patch ? 'destinos' then
    v_i := 0;$g$;
  a5_new text := $g$  where id = p_link_id;

  -- mudou de projeto: ganha URL nos domínios daquele projeto; as antigas seguem valendo
  if v_proj is not null then perform public.lnk_sincronizar_urls(p_link_id); end if;

  if p_patch ? 'destinos' then
    v_i := 0;$g$;
begin
  v := pg_get_functiondef('public.lnk_link_editar'::regproc);
  if pg_temp.conta(v, a1_old) <> 1 then raise exception 'lnk_33: editar a1: %', pg_temp.conta(v, a1_old); end if;
  if pg_temp.conta(v, a2_old) <> 1 then raise exception 'lnk_33: editar a2: %', pg_temp.conta(v, a2_old); end if;
  if pg_temp.conta(v, a3_old) <> 1 then raise exception 'lnk_33: editar a3: %', pg_temp.conta(v, a3_old); end if;
  if pg_temp.conta(v, a4_old) <> 1 then raise exception 'lnk_33: editar a4: %', pg_temp.conta(v, a4_old); end if;
  if pg_temp.conta(v, a5_old) <> 1 then raise exception 'lnk_33: editar a5: %', pg_temp.conta(v, a5_old); end if;
  v := replace(v, a1_old, a1_new);
  v := replace(v, a2_old, a2_new);
  v := replace(v, a3_old, a3_new);
  v := replace(v, a4_old, a4_new);
  v := replace(v, a5_old, a5_new);
  execute v;
end $$;

-- ---------------------------------------------------------------------------
-- 3. histórico: quem foi, mesmo sem JWT (API)
-- ---------------------------------------------------------------------------
create or replace function public.lnk_historico_gravar(p_link_id uuid, p_acao text, p_campos text[], p_antes jsonb, p_depois jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.lnk_link_historico (link_id, acao, campos, antes, depois, por, por_email)
  values (p_link_id, p_acao, coalesce(p_campos, '{}'), p_antes, p_depois, auth.uid(),
          coalesce(auth.jwt()->>'email', nullif(current_setting('lnk.ator', true), '')));
$$;

-- ---------------------------------------------------------------------------
-- 4. chaves de API
-- ---------------------------------------------------------------------------
alter table public.lnk_edge_tokens
  add column if not exists prefixo text,
  add column if not exists criado_por_email text;
comment on column public.lnk_edge_tokens.prefixo is 'primeiros caracteres da chave, só pra pessoa reconhecer qual é (a chave inteira não fica guardada)';

-- valida token + escopo e conta o uso (o lnk_edge_auth do Worker é stable e não conta)
create or replace function public.lnk_api_auth(p_token text, p_escopo text)
returns jsonb language plpgsql volatile security definer set search_path to 'public', 'extensions' as $$
declare v_id uuid; v_nome text;
begin
  if coalesce(p_token, '') = '' then return null; end if;
  select t.id, t.nome into v_id, v_nome from public.lnk_edge_tokens t
   where t.is_active and t.revogado_em is null and p_escopo = any(t.escopo)
     and t.token_sha = encode(extensions.digest(p_token, 'sha256'), 'hex')
   limit 1;
  if v_id is null then return null; end if;
  update public.lnk_edge_tokens set ultimo_uso = now(), usos = usos + 1 where id = v_id;
  return jsonb_build_object('id', v_id, 'nome', v_nome);
end $$;
revoke all on function public.lnk_api_auth(text, text) from public;

create or replace function public.lnk_token_criar(p_nome text, p_escopos text[])
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare v_nome text := nullif(trim(coalesce(p_nome, '')), ''); v_esc text[]; v_tok text; v_id uuid;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  if v_nome is null then return jsonb_build_object('ok', false, 'erro', 'Dá um nome pra chave (quem vai usar: n8n, cliente X...).'); end if;
  if length(v_nome) > 60 then return jsonb_build_object('ok', false, 'erro', 'Nome da chave: até 60 caracteres.'); end if;
  select coalesce(array_agg(distinct e order by e), '{}') into v_esc
    from unnest(coalesce(p_escopos, '{}')) e where e in ('api:criar', 'api:ler', 'api:editar');
  if coalesce(array_length(v_esc, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'Escolhe pelo menos um escopo: api:criar, api:ler ou api:editar.');
  end if;
  if exists (select 1 from public.lnk_edge_tokens where nome = v_nome) then
    return jsonb_build_object('ok', false, 'erro', 'Já existe uma chave com esse nome. Revoga a antiga ou usa outro nome.');
  end if;
  v_tok := 'hxl_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.lnk_edge_tokens (nome, token_sha, escopo, prefixo, criado_por_email)
  values (v_nome, encode(extensions.digest(v_tok, 'sha256'), 'hex'), v_esc, left(v_tok, 10), auth.jwt()->>'email')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'nome', v_nome, 'escopo', to_jsonb(v_esc),
    'token', v_tok, 'prefixo', left(v_tok, 10),
    'aviso', 'Copia a chave agora. Eu guardo só a impressão digital dela: fechou, não aparece mais.');
end $$;
revoke all on function public.lnk_token_criar(text, text[]) from public;
grant execute on function public.lnk_token_criar(text, text[]) to authenticated;

create or replace function public.lnk_tokens_listar()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'nome', t.nome, 'prefixo', t.prefixo, 'escopo', to_jsonb(t.escopo),
             'ativa', t.is_active and t.revogado_em is null,
             'ultimo_uso', t.ultimo_uso, 'usos', t.usos, 'criado_em', t.criado_em,
             'revogado_em', t.revogado_em, 'criado_por', t.criado_por_email)
           order by (t.revogado_em is not null), t.criado_em desc)
    from public.lnk_edge_tokens t
    where t.escopo && array['api:criar', 'api:ler', 'api:editar']), '[]'::jsonb);
end $$;
revoke all on function public.lnk_tokens_listar() from public;
grant execute on function public.lnk_tokens_listar() to authenticated;

create or replace function public.lnk_token_revogar(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare t public.lnk_edge_tokens%rowtype;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  select * into t from public.lnk_edge_tokens where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Chave não encontrada.'); end if;
  if t.escopo && array['resolver', 'clique'] then
    return jsonb_build_object('ok', false, 'erro', 'Essa é a chave do redirecionador (l.hx-corp.com). Revogar derruba todos os links: não faço por aqui.');
  end if;
  if t.revogado_em is not null then return jsonb_build_object('ok', true, 'ja_estava', true); end if;
  update public.lnk_edge_tokens set is_active = false, revogado_em = now() where id = p_id;
  return jsonb_build_object('ok', true, 'nome', t.nome, 'aviso', 'Revogada. Quem usava essa chave passa a receber nao_autorizado na hora.');
end $$;
revoke all on function public.lnk_token_revogar(uuid) from public;
grant execute on function public.lnk_token_revogar(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. API pública (anon key + token). Nunca lança: erro vira {ok:false, erro}.
-- ---------------------------------------------------------------------------
create or replace function public.lnk_api_criar(p_token text, p_link jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_dest jsonb; v_nome text; v_url text;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:criar');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:criar'); end if;
  if p_link is null or jsonb_typeof(p_link) <> 'object' then
    return jsonb_build_object('ok', false, 'erro', 'p_link precisa ser um objeto: {destino, nome, projeto, slug, tags, ...}');
  end if;
  perform set_config('lnk.api', '1', true);
  perform set_config('lnk.ator', 'api:' || (v_tok->>'nome'), true);

  if p_link ? 'destinos' and jsonb_typeof(p_link->'destinos') = 'array' then v_dest := p_link->'destinos';
  elsif nullif(trim(coalesce(p_link->>'destino', '')), '') is not null then
    v_dest := jsonb_build_array(jsonb_build_object('url', trim(p_link->>'destino'), 'rotulo', 'principal', 'peso', 100));
  else
    return jsonb_build_object('ok', false, 'erro', 'Informa "destino" (URL) ou "destinos" (lista de {url, rotulo, peso}).');
  end if;
  v_url := coalesce(v_dest->0->>'url', '');
  v_nome := coalesce(nullif(trim(coalesce(p_link->>'nome', '')), ''),
                     left(regexp_replace(regexp_replace(v_url, '^https?://(www\.)?', ''), '[?#].*$', ''), 80));

  return public.lnk_criar(
    coalesce(nullif(trim(coalesce(p_link->>'projeto', '')), ''), 'hx-geral'), v_nome, v_dest,
    coalesce(p_link->'params', '[]'::jsonb),
    coalesce(nullif(p_link->>'divisao', ''), 'clique'),
    coalesce(nullif(p_link->>'merge_query', ''), 'append'),
    nullif(trim(coalesce(p_link->>'slug', '')), ''), nullif(trim(coalesce(p_link->>'dominio', '')), ''),
    coalesce(p_link->'tags', '[]'::jsonb), nullif(trim(coalesce(p_link->>'observacao', '')), ''),
    (nullif(p_link->>'expira_em', ''))::timestamptz, p_link->'preview');
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;
revoke all on function public.lnk_api_criar(text, jsonb) from public;
grant execute on function public.lnk_api_criar(text, jsonb) to anon, authenticated;
comment on function public.lnk_api_criar(text, jsonb) is 'API: cria link. p_link = {destino | destinos[], nome?, projeto? (hx-geral), slug?, dominio?, tags?, params?, divisao?, merge_query?, observacao?, expira_em?, preview?}. Escopo api:criar. lnk_33.';

create or replace function public.lnk_api_ler(p_token text, p_link_id uuid default null, p_url text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_id uuid := p_link_id; v_resto text; v_host text; v_slug text; v_kpis jsonb;
  v_tz text := 'America/Sao_Paulo'; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_7d timestamptz; v_hoje_ini timestamptz;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:ler');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:ler'); end if;
  if v_id is null and nullif(trim(coalesce(p_url, '')), '') is not null then
    v_resto := regexp_replace(trim(p_url), '^https?://', '');
    v_host := lower(split_part(v_resto, '/', 1));
    v_slug := lower(split_part(split_part(split_part(v_resto, '/', 2), '?', 1), '#', 1));
    select u.link_id into v_id from public.lnk_urls u join public.lnk_dominios d on d.id = u.dominio_id
     where d.hostname = v_host and u.slug = v_slug limit 1;
  end if;
  if v_id is null or not exists (select 1 from public.lnk_links where id = v_id) then
    return jsonb_build_object('ok', false, 'erro', 'link_nao_encontrado');
  end if;
  perform set_config('lnk.api', '1', true);
  v_7d := ((v_hoje - 6)::timestamp at time zone v_tz);
  v_hoje_ini := (v_hoje::timestamp at time zone v_tz);
  select jsonb_build_object(
    'cliques_7d', count(*) filter (where c.ts >= v_7d and public.lnk_contavel(c.classe, c.classe_motivo)),
    'acessos_7d', count(*) filter (where c.ts >= v_7d),
    'robos_7d', count(*) filter (where c.ts >= v_7d and c.classe in ('bot', 'crawler')),
    'cliques_hoje', count(*) filter (where c.ts >= v_hoje_ini and public.lnk_contavel(c.classe, c.classe_motivo)),
    'cliques_total', count(*) filter (where public.lnk_contavel(c.classe, c.classe_motivo)),
    'pessoas_7d', nullif(count(distinct c.hxv) filter (where c.ts >= v_7d and c.hxv is not null and public.lnk_contavel(c.classe, c.classe_motivo)), 0),
    'ultimo_clique', max(c.ts) filter (where public.lnk_contavel(c.classe, c.classe_motivo)),
    'nota', 'cliques = gente com o link no ar (robô, pausado e expirado ficam fora); pessoas = cookie de visitante, null enquanto não houver')
  into v_kpis from public.lnk_cliques c where c.link_id = v_id;
  return jsonb_build_object('ok', true, 'link', public.lnk_link_snapshot(v_id), 'kpis', v_kpis);
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;
revoke all on function public.lnk_api_ler(text, uuid, text) from public;
grant execute on function public.lnk_api_ler(text, uuid, text) to anon, authenticated;
comment on function public.lnk_api_ler(text, uuid, text) is 'API: lê um link por id ou pela URL curta (p_url), com kpis de 7d/hoje/total. Escopo api:ler. lnk_33.';

create or replace function public.lnk_api_listar(p_token text, p_projeto text default null, p_busca text default null,
                                                  p_limite integer default 60, p_tag text default null, p_estado text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:ler');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:ler'); end if;
  perform set_config('lnk.api', '1', true);
  return jsonb_build_object('ok', true, 'links', public.lnk_painel_listar(p_busca, p_projeto, p_limite, 'recentes', p_tag, p_estado));
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;
revoke all on function public.lnk_api_listar(text, text, text, integer, text, text) from public;
grant execute on function public.lnk_api_listar(text, text, text, integer, text, text) to anon, authenticated;
comment on function public.lnk_api_listar(text, text, text, integer, text, text) is 'API: lista links (mesma resposta da tela). Escopo api:ler. lnk_33.';

create or replace function public.lnk_api_editar(p_token text, p_link_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_patch jsonb; r jsonb; r2 jsonb;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:editar');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:editar'); end if;
  if p_link_id is null or not exists (select 1 from public.lnk_links where id = p_link_id) then
    return jsonb_build_object('ok', false, 'erro', 'link_nao_encontrado');
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('ok', false, 'erro', 'p_patch precisa ser um objeto com o que muda (nome, destinos, tags, estado, projeto...).');
  end if;
  perform set_config('lnk.api', '1', true);
  perform set_config('lnk.ator', 'api:' || (v_tok->>'nome'), true);
  v_patch := p_patch - 'estado' - 'forcar';
  if p_patch ? 'estado' then
    r := public.lnk_link_estado(p_link_id, p_patch->>'estado', coalesce((p_patch->>'forcar')::boolean, false));
    if not coalesce((r->>'ok')::boolean, false) then return r; end if;
  end if;
  if v_patch <> '{}'::jsonb then
    r2 := public.lnk_link_editar(p_link_id, v_patch);
    if not coalesce((r2->>'ok')::boolean, false) then return r2; end if;
    return r2 || jsonb_build_object('estado_aplicado', p_patch->>'estado');
  end if;
  if r is null then return jsonb_build_object('ok', false, 'erro', 'Nada pra alterar.'); end if;
  return r;
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;
revoke all on function public.lnk_api_editar(text, uuid, jsonb) from public;
grant execute on function public.lnk_api_editar(text, uuid, jsonb) to anon, authenticated;
comment on function public.lnk_api_editar(text, uuid, jsonb) is 'API: edita um link (mesmo patch do painel) e/ou muda estado (estado: ativo|pausado|congelado, forcar). Escopo api:editar. lnk_33.';

-- ---------------------------------------------------------------------------
-- 6. criação em lote
-- ---------------------------------------------------------------------------
create or replace function public.lnk_criar_lote(p_projeto text, p_linhas jsonb, p_dry boolean default true, p_defaults jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_proj uuid; v_dom text; v_n int; i int := 0; x jsonb; v_url text; v_nome text; v_slug text; v_tags jsonb; v_erro text;
  v_out jsonb := '[]'::jsonb; v_ok int := 0; v_bad int := 0; v_vistos text[] := '{}'; r jsonb; v_id uuid; v_curta text;
  v_deftags jsonb := coalesce(p_defaults->'tags', '[]'::jsonb);
  v_reservados text[] := array['api', 'admin', 'app', 'login', 'logout', 'static', 'assets', 'www', 'health', 'status',
                               'dev', 'test', 'null', 'undefined', 'robots', 'favicon', 'sitemap', 'warm'];
begin
  if not public.lnk_pode() then raise exception 'sem permissao' using errcode = '42501'; end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    return jsonb_build_object('ok', false, 'erro', 'Manda uma lista de linhas: [{url, nome, slug, tags}].');
  end if;
  v_n := jsonb_array_length(p_linhas);
  if v_n = 0 then return jsonb_build_object('ok', false, 'erro', 'Nenhuma linha pra criar.'); end if;
  if v_n > 500 then return jsonb_build_object('ok', false, 'erro', 'No máximo 500 linhas por vez (vieram ' || v_n || ').'); end if;
  if v_deftags is null or jsonb_typeof(v_deftags) <> 'array' then v_deftags := '[]'::jsonb; end if;
  select id into v_proj from public.lnk_projetos where slug = p_projeto and is_active;
  if v_proj is null then return jsonb_build_object('ok', false, 'erro', 'Projeto não encontrado: ' || coalesce(p_projeto, '(vazio)')); end if;

  -- domínio dos slugs personalizados: o informado, senão o institucional (fora do rodízio) do projeto ou global
  v_dom := lower(trim(coalesce(p_defaults->>'dominio', '')));
  if v_dom = '' then
    select hostname into v_dom from public.lnk_dominios
     where status = 'ativo' and (projeto_id = v_proj or projeto_id is null)
     order by no_rodizio, hostname limit 1;
  end if;

  for x in select * from jsonb_array_elements(p_linhas) loop
    i := i + 1;
    v_erro := null; v_id := null; v_curta := null;
    v_url := trim(coalesce(x->>'url', ''));
    v_nome := nullif(trim(coalesce(x->>'nome', '')), '');
    v_slug := nullif(lower(trim(coalesce(x->>'slug', ''))), '');
    select coalesce(jsonb_agg(t order by t), '[]'::jsonb) into v_tags
      from (select distinct lower(trim(t)) t
            from jsonb_array_elements_text(case when jsonb_typeof(x->'tags') = 'array' then x->'tags' else '[]'::jsonb end || v_deftags) t
            where trim(t) <> '') s;

    if v_url !~* '^https?://[^/[:space:]]+' then v_erro := 'Destino precisa começar com http:// ou https://.';
    elsif v_slug is not null and v_slug !~ '^[a-z0-9][a-z0-9_-]{2,39}$' then v_erro := 'Slug: 3 a 40 caracteres, letras minúsculas, números, traço e sublinhado.';
    elsif v_slug is not null and v_slug = any(v_reservados) then v_erro := 'Slug reservado: escolhe outro.';
    elsif v_slug is not null and v_dom is null then v_erro := 'Nenhum domínio ativo pra receber o slug.';
    elsif v_slug is not null and v_slug = any(v_vistos) then v_erro := 'Slug repetido dentro do lote.';
    elsif v_slug is not null and exists (select 1 from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
                                          where dm.hostname = v_dom and u.slug = v_slug) then
      v_erro := 'O slug "' || v_slug || '" já está em uso em ' || v_dom || '.';
    elsif jsonb_array_length(v_tags) > 10 then v_erro := 'No máximo 10 tags por link (contando as do lote).';
    end if;
    if v_erro is null and v_nome is null then
      v_nome := left(regexp_replace(regexp_replace(v_url, '^https?://(www\.)?', ''), '[?#].*$', ''), 80);
    end if;
    if v_erro is null and v_slug is not null then v_vistos := v_vistos || v_slug; end if;

    if v_erro is null and not p_dry then
      begin
        r := public.lnk_criar(p_projeto, v_nome,
               jsonb_build_array(jsonb_build_object('url', v_url, 'rotulo', 'principal', 'peso', 100)),
               coalesce(p_defaults->'params', '[]'::jsonb),
               coalesce(nullif(p_defaults->>'divisao', ''), 'clique'),
               coalesce(nullif(p_defaults->>'merge_query', ''), 'append'),
               v_slug, case when v_slug is not null then v_dom end, v_tags,
               nullif(trim(coalesce(p_defaults->>'observacao', '')), ''),
               (nullif(p_defaults->>'expira_em', ''))::timestamptz, p_defaults->'preview');
        if coalesce((r->>'ok')::boolean, false) then
          v_id := (r->>'id')::uuid;
          v_curta := coalesce((select u->>'url' from jsonb_array_elements(coalesce(r->'urls', '[]'::jsonb)) u where u->>'dominio' = v_dom limit 1),
                              r->'link'->>'url_curta');
        else
          v_erro := coalesce(r->>'erro', 'não criou');
        end if;
      exception when others then
        v_erro := sqlerrm;   -- só esta linha volta atrás; as outras seguem
      end;
    end if;

    if v_erro is null then v_ok := v_ok + 1; else v_bad := v_bad + 1; end if;
    v_out := v_out || jsonb_build_object('n', coalesce((x->>'n')::int, i), 'url', v_url, 'nome', v_nome, 'slug', v_slug,
                                         'tags', v_tags, 'ok', v_erro is null, 'erro', v_erro, 'id', v_id, 'url_curta', v_curta);
  end loop;

  return jsonb_build_object('ok', true, 'dry', p_dry, 'projeto', p_projeto, 'dominio', v_dom,
                            'total', v_n, 'validas', v_ok, 'invalidas', v_bad, 'linhas', v_out);
end $$;
revoke all on function public.lnk_criar_lote(text, jsonb, boolean, jsonb) from public;
grant execute on function public.lnk_criar_lote(text, jsonb, boolean, jsonb) to authenticated;
comment on function public.lnk_criar_lote(text, jsonb, boolean, jsonb) is 'Cria links em lote: p_linhas [{n, url, nome?, slug?, tags?}] (≤500), p_dry só valida, p_defaults {tags, dominio, params, divisao, merge_query, observacao, expira_em, preview} valem pra todas. Linha inválida não derruba as outras. lnk_33.';
