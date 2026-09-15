-- lnk_35 (15/09/2026): gate F3, rodada 2 (revisor banco/API). 1 obrigatória + 7 sugestões.
--
-- Obrigatória: lnk_api_listar filtrava o escopo de projeto DEPOIS do limit de
-- lnk_painel_listar (que corta sobre todos os projetos, por mais recentes). Chave
-- com escopo e sem p_projeto recebia "os meus que por acaso estão entre os 60
-- mais recentes da HX" com ok:true. Agora: chave com 1 projeto usa ele; com
-- vários, exige p_projeto (informe_projeto), igual ao lnk_api_criar.
-- Sugestões: S1 projetos = {} não vira "todos" (falhava aberto); S2 editar devolve
-- campos/aviso do patch junto com o estado; S3 listar declara limite/truncado;
-- S4 comments das funções da API atualizados; S5 lnk_dominio_cadastrar recusa
-- projeto desconhecido (null segue = global); S6 destinos [] reclama do destino
-- certo; S7 n com mais de 9 dígitos não derruba o lote.

create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

create or replace function public.lnk_api_listar(p_token text, p_projeto text default null, p_busca text default null,
                                                  p_limite integer default 60, p_tag text default null, p_estado text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_tok jsonb; v_lista jsonb; v_lim int := greatest(1, least(coalesce(p_limite, 60), 200)); v_proj text := nullif(p_projeto, '');
begin
  v_tok := public.lnk_api_auth(p_token, 'api:ler');
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'chave inválida, revogada ou sem o escopo api:ler'); end if;
  if v_proj is not null and not public.lnk_api_ve_projeto(v_tok, v_proj) then
    return jsonb_build_object('ok', false, 'erro', 'nao_autorizado', 'dica', 'essa chave não enxerga o projeto "' || v_proj || '"');
  end if;
  -- chave com escopo: o filtro precisa entrar ANTES do limit, então vira o p_projeto
  if jsonb_typeof(v_tok->'projetos') = 'array' and v_proj is null then
    if jsonb_array_length(v_tok->'projetos') = 1 then
      v_proj := v_tok->'projetos'->>0;
    else
      return jsonb_build_object('ok', false, 'erro', 'informe_projeto',
        'dica', 'essa chave enxerga mais de um projeto; manda "p_projeto" com um destes: '
                || (select string_agg(x, ', ') from jsonb_array_elements_text(v_tok->'projetos') x));
    end if;
  end if;
  perform set_config('lnk.api', '1', true);
  v_lista := coalesce(public.lnk_painel_listar(p_busca, v_proj, v_lim, 'recentes', p_tag, p_estado), '[]'::jsonb);
  return jsonb_build_object('ok', true, 'links', v_lista, 'projeto', v_proj, 'limite', v_lim,
    -- quem recebe exatamente o limite não sabe se acabou: agora sabe
    'truncado', jsonb_array_length(v_lista) >= v_lim);
exception when others then
  return jsonb_build_object('ok', false, 'erro', sqlerrm);
end $$;
comment on function public.lnk_api_listar(text, text, text, integer, text, text) is 'API: lista links (mesma resposta da tela), mais recentes primeiro, p_limite ≤ 200 e "truncado" quando bateu no limite. Chave com escopo de 1 projeto lista ele; com vários, p_projeto é obrigatório (informe_projeto); projeto fora do escopo = nao_autorizado. Escopo api:ler. lnk_33/34/35.';

-- S1: lista vazia de projetos NÃO vira "todos"
do $$
declare v text;
  s_old text := $x$    if coalesce(array_length(v_projs, 1), 0) = 0 then v_projs := null; end if;$x$;
  s_new text := $x$    if coalesce(array_length(v_projs, 1), 0) = 0 then
      return jsonb_build_object('ok', false, 'erro', 'Escolhe pelo menos um projeto; chave interna que enxerga todos é com projetos = null, explicitamente.');
    end if;$x$;
begin
  v := pg_get_functiondef('public.lnk_token_criar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_35: S1 em lnk_token_criar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- S2: editar devolve campos/aviso do patch E o estado
do $$
declare v text;
  s_old text := $x$  return coalesce(r, r2) || jsonb_build_object('link', public.lnk_link_snapshot(p_link_id), 'estado_aplicado', p_patch->>'estado');$x$;
  s_new text := $x$  return coalesce(r2, '{}'::jsonb) || coalesce(r, '{}'::jsonb) || jsonb_build_object('link', public.lnk_link_snapshot(p_link_id), 'estado_aplicado', p_patch->>'estado');$x$;
begin
  v := pg_get_functiondef('public.lnk_api_editar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_35: S2 em lnk_api_editar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- S6: destinos [] reclama do destino, não do http
do $$
declare v text;
  s_old text := $x$  v_url := coalesce(v_dest->0->>'url', '');
  if v_url !~* '^https?://[^/[:space:]]+' then$x$;
  s_new text := $x$  if jsonb_array_length(v_dest) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'Um link precisa de pelo menos um destino.');
  end if;
  v_url := coalesce(v_dest->0->>'url', '');
  if v_url !~* '^https?://[^/[:space:]]+' then$x$;
begin
  v := pg_get_functiondef('public.lnk_api_criar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_35: S6 em lnk_api_criar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- S7: n com mais de 9 dígitos cai no índice em vez de estourar o int
do $$
declare v text;
  s_old text := $x$v_num := case when nullif(x->>'n', '') ~ '^\d+$' then (x->>'n')::int else i end;$x$;
  s_new text := $x$v_num := case when nullif(x->>'n', '') ~ '^\d{1,9}$' then (x->>'n')::int else i end;$x$;
begin
  v := pg_get_functiondef('public.lnk_criar_lote'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_35: S7 em lnk_criar_lote: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- S5: projeto desconhecido no cadastro de domínio não vira global em silêncio (null segue = global)
do $$
declare v text;
  s_old text := $x$  select id into v_proj from public.lnk_projetos where slug = p_projeto;
$x$;
  s_new text := $x$  select id into v_proj from public.lnk_projetos where slug = p_projeto;
  if p_projeto is not null and v_proj is null then
    return jsonb_build_object('ok', false, 'erro', 'Projeto não encontrado: ' || p_projeto || ' (sem projeto = domínio global).');
  end if;
$x$;
begin
  v := pg_get_functiondef('public.lnk_dominio_cadastrar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_35: S5 em lnk_dominio_cadastrar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;

-- S4: comments (é o que aparece no OpenAPI do PostgREST)
comment on function public.lnk_api_criar(text, jsonb) is 'API: cria link. p_link = {destino | destinos[], nome?, projeto?, slug?, dominio?, tags?, params?, divisao?, merge_query?, observacao?, expira_em?, preview?}. Chave com escopo de 1 projeto cria nele quando projeto vem vazio; com vários, projeto é obrigatório (informe_projeto); projeto fora do escopo = nao_autorizado. Escopo api:criar. lnk_33/34/35.';
comment on function public.lnk_api_ler(text, uuid, text) is 'API: lê um link por id ou pela URL curta (p_url), com kpis de 7d/hoje/total (cliques = gente com o link no ar; pessoas = cookie, null enquanto não houver). Link fora do escopo de projeto da chave = link_nao_encontrado. Escopo api:ler. lnk_33/34/35.';
