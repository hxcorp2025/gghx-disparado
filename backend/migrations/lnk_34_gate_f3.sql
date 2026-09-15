-- lnk_34 (15/09/2026): correções do gate F3 (revisor banco/API): 5 obrigatórias + 6 sugestões.
--
-- Obrigatórias:
--  1. A API NÃO mexe em link com URL protegida (colada em produção fora do Send,
--     ex.: l.hx-corp.com/eq8egq): lnk_api_editar devolve {ok:false, erro:'link_protegido'}.
--     Antes, uma chave api:editar trocava o destino do pop-up do PDM em 2 chamadas.
--  2. Chave com escopo de PROJETO: lnk_edge_tokens.projetos text[] (null = todos, uso
--     interno). criar/ler/listar/editar respeitam; link fora do escopo = não existe.
--  3. Prova de que as funções antigas aceitam domínio global (projeto_id null):
--     lnk_sincronizar_urls, lnk_tg_dominio_ativo, lnk_dominio_cadastrar e
--     lnk_montar_cache foram lidas do banco nesta sessão e todas tratam o nulo
--     ("projeto_id = v_proj OR projeto_id IS NULL"; cadastrar não valida projeto;
--     montar_cache usa o projeto do LINK). O bloco de teste desta migration prova
--     com link novo em projeto novo nascendo em l.hx-corp.com e cadastro com null.
--  4. lnk_api_editar sem escrita pela metade: erro de validação vira RAISE (o bloco
--     exception desfaz o estado já gravado) e o JSON original volta pelo DETAIL.
--  5. Dry do lote valida formato de tag (sem acento, ≤30) e os p_defaults
--     (divisao, merge_query, dominio) ANTES de dizer "N válidas".
-- Sugestões aplicadas: S5 (mensagem de nome repetido: o nome fica reservado),
--  S9 (link_inativo grava o projeto do link, não do domínio), S10 (grants
--  service_role), S11 (slug só entra em v_vistos depois de criar), S12 (n não
--  numérico não derruba a chamada), S13 (destino validado antes de derivar o nome).

create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

-- ---------------------------------------------------------------------------
-- 2. escopo de projeto na chave
-- ---------------------------------------------------------------------------
alter table public.lnk_edge_tokens add column if not exists projetos text[];
comment on column public.lnk_edge_tokens.projetos is 'slugs de projeto que a chave enxerga; null = todos os projetos (só pra uso interno: n8n da casa)';

create or replace function public.lnk_api_auth(p_token text, p_escopo text)
returns jsonb language plpgsql volatile security definer set search_path to 'public', 'extensions' as $$
declare v_id uuid; v_nome text; v_projs text[];
begin
  if coalesce(p_token, '') = '' then return null; end if;
  select t.id, t.nome, t.projetos into v_id, v_nome, v_projs from public.lnk_edge_tokens t
   where t.is_active and t.revogado_em is null and p_escopo = any(t.escopo)
     and t.token_sha = encode(extensions.digest(p_token, 'sha256'), 'hex')
   limit 1;
  if v_id is null then return null; end if;
  update public.lnk_edge_tokens set ultimo_uso = now(), usos = coalesce(usos, 0) + 1 where id = v_id;
  return jsonb_build_object('id', v_id, 'nome', v_nome, 'projetos', to_jsonb(v_projs));
end $$;
revoke all on function public.lnk_api_auth(text, text) from public;

-- a chave enxerga esse projeto? (sem lista = enxerga todos)
create or replace function public.lnk_api_ve_projeto(p_tok jsonb, p_slug text)
returns boolean language sql immutable as $$
  select jsonb_typeof(p_tok->'projetos') is distinct from 'array' or (p_tok->'projetos') ? coalesce(p_slug, '')
$$;
revoke all on function public.lnk_api_ve_projeto(jsonb, text) from public;

drop function if exists public.lnk_token_criar(text, text[]);
create or replace function public.lnk_token_criar(p_nome text, p_escopos text[], p_projetos text[] default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare v_nome text := nullif(trim(coalesce(p_nome, '')), ''); v_esc text[]; v_tok text; v_id uuid; v_projs text[]; v_desc text[];
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  if v_nome is null then return jsonb_build_object('ok', false, 'erro', 'Dá um nome pra chave (quem vai usar: n8n, cliente X...).'); end if;
  if length(v_nome) > 60 then return jsonb_build_object('ok', false, 'erro', 'Nome da chave: até 60 caracteres.'); end if;
  select coalesce(array_agg(distinct e order by e), '{}') into v_esc
    from unnest(coalesce(p_escopos, '{}')) e where e in ('api:criar', 'api:ler', 'api:editar');
  if coalesce(array_length(v_esc, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'Escolhe pelo menos um escopo: api:criar, api:ler ou api:editar.');
  end if;
  if p_projetos is not null then
    select coalesce(array_agg(distinct s order by s), '{}') into v_projs
      from unnest(p_projetos) s where exists (select 1 from public.lnk_projetos p where p.slug = s and p.is_active);
    select coalesce(array_agg(distinct s), '{}') into v_desc
      from unnest(p_projetos) s where not exists (select 1 from public.lnk_projetos p where p.slug = s and p.is_active);
    if coalesce(array_length(v_desc, 1), 0) > 0 then
      return jsonb_build_object('ok', false, 'erro', 'Projeto desconhecido ou inativo: ' || array_to_string(v_desc, ', '));
    end if;
    if coalesce(array_length(v_projs, 1), 0) = 0 then v_projs := null; end if;  -- lista vazia = todos
  end if;
  if exists (select 1 from public.lnk_edge_tokens where nome = v_nome) then
    return jsonb_build_object('ok', false, 'erro',
      'Já existe uma chave com esse nome. O nome fica reservado mesmo depois de revogada (pro histórico não ficar ambíguo): usa outro nome.');
  end if;
  v_tok := 'hxl_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.lnk_edge_tokens (nome, token_sha, escopo, prefixo, criado_por_email, projetos)
  values (v_nome, encode(extensions.digest(v_tok, 'sha256'), 'hex'), v_esc, left(v_tok, 10), auth.jwt()->>'email', v_projs)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'nome', v_nome, 'escopo', to_jsonb(v_esc), 'projetos', to_jsonb(v_projs),
    'token', v_tok, 'prefixo', left(v_tok, 10),
    'aviso', 'Copia a chave agora. Eu guardo só a impressão digital dela: fechou, não aparece mais.');
end $$;
revoke all on function public.lnk_token_criar(text, text[], text[]) from public;
grant execute on function public.lnk_token_criar(text, text[], text[]) to authenticated, service_role;

create or replace function public.lnk_tokens_listar()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'nome', t.nome, 'prefixo', t.prefixo, 'escopo', to_jsonb(t.escopo), 'projetos', to_jsonb(t.projetos),
             'ativa', t.is_active and t.revogado_em is null,
             'ultimo_uso', t.ultimo_uso, 'usos', coalesce(t.usos, 0), 'criado_em', t.criado_em,
             'revogado_em', t.revogado_em, 'criado_por', t.criado_por_email)
           order by (t.revogado_em is not null), t.criado_em desc)
    from public.lnk_edge_tokens t
    where t.escopo && array['api:criar', 'api:ler', 'api:editar']), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- API: escopo de projeto (2), link protegido (1), sem escrita pela metade (4), S13
-- ---------------------------------------------------------------------------
create or replace function public.lnk_api_criar(p_token text, p_link jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_dest jsonb; v_nome text; v_url text; v_projeto text;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:criar');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:criar'); end if;
  if p_link is null or jsonb_typeof(p_link) <> 'object' then
    return jsonb_build_object('ok', false, 'erro', 'p_link precisa ser um objeto: {destino, nome, projeto, slug, tags, ...}');
  end if;

  if p_link ? 'destinos' and jsonb_typeof(p_link->'destinos') = 'array' then v_dest := p_link->'destinos';
  elsif nullif(trim(coalesce(p_link->>'destino', '')), '') is not null then
    v_dest := jsonb_build_array(jsonb_build_object('url', trim(p_link->>'destino'), 'rotulo', 'principal', 'peso', 100));
  else
    return jsonb_build_object('ok', false, 'erro', 'Informa "destino" (URL) ou "destinos" (lista de {url, rotulo, peso}).');
  end if;
  -- destino antes do nome: sem isto a reclamação vinha sobre o nome (S13)
  v_url := coalesce(v_dest->0->>'url', '');
  if v_url !~* '^https?://[^/[:space:]]+' then
    return jsonb_build_object('ok', false, 'erro', 'Todo destino precisa começar com http:// ou https://. Confere: ' || coalesce(nullif(v_url, ''), '(em branco)'));
  end if;
  v_nome := coalesce(nullif(trim(coalesce(p_link->>'nome', '')), ''),
                     left(rtrim(regexp_replace(regexp_replace(v_url, '^https?://(www\.)?', ''), '[?#].*$', ''), '/'), 80));

  -- projeto: o pedido; senão o único da chave; senão hx-geral. Fora do escopo da chave = recusa.
  v_projeto := nullif(trim(coalesce(p_link->>'projeto', '')), '');
  if jsonb_typeof(v_tok->'projetos') = 'array' then
    if v_projeto is null then
      if jsonb_array_length(v_tok->'projetos') = 1 then v_projeto := v_tok->'projetos'->>0;
      else return jsonb_build_object('ok', false, 'erro', 'informe_projeto', 'dica', 'essa chave enxerga mais de um projeto; manda "projeto" com um destes: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_tok->'projetos') x));
      end if;
    elsif not public.lnk_api_ve_projeto(v_tok, v_projeto) then
      return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'essa chave não enxerga o projeto "' || v_projeto || '"');
    end if;
  end if;
  v_projeto := coalesce(v_projeto, 'hx-geral');

  perform set_config('lnk.api', '1', true);
  perform set_config('lnk.ator', 'api:' || (v_tok->>'nome'), true);
  return public.lnk_criar(
    v_projeto, v_nome, v_dest,
    coalesce(p_link->'params', '[]'::jsonb),
    coalesce(nullif(p_link->>'divisao', ''), 'clique'),
    coalesce(nullif(p_link->>'merge_query', ''), 'append'),
    nullif(trim(coalesce(p_link->>'slug', '')), ''), nullif(trim(coalesce(p_link->>'dominio', '')), ''),
    coalesce(p_link->'tags', '[]'::jsonb), nullif(trim(coalesce(p_link->>'observacao', '')), ''),
    (nullif(p_link->>'expira_em', ''))::timestamptz, p_link->'preview');
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;

create or replace function public.lnk_api_ler(p_token text, p_link_id uuid default null, p_url text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_id uuid := p_link_id; v_resto text; v_host text; v_slug text; v_kpis jsonb; v_proj text;
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
  select pr.slug into v_proj from public.lnk_links l join public.lnk_projetos pr on pr.id = l.projeto_id where l.id = v_id;
  -- fora do escopo da chave = não existe (não confirma nem nega)
  if v_id is null or v_proj is null or not public.lnk_api_ve_projeto(v_tok, v_proj) then
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

create or replace function public.lnk_api_listar(p_token text, p_projeto text default null, p_busca text default null,
                                                  p_limite integer default 60, p_tag text default null, p_estado text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_lista jsonb;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:ler');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:ler'); end if;
  if nullif(p_projeto, '') is not null and not public.lnk_api_ve_projeto(v_tok, p_projeto) then
    return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'essa chave não enxerga o projeto "' || p_projeto || '"');
  end if;
  perform set_config('lnk.api', '1', true);
  v_lista := public.lnk_painel_listar(p_busca, nullif(p_projeto, ''), p_limite, 'recentes', p_tag, p_estado);
  -- chave com escopo e sem projeto pedido: só o que ela enxerga
  if jsonb_typeof(v_tok->'projetos') = 'array' and nullif(p_projeto, '') is null then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_lista
      from jsonb_array_elements(coalesce(v_lista, '[]'::jsonb)) x where (v_tok->'projetos') ? (x->>'projeto');
  end if;
  return jsonb_build_object('ok', true, 'links', v_lista);
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;

create or replace function public.lnk_api_editar(p_token text, p_link_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_patch jsonb; r jsonb; r2 jsonb; v_proj text;
begin
  v_tok := public.lnk_api_auth(p_token, 'api:editar');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:editar'); end if;
  select pr.slug into v_proj from public.lnk_links l join public.lnk_projetos pr on pr.id = l.projeto_id where l.id = p_link_id;
  if p_link_id is null or v_proj is null or not public.lnk_api_ve_projeto(v_tok, v_proj) then
    return jsonb_build_object('ok', false, 'erro', 'link_nao_encontrado');
  end if;
  -- URL colada em produção fora do Send (pop-up, material): só pelo painel, com operador.
  -- Sem isto, uma chave api:editar trocava o destino do pop-up do PDM (revisão 15/09).
  if exists (select 1 from public.lnk_urls u where u.link_id = p_link_id and u.protegida) then
    return jsonb_build_object('ok', false, 'erro', 'link_protegido',
      'dica', 'esse link tem URL colada em produção fora do Send; edição só pelo painel, com operador');
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('ok', false, 'erro', 'p_patch precisa ser um objeto com o que muda (nome, destinos, tags, estado, projeto...).');
  end if;
  if p_patch ? 'projeto' and not public.lnk_api_ve_projeto(v_tok, p_patch->>'projeto') then
    return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'essa chave não enxerga o projeto "' || coalesce(p_patch->>'projeto', '') || '"');
  end if;
  perform set_config('lnk.api', '1', true);
  perform set_config('lnk.ator', 'api:' || (v_tok->>'nome'), true);
  v_patch := p_patch - 'estado' - 'forcar';
  if v_patch = '{}'::jsonb and not (p_patch ? 'estado') then
    return jsonb_build_object('ok', false, 'erro', 'Nada pra alterar.');
  end if;
  -- ordem: valida e grava o patch primeiro; erro em qualquer passo vira RAISE e o
  -- bloco exception desfaz TUDO (nada fica meio-escrito). O JSON volta pelo DETAIL.
  if v_patch <> '{}'::jsonb then
    r2 := public.lnk_link_editar(p_link_id, v_patch);
    if not coalesce((r2->>'ok')::boolean, false) then
      raise exception using errcode = '22023', message = coalesce(r2->>'erro', 'falhou'), detail = r2::text;
    end if;
  end if;
  if p_patch ? 'estado' then
    r := public.lnk_link_estado(p_link_id, p_patch->>'estado', coalesce((p_patch->>'forcar')::boolean, false));
    if not coalesce((r->>'ok')::boolean, false) then
      raise exception using errcode = '22023', message = coalesce(r->>'erro', 'falhou'), detail = r::text;
    end if;
  end if;
  return coalesce(r, r2) || jsonb_build_object('link', public.lnk_link_snapshot(p_link_id), 'estado_aplicado', p_patch->>'estado');
exception when others then
  declare v_det text;
  begin
    get stacked diagnostics v_det = pg_exception_detail;
    if left(coalesce(v_det, ''), 1) = '{' then return v_det::jsonb; end if;
    return jsonb_build_object('ok', false, 'erro', sqlerrm);
  end;
end $$;
comment on function public.lnk_api_editar(text, uuid, jsonb) is 'API: edita um link (mesmo patch do painel) e/ou muda estado (estado: ativo|pausado|congelado, forcar). Recusa link protegido e link fora do escopo de projeto da chave. Tudo ou nada. Escopo api:editar. lnk_33/34.';

-- ---------------------------------------------------------------------------
-- 5. lote: dry valida tag e defaults; S11, S12
-- ---------------------------------------------------------------------------
create or replace function public.lnk_criar_lote(p_projeto text, p_linhas jsonb, p_dry boolean default true, p_defaults jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_proj uuid; v_dom text; v_n int; i int := 0; x jsonb; v_url text; v_nome text; v_slug text; v_tags jsonb; v_erro text;
  v_out jsonb := '[]'::jsonb; v_ok int := 0; v_bad int := 0; v_vistos text[] := '{}'; r jsonb; v_id uuid; v_curta text; v_num int;
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
  if p_defaults is null or jsonb_typeof(p_defaults) <> 'object' then p_defaults := '{}'::jsonb; end if;
  if v_deftags is null or jsonb_typeof(v_deftags) <> 'array' then v_deftags := '[]'::jsonb; end if;
  select id into v_proj from public.lnk_projetos where slug = p_projeto and is_active;
  if v_proj is null then return jsonb_build_object('ok', false, 'erro', 'Projeto não encontrado: ' || coalesce(p_projeto, '(vazio)')); end if;

  -- os defaults valem pra todas as linhas: um valor errado aqui reprovaria o lote
  -- inteiro só na criação, depois do "N válidas" (revisão 15/09)
  if coalesce(nullif(p_defaults->>'divisao', ''), 'clique') not in ('clique', 'pessoa') then
    return jsonb_build_object('ok', false, 'erro', 'Divisão do lote: "clique" ou "pessoa".');
  end if;
  if coalesce(nullif(p_defaults->>'merge_query', ''), 'append') not in ('append', 'ignorar', 'whitelist') then
    return jsonb_build_object('ok', false, 'erro', 'Query de entrada do lote: "append", "ignorar" ou "whitelist".');
  end if;
  if nullif(p_defaults->>'expira_em', '') is not null then
    begin perform (p_defaults->>'expira_em')::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'erro', 'Data de expiração do lote inválida.'); end;
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_deftags) t where trim(t) <> '' and (length(trim(t)) > 30 or lower(trim(t)) !~ '^[a-z0-9][a-z0-9 _.-]*$')) then
    return jsonb_build_object('ok', false, 'erro', 'Tag pra todos só com letras minúsculas sem acento, números, espaço, ponto, traço ou sublinhado, até 30 caracteres.');
  end if;

  v_dom := lower(trim(coalesce(p_defaults->>'dominio', '')));
  if v_dom = '' then
    select hostname into v_dom from public.lnk_dominios
     where status = 'ativo' and (projeto_id = v_proj or projeto_id is null)
     order by no_rodizio, hostname limit 1;
  elsif not exists (select 1 from public.lnk_dominios d where d.hostname = v_dom and d.status = 'ativo' and (d.projeto_id is null or d.projeto_id = v_proj)) then
    return jsonb_build_object('ok', false, 'erro', 'Domínio do lote não existe, não está ativo ou é de outro projeto: ' || v_dom);
  end if;

  for x in select * from jsonb_array_elements(p_linhas) loop
    i := i + 1;
    v_erro := null; v_id := null; v_curta := null;
    v_num := case when nullif(x->>'n', '') ~ '^\d+$' then (x->>'n')::int else i end;
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
    elsif exists (select 1 from jsonb_array_elements_text(v_tags) t where length(t) > 30 or t !~ '^[a-z0-9][a-z0-9 _.-]*$') then
      v_erro := 'Tag só com letras minúsculas sem acento, números, espaço, ponto, traço ou sublinhado, até 30 caracteres.';
    end if;
    if v_erro is null and v_nome is null then
      v_nome := left(rtrim(regexp_replace(regexp_replace(v_url, '^https?://(www\.)?', ''), '[?#].*$', ''), '/'), 80);
    end if;

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
    -- o slug só "ocupa" a vaga no lote quando a linha passou (no dry) ou foi criada (S11)
    if v_erro is null and v_slug is not null then v_vistos := v_vistos || v_slug; end if;

    if v_erro is null then v_ok := v_ok + 1; else v_bad := v_bad + 1; end if;
    v_out := v_out || jsonb_build_object('n', v_num, 'url', v_url, 'nome', v_nome, 'slug', v_slug,
                                         'tags', v_tags, 'ok', v_erro is null, 'erro', v_erro, 'id', v_id, 'url_curta', v_curta);
  end loop;

  return jsonb_build_object('ok', true, 'dry', p_dry, 'projeto', p_projeto, 'dominio', v_dom,
                            'total', v_n, 'validas', v_ok, 'invalidas', v_bad, 'linhas', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- S9: acesso a link inativo em domínio global grava o projeto do LINK
-- ---------------------------------------------------------------------------
do $$
declare v text;
  s_old text := $x$'dominio_id', v_dom.id, 'projeto_id', v_dom.projeto_id, 'link_id', v_url.link_id,$x$;
  s_new text := $x$'dominio_id', v_dom.id, 'projeto_id', coalesce((select l.projeto_id from public.lnk_links l where l.id = v_url.link_id), v_dom.projeto_id), 'link_id', v_url.link_id,$x$;
begin
  v := pg_get_functiondef('public.lnk_edge_resolver'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_34: link_inativo em lnk_edge_resolver: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- ---------------------------------------------------------------------------
-- S10: grants service_role, no padrão das lnk_28/29
-- ---------------------------------------------------------------------------
grant execute on function public.lnk_projetos_listar() to service_role;
grant execute on function public.lnk_projeto_criar(text, text) to service_role;
grant execute on function public.lnk_criar_lote(text, jsonb, boolean, jsonb) to service_role;
grant execute on function public.lnk_tokens_listar() to service_role;
grant execute on function public.lnk_token_revogar(uuid) to service_role;
