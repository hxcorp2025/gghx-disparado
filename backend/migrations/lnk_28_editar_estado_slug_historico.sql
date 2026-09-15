-- =====================================================================
-- lnk_28: editar / pausar / congelar / expirar, slug custom, historico,
-- purge no KV, URL protegida. PRD Links HX v2 (15/09/2026), F1 (c).
--
-- Regras que mandam aqui:
--  * lnk_urls (slug) NUNCA e tocada por lnk_link_editar. Slug e outra RPC,
--    lnk_url_custom, com guarda de cliques e de URL protegida.
--  * eq8egq (pop-up do PDM) nasce protegida: nao renomeia nem com p_forcar.
--  * Destino que sai da lista e DESLIGADO, nunca apagado: lnk_cliques.destino_id
--    aponta pra ele.
--  * Toda escrita valida ANTES de gravar e devolve {ok:false, erro} em
--    portugues; nada de meio-escrito.
--  * Tudo que muda vira linha em lnk_link_historico (append-only).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. URL protegida
-- ---------------------------------------------------------------------
alter table public.lnk_urls add column if not exists protegida boolean not null default false;
comment on column public.lnk_urls.protegida is
  'true = slug em producao fora do nosso controle (colado em GTM, material, pop-up). lnk_url_custom recusa renomear mesmo com p_forcar; so o banco tira a protecao.';
update public.lnk_urls u set protegida = true
  from public.lnk_dominios d
 where d.id = u.dominio_id and d.hostname = 'l.hx-corp.com' and u.slug = 'eq8egq' and not u.protegida;

-- ---------------------------------------------------------------------
-- 2. Historico append-only
-- ---------------------------------------------------------------------
create table if not exists public.lnk_link_historico (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.lnk_links(id) on delete cascade,
  acao text not null,               -- criado | editado | estado | slug
  campos text[] not null default '{}',
  antes jsonb,
  depois jsonb,
  por uuid,
  por_email text,
  em timestamptz not null default now()
);
create index if not exists lnk_link_historico_link_idx on public.lnk_link_historico (link_id, em desc);
alter table public.lnk_link_historico enable row level security;
revoke all on public.lnk_link_historico from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Snapshot do link (historico, resposta das RPCs, detalhe)
-- ---------------------------------------------------------------------
create or replace function public.lnk_link_snapshot(p_link_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', l.id, 'nome', l.nome, 'projeto', pr.slug,
    'divisao', l.divisao, 'merge_query', l.merge_query, 'query_whitelist', to_jsonb(l.query_whitelist),
    'ativo', l.is_active, 'congelado', l.congelado,
    'estado', case when not l.is_active then 'pausado'
                   when l.expira_em is not null and l.expira_em < now() then 'expirado'
                   when l.congelado then 'congelado' else 'ativo' end,
    'expira_em', l.expira_em, 'destino_expirado', l.destino_expirado,
    'tags', to_jsonb(l.tags), 'observacao', l.observacao,
    'is_destino_de_anuncio', l.is_destino_de_anuncio,
    'preview', jsonb_build_object('modo', l.preview_mode, 'titulo', l.preview_titulo,
                                  'desc', l.preview_desc, 'img', l.preview_img),
    'destinos', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'url', d.url, 'rotulo', d.rotulo,
                            'peso', d.peso, 'peso_efetivo', d.peso_efetivo, 'ativo', d.is_active, 'ordem', d.ordem)
                          order by d.ordem, d.created_at)
                         from public.lnk_destinos d where d.link_id = l.id), '[]'::jsonb),
    'params', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'chave', p.chave, 'valor', p.valor,
                          'modo', p.modo, 'destino_id', p.destino_id, 'ordem', p.ordem)
                        order by p.ordem, p.chave)
                       from public.lnk_params p where p.link_id = l.id), '[]'::jsonb),
    'urls', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'dominio', dm.hostname, 'slug', u.slug,
                        'url', 'https://' || dm.hostname || '/' || u.slug, 'ativa', u.is_active,
                        'protegida', u.protegida, 'estado_dominio', dm.status, 'no_rodizio', dm.no_rodizio,
                        'entregas', u.entregas)
                      order by dm.no_rodizio, dm.hostname)
                     from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
                     where u.link_id = l.id), '[]'::jsonb),
    'url_curta', (select 'https://' || dm.hostname || '/' || u.slug
                  from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
                  where u.link_id = l.id and u.is_active and dm.status = 'ativo'
                  order by dm.no_rodizio, dm.hostname limit 1),
    'protegido', exists (select 1 from public.lnk_urls u where u.link_id = l.id and u.protegida),
    'criado_em', l.created_at, 'atualizado_em', l.updated_at)
  from public.lnk_links l join public.lnk_projetos pr on pr.id = l.projeto_id
  where l.id = p_link_id
$$;
revoke execute on function public.lnk_link_snapshot(uuid) from public, anon, authenticated;

create or replace function public.lnk_historico_gravar(p_link_id uuid, p_acao text, p_campos text[], p_antes jsonb, p_depois jsonb)
returns void
language sql security definer set search_path to 'public'
as $$
  insert into public.lnk_link_historico (link_id, acao, campos, antes, depois, por, por_email)
  values (p_link_id, p_acao, coalesce(p_campos, '{}'), p_antes, p_depois, auth.uid(), auth.jwt()->>'email');
$$;
revoke execute on function public.lnk_historico_gravar(uuid, text, text[], jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. KV: link fora do ar vira PURGE (antes publicava valor vazio, que o
--    Worker tratava como miss mas deixava lixo no namespace)
-- ---------------------------------------------------------------------
create or replace function public.lnk_enfileirar_url(p_url_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare v_chave text; v_valor jsonb;
begin
  select 'l:' || d.hostname || ':' || u.slug into v_chave
  from public.lnk_urls u join public.lnk_dominios d on d.id = u.dominio_id
  where u.id = p_url_id;
  if v_chave is null then return; end if;

  v_valor := public.lnk_montar_cache(p_url_id);

  -- o unique parcial em (chave) colapsa edicoes repetidas em vez de empilhar
  insert into public.lnk_kv_fila (tipo, chave, valor, versao)
  values (case when v_valor is null then 'purge' else 'link' end, v_chave, v_valor,
          extract(epoch from clock_timestamp())::bigint)
  on conflict (chave) where status in ('pendente','enviando')
  do update set tipo = excluded.tipo, valor = excluded.valor, versao = excluded.versao,
                status = 'pendente', tentativas = 0, erro = null, criado_em = now();
end $$;

create or replace function public.lnk_kv_worker(p_lote integer default 25)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  v_tok text; v_acc text; v_ns text := '4529e1b8422148a99b660693c54c2bbe';
  r record; v_resp extensions.http_response; v_ok int := 0; v_erro int := 0; v_url text;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name='cloudflare_api_token_hx';
  select decrypted_secret into v_acc from vault.decrypted_secrets where name='cloudflare_account_id_hx';
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'sem credencial'); end if;

  for r in
    update public.lnk_kv_fila f set status='enviando', tentativas = f.tentativas + 1
    where f.id in (select id from public.lnk_kv_fila
                   where status = 'pendente' and tentativas < 5
                   order by id limit p_lote for update skip locked)
    returning f.*
  loop
    begin
      v_url := 'https://api.cloudflare.com/client/v4/accounts/'||v_acc||'/storage/kv/namespaces/'||v_ns||
               '/values/'||replace(replace(r.chave,':','%3A'),'/','%2F');
      if r.tipo = 'purge' then
        v_resp := extensions.http((
          'DELETE', v_url,
          array[extensions.http_header('Authorization','Bearer '||v_tok)],
          'text/plain', ''
        )::extensions.http_request);
      else
        v_resp := extensions.http((
          'PUT', v_url,
          array[extensions.http_header('Authorization','Bearer '||v_tok)],
          'text/plain',
          coalesce(r.valor::text, '')
        )::extensions.http_request);
      end if;

      -- purge de chave que ja nao existe (404) e sucesso: o objetivo era nao estar la
      if v_resp.status between 200 and 299 or (r.tipo = 'purge' and v_resp.status = 404) then
        update public.lnk_kv_fila set status='ok', sincronizado_em=now(), erro=null where id = r.id;
        v_ok := v_ok + 1;
      else
        update public.lnk_kv_fila set status='pendente', erro=left(v_resp.content,300) where id = r.id;
        v_erro := v_erro + 1;
      end if;
    exception when others then
      update public.lnk_kv_fila set status='pendente', erro=left(sqlerrm,300) where id = r.id;
      v_erro := v_erro + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'publicados', v_ok, 'falhas', v_erro);
end $$;

-- ---------------------------------------------------------------------
-- 5. Resolver: link pausado cai no destino_expirado do link, se houver,
--    antes do destino_404 do dominio
-- ---------------------------------------------------------------------
create or replace function public.lnk_edge_resolver(p_token text, p_host text, p_slug text)
returns jsonb
language plpgsql stable security definer set search_path to 'public', 'extensions'
as $$
declare v_dom public.lnk_dominios%rowtype; v_url public.lnk_urls%rowtype; v_out jsonb; v_exp text;
begin
  if public.lnk_edge_auth(p_token, 'resolver') is null then
    return jsonb_build_object('ok', false, 'erro', 'nao_autorizado');
  end if;
  select * into v_dom from public.lnk_dominios where hostname = lower(coalesce(p_host,'')) limit 1;
  if not found then return jsonb_build_object('ok', false, 'erro', 'dominio_desconhecido'); end if;
  if v_dom.status in ('banido','removido') then
    return jsonb_build_object('ok', false, 'erro', 'dominio_inativo',
      'dominio_id', v_dom.id, 'projeto_id', v_dom.projeto_id,
      'destino_panico', v_dom.destino_panico);
  end if;
  select * into v_url from public.lnk_urls
   where dominio_id = v_dom.id and slug = lower(coalesce(p_slug,'')) and is_active limit 1;
  if not found then
    -- devolve o dominio mesmo sem link: assim o acesso perdido continua
    -- contando na tabela por dominio, que e o alarme de bloqueio
    return jsonb_build_object('ok', false, 'erro', 'slug_inexistente',
      'dominio_id', v_dom.id, 'projeto_id', v_dom.projeto_id,
      'destino_404', v_dom.destino_404, 'destino_panico', v_dom.destino_panico);
  end if;
  v_out := public.lnk_montar_cache(v_url.id);
  if v_out is null then
    select destino_expirado into v_exp from public.lnk_links where id = v_url.link_id;
    return jsonb_build_object('ok', false, 'erro', 'link_inativo',
      'dominio_id', v_dom.id, 'projeto_id', v_dom.projeto_id, 'link_id', v_url.link_id,
      'destino_404', coalesce(v_exp, v_dom.destino_404), 'destino_panico', v_dom.destino_panico);
  end if;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- 6. lnk_link_editar(link, patch): so o que veio no patch muda.
--    patch: {nome, divisao, merge_query, query_whitelist[], tags[], observacao,
--            expira_em|null, destino_expirado|null, is_destino_de_anuncio,
--            preview{modo,titulo,desc,img},
--            destinos[{id?, url, rotulo?, peso?, ativo?}],   (lista completa)
--            params[{chave, valor, modo?, destino_id?|rotulo_destino?}]} (lista completa)
-- ---------------------------------------------------------------------
create or replace function public.lnk_link_editar(p_link_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  l public.lnk_links%rowtype; v_antes jsonb; v_depois jsonb; v_campos text[];
  d jsonb; p jsonb; v_ids uuid[] := '{}'; v_dest uuid; v_i int := 0;
  v_tags text[]; v_prev jsonb; v_modo text; v_ativos int; v_aviso text[] := '{}';
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  select * into l from public.lnk_links where id = p_link_id;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Link não encontrado.'); end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    return jsonb_build_object('ok', false, 'erro', 'Nada pra alterar.');
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_campos from jsonb_object_keys(p_patch) k;

  -- ---------- validacao completa ANTES de qualquer escrita ----------
  if p_patch ? 'nome' and coalesce(trim(p_patch->>'nome'), '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'O link precisa de um nome pra você achar depois.');
  end if;
  if p_patch ? 'divisao' and coalesce(p_patch->>'divisao', '') not in ('clique', 'pessoa') then
    return jsonb_build_object('ok', false, 'erro', 'Divisão precisa ser "clique" ou "pessoa".');
  end if;
  if p_patch ? 'merge_query' and coalesce(p_patch->>'merge_query', '') not in ('append', 'ignorar', 'whitelist') then
    return jsonb_build_object('ok', false, 'erro', 'Query de entrada: "append", "ignorar" ou "whitelist".');
  end if;
  if p_patch ? 'destino_expirado' and nullif(p_patch->>'destino_expirado', '') is not null
     and p_patch->>'destino_expirado' !~ '^https://' then
    return jsonb_build_object('ok', false, 'erro', 'O destino de link expirado precisa começar com https://.');
  end if;
  if p_patch ? 'expira_em' and nullif(p_patch->>'expira_em', '') is not null then
    begin
      perform (p_patch->>'expira_em')::timestamptz;
    exception when others then
      return jsonb_build_object('ok', false, 'erro', 'Data de expiração inválida.');
    end;
    if (p_patch->>'expira_em')::timestamptz < now() then
      v_aviso := v_aviso || 'A data de expiração já passou: o link expira agora.';
    end if;
  end if;
  if p_patch ? 'preview' then
    v_prev := p_patch->'preview';
    if v_prev is null or jsonb_typeof(v_prev) <> 'object' then
      return jsonb_build_object('ok', false, 'erro', 'Preview precisa ser um objeto {modo, titulo, desc, img}.');
    end if;
    v_modo := coalesce(v_prev->>'modo', l.preview_mode::text);
    if v_modo not in ('passthrough', 'card_proprio', 'bloquear') then
      return jsonb_build_object('ok', false, 'erro', 'Modo de preview: "passthrough", "card_proprio" ou "bloquear".');
    end if;
    if v_modo = 'card_proprio' and coalesce((p_patch->>'is_destino_de_anuncio')::boolean, l.is_destino_de_anuncio) then
      return jsonb_build_object('ok', false, 'erro',
        'Link marcado como destino de anúncio não pode usar card próprio: o robô da Meta veria uma coisa e a pessoa outra (cloaking). Tira a marcação ou usa passthrough.');
    end if;
    if nullif(v_prev->>'img', '') is not null and v_prev->>'img' !~ '^https://' then
      return jsonb_build_object('ok', false, 'erro', 'A imagem do preview precisa começar com https://.');
    end if;
  elsif p_patch ? 'is_destino_de_anuncio' and (p_patch->>'is_destino_de_anuncio')::boolean and l.preview_mode = 'card_proprio' then
    return jsonb_build_object('ok', false, 'erro',
      'Esse link usa card próprio no preview; antes de marcar como destino de anúncio, troca o preview pra passthrough.');
  end if;
  if p_patch ? 'destinos' then
    if jsonb_typeof(p_patch->'destinos') <> 'array' then
      return jsonb_build_object('ok', false, 'erro', 'Destinos precisa ser uma lista.');
    end if;
    v_ativos := 0;
    for d in select * from jsonb_array_elements(p_patch->'destinos') loop
      if coalesce(d->>'url', '') !~* '^https?://[^/[:space:]]+' then
        return jsonb_build_object('ok', false, 'erro',
          'Todo destino precisa começar com http:// ou https://. Confere: '
          || coalesce(nullif(trim(coalesce(d->>'url', '')), ''), '(em branco)'));
      end if;
      if coalesce((d->>'peso')::int, 100) < 0 then
        return jsonb_build_object('ok', false, 'erro', 'Peso não pode ser negativo.');
      end if;
      if nullif(d->>'id', '') is not null
         and not exists (select 1 from public.lnk_destinos x where x.id = (d->>'id')::uuid and x.link_id = p_link_id) then
        return jsonb_build_object('ok', false, 'erro', 'Um dos destinos da lista não pertence a este link.');
      end if;
      if coalesce((d->>'ativo')::boolean, true) and coalesce((d->>'peso')::int, 100) > 0 then
        v_ativos := v_ativos + 1;
      end if;
    end loop;
    if v_ativos = 0 then
      return jsonb_build_object('ok', false, 'erro',
        'O link ficaria sem nenhum destino ativo com peso. Pra tirar do ar, usa Pausar.');
    end if;
  end if;
  if p_patch ? 'params' then
    if jsonb_typeof(p_patch->'params') <> 'array' then
      return jsonb_build_object('ok', false, 'erro', 'Parâmetros precisa ser uma lista.');
    end if;
    for p in select * from jsonb_array_elements(p_patch->'params') loop
      if coalesce(p->>'chave', '') !~ '^[A-Za-z0-9_.-]{1,64}$' then
        return jsonb_build_object('ok', false, 'erro',
          'Parâmetro com nome inválido: "' || coalesce(p->>'chave', '') || '" (letras, números, ponto, traço e sublinhado).');
      end if;
    end loop;
  end if;
  if p_patch ? 'tags' then
    if jsonb_typeof(p_patch->'tags') <> 'array' then
      return jsonb_build_object('ok', false, 'erro', 'Tags precisa ser uma lista.');
    end if;
    select coalesce(array_agg(distinct t order by t), '{}') into v_tags
      from (select lower(trim(x)) t from jsonb_array_elements_text(p_patch->'tags') x where trim(x) <> '') s;
    if coalesce(array_length(v_tags, 1), 0) > 10 then
      return jsonb_build_object('ok', false, 'erro', 'No máximo 10 tags por link.');
    end if;
    if exists (select 1 from unnest(v_tags) t where length(t) > 30 or t !~ '^[a-z0-9][a-z0-9 _.-]*$') then
      return jsonb_build_object('ok', false, 'erro',
        'Tag só com letras minúsculas, números, espaço, ponto, traço ou sublinhado, até 30 caracteres.');
    end if;
  end if;

  -- ---------- escrita ----------
  v_antes := public.lnk_link_snapshot(p_link_id);

  update public.lnk_links set
    nome = case when p_patch ? 'nome' then trim(p_patch->>'nome') else nome end,
    divisao = coalesce(p_patch->>'divisao', divisao),
    merge_query = coalesce(p_patch->>'merge_query', merge_query),
    query_whitelist = case when p_patch ? 'query_whitelist'
                           then coalesce((select array_agg(x) from jsonb_array_elements_text(p_patch->'query_whitelist') x), '{}')
                           else query_whitelist end,
    tags = case when p_patch ? 'tags' then v_tags else tags end,
    observacao = case when p_patch ? 'observacao' then nullif(trim(p_patch->>'observacao'), '') else observacao end,
    expira_em = case when p_patch ? 'expira_em' then nullif(p_patch->>'expira_em', '')::timestamptz else expira_em end,
    destino_expirado = case when p_patch ? 'destino_expirado' then nullif(trim(p_patch->>'destino_expirado'), '') else destino_expirado end,
    is_destino_de_anuncio = coalesce((p_patch->>'is_destino_de_anuncio')::boolean, is_destino_de_anuncio),
    preview_mode = case when v_prev ? 'modo' then (v_prev->>'modo')::public.lnk_preview_mode else preview_mode end,
    preview_titulo = case when v_prev ? 'titulo' then nullif(trim(v_prev->>'titulo'), '') else preview_titulo end,
    preview_desc = case when v_prev ? 'desc' then nullif(trim(v_prev->>'desc'), '') else preview_desc end,
    preview_img = case when v_prev ? 'img' then nullif(trim(v_prev->>'img'), '') else preview_img end,
    updated_at = now()
  where id = p_link_id;

  if p_patch ? 'destinos' then
    v_i := 0;
    for d in select * from jsonb_array_elements(p_patch->'destinos') loop
      v_i := v_i + 1;
      if nullif(d->>'id', '') is not null then
        -- so grava se mudou: updated_at e a janela do "peso real x configurado"
        update public.lnk_destinos set
          url = d->>'url', rotulo = nullif(trim(coalesce(d->>'rotulo', '')), ''),
          peso = coalesce((d->>'peso')::int, peso),
          is_active = coalesce((d->>'ativo')::boolean, is_active),
          ordem = v_i, updated_at = now()
        where id = (d->>'id')::uuid and link_id = p_link_id
          and (url is distinct from d->>'url'
               or rotulo is distinct from nullif(trim(coalesce(d->>'rotulo', '')), '')
               or peso is distinct from coalesce((d->>'peso')::int, peso)
               or is_active is distinct from coalesce((d->>'ativo')::boolean, is_active)
               or ordem is distinct from v_i);
        v_ids := v_ids || (d->>'id')::uuid;
      else
        insert into public.lnk_destinos (link_id, url, rotulo, peso, ordem, is_active)
        values (p_link_id, d->>'url', nullif(trim(coalesce(d->>'rotulo', '')), ''),
                coalesce((d->>'peso')::int, 100), v_i, coalesce((d->>'ativo')::boolean, true))
        returning id into v_dest;
        v_ids := v_ids || v_dest;
      end if;
    end loop;
    -- quem saiu da lista e desligado, nunca apagado: os cliques apontam pra ele
    update public.lnk_destinos set is_active = false, updated_at = now()
     where link_id = p_link_id and is_active and not (id = any(v_ids));
  end if;

  if p_patch ? 'params' then
    delete from public.lnk_params where link_id = p_link_id;
    v_i := 0;
    for p in select * from jsonb_array_elements(p_patch->'params') loop
      v_i := v_i + 1;
      v_dest := null;
      if nullif(p->>'destino_id', '') is not null then
        select id into v_dest from public.lnk_destinos where id = (p->>'destino_id')::uuid and link_id = p_link_id;
      elsif nullif(p->>'rotulo_destino', '') is not null then
        select id into v_dest from public.lnk_destinos
         where link_id = p_link_id and rotulo = p->>'rotulo_destino' order by ordem limit 1;
      end if;
      if v_dest is null and (nullif(p->>'destino_id', '') is not null or nullif(p->>'rotulo_destino', '') is not null) then
        v_aviso := v_aviso || ('O parâmetro "' || (p->>'chave') || '" apontava pra um destino que não existe mais; ficou valendo pra todos.');
      end if;
      insert into public.lnk_params (link_id, destino_id, chave, valor, modo, ordem)
      values (p_link_id, v_dest, p->>'chave', coalesce(p->>'valor', ''),
              case when p->>'modo' in ('sobrescrever', 'se_ausente') then p->>'modo' else 'sobrescrever' end, v_i);
    end loop;
  end if;

  v_depois := public.lnk_link_snapshot(p_link_id);
  perform public.lnk_historico_gravar(p_link_id, 'editado', v_campos, v_antes, v_depois);
  return jsonb_build_object('ok', true, 'link', v_depois, 'campos', to_jsonb(v_campos),
    'aviso', case when coalesce(array_length(v_aviso, 1), 0) > 0 then array_to_string(v_aviso, ' ') end,
    'propagacao', 'a borda atualiza em até 90 s (cache do Worker 30 s + KV 60 s)');
end $$;
revoke execute on function public.lnk_link_editar(uuid, jsonb) from public, anon;
grant execute on function public.lnk_link_editar(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. lnk_link_estado(link, 'ativo' | 'pausado' | 'congelado', forcar)
--    pausado  = sai do ar (vai pro destino_expirado do link ou 404 do dominio)
--    congelado = continua no ar, cache longo na borda (config nao muda)
-- ---------------------------------------------------------------------
create or replace function public.lnk_link_estado(p_link_id uuid, p_estado text, p_forcar boolean default false)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare l public.lnk_links%rowtype; v_antes jsonb; v_depois jsonb; v_prot boolean;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  select * into l from public.lnk_links where id = p_link_id;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Link não encontrado.'); end if;
  if coalesce(p_estado, '') not in ('ativo', 'pausado', 'congelado') then
    return jsonb_build_object('ok', false, 'erro', 'Estado: "ativo", "pausado" ou "congelado".');
  end if;
  select exists (select 1 from public.lnk_urls u where u.link_id = p_link_id and u.protegida) into v_prot;
  if p_estado = 'pausado' and v_prot and not p_forcar then
    return jsonb_build_object('ok', false, 'precisa_forcar', true, 'erro',
      'Esse link tem URL protegida em produção (está colado num pop-up ou material fora do Send). Pausar tira isso do ar. Se for isso mesmo, confirma forçando.');
  end if;
  v_antes := public.lnk_link_snapshot(p_link_id);
  update public.lnk_links
     set is_active = (p_estado <> 'pausado'),
         congelado = (p_estado = 'congelado'),
         updated_at = now()
   where id = p_link_id;
  v_depois := public.lnk_link_snapshot(p_link_id);
  perform public.lnk_historico_gravar(p_link_id, 'estado', array[p_estado], v_antes, v_depois);
  return jsonb_build_object('ok', true, 'link', v_depois, 'estado', p_estado,
    'propagacao', case when p_estado = 'pausado'
      then 'quem clicar nos próximos 90 s ainda pode entrar (cache da borda); depois disso vai pro destino de expirado ou pra página do domínio'
      else 'a borda atualiza em até 90 s' end);
end $$;
revoke execute on function public.lnk_link_estado(uuid, text, boolean) from public, anon;
grant execute on function public.lnk_link_estado(uuid, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. lnk_url_custom(link, dominio, slug, forcar): cria ou renomeia o slug
--    do link naquele dominio. Renomear com clique/entrega exige forcar;
--    URL protegida nao renomeia nunca.
-- ---------------------------------------------------------------------
create or replace function public.lnk_url_custom(p_link_id uuid, p_hostname text, p_slug text, p_forcar boolean default false)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_dom public.lnk_dominios%rowtype; u public.lnk_urls%rowtype; l public.lnk_links%rowtype;
  v_cliques bigint; v_antes jsonb; v_depois jsonb; v_old text;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  select * into l from public.lnk_links where id = p_link_id;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Link não encontrado.'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9_-]{2,39}$' then
    return jsonb_build_object('ok', false, 'erro',
      'Slug: de 3 a 40 caracteres, só letras minúsculas, números, traço e sublinhado, começando com letra ou número.');
  end if;
  if v_slug = any (array['api','admin','app','login','logout','static','assets','www','health','status',
                         'dev','test','null','undefined','robots','favicon','sitemap','warm']) then
    return jsonb_build_object('ok', false, 'erro', 'Esse slug é reservado. Escolhe outro.');
  end if;
  select * into v_dom from public.lnk_dominios where hostname = lower(trim(coalesce(p_hostname, '')));
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Domínio não cadastrado: ' || coalesce(p_hostname, '(vazio)'));
  end if;
  if v_dom.status in ('banido', 'removido') then
    return jsonb_build_object('ok', false, 'erro', 'Esse domínio está ' || v_dom.status || '; não dá pra criar URL nele.');
  end if;
  if v_dom.projeto_id is not null and v_dom.projeto_id <> l.projeto_id then
    return jsonb_build_object('ok', false, 'erro', 'Esse domínio pertence a outro projeto.');
  end if;

  v_antes := public.lnk_link_snapshot(p_link_id);
  select * into u from public.lnk_urls where link_id = p_link_id and dominio_id = v_dom.id;
  if found then
    if u.slug = v_slug then
      return jsonb_build_object('ok', true, 'sem_mudanca', true, 'url', 'https://' || v_dom.hostname || '/' || v_slug,
                                'link', v_antes);
    end if;
    if u.protegida then
      return jsonb_build_object('ok', false, 'erro',
        'Esse slug está protegido: é o que está colado em produção (pop-up, GTM, material). Não dá pra renomear. Se precisar de outro endereço, cria um link novo.');
    end if;
    select count(*) into v_cliques from public.lnk_cliques c
     where c.link_id = p_link_id and c.dominio_id = v_dom.id and c.url_id = u.id;
    if (v_cliques > 0 or u.entregas > 0) and not p_forcar then
      return jsonb_build_object('ok', false, 'precisa_forcar', true, 'erro',
        format('Essa URL já recebeu %s clique(s) e %s entrega(s). Renomear quebra quem já tem o link antigo. Se for isso mesmo, confirma forçando.',
               v_cliques, u.entregas));
    end if;
    v_old := u.slug;
    begin
      update public.lnk_urls set slug = v_slug where id = u.id;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'erro', 'O slug "' || v_slug || '" já está em uso em ' || v_dom.hostname || '.');
    end;
    -- a chave nova entra pelo trigger; a antiga precisa sair do KV
    insert into public.lnk_kv_fila (tipo, chave, valor, versao)
    values ('purge', 'l:' || v_dom.hostname || ':' || v_old, null, extract(epoch from clock_timestamp())::bigint)
    on conflict (chave) where status in ('pendente', 'enviando')
    do update set tipo = 'purge', valor = null, versao = excluded.versao,
                  status = 'pendente', tentativas = 0, erro = null, criado_em = now();
  else
    begin
      insert into public.lnk_urls (link_id, dominio_id, slug) values (p_link_id, v_dom.id, v_slug);
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'erro', 'O slug "' || v_slug || '" já está em uso em ' || v_dom.hostname || '.');
    end;
  end if;

  v_depois := public.lnk_link_snapshot(p_link_id);
  perform public.lnk_historico_gravar(p_link_id, 'slug', array[v_dom.hostname, coalesce(v_old, '') || '>' || v_slug], v_antes, v_depois);
  return jsonb_build_object('ok', true, 'url', 'https://' || v_dom.hostname || '/' || v_slug,
    'renomeado_de', v_old, 'link', v_depois,
    'propagacao', 'a borda passa a responder no slug novo em até 90 s; o antigo para de responder no mesmo prazo');
end $$;
revoke execute on function public.lnk_url_custom(uuid, text, text, boolean) from public, anon;
grant execute on function public.lnk_url_custom(uuid, text, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 9. lnk_criar v2: mesmos 6 parametros de antes (o front atual continua
--    funcionando) + slug custom, dominio, tags, observacao, expiracao,
--    preview. A assinatura antiga e removida: manter as duas deixaria o
--    PostgREST em duvida (300 ambiguous) quando o front manda so as 6.
-- ---------------------------------------------------------------------
drop function if exists public.lnk_criar(text, text, jsonb, jsonb, text, text);

create or replace function public.lnk_criar(
  p_projeto text, p_nome text, p_destinos jsonb,
  p_params jsonb default '[]'::jsonb, p_divisao text default 'clique', p_merge_query text default 'append',
  p_slug text default null, p_dominio text default null, p_tags jsonb default '[]'::jsonb,
  p_observacao text default null, p_expira_em timestamptz default null, p_preview jsonb default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_proj uuid; v_link uuid; d jsonb; p jsonb; v_dest uuid; v_i int := 0; v_urls int; v_rot text;
        v_extras jsonb := '{}'::jsonb; r jsonb; v_dom text;
begin
  if not public.mod_is_operador() then raise exception 'sem permissao' using errcode = '42501'; end if;
  if coalesce(trim(p_nome), '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'O link precisa de um nome pra você achar depois.');
  end if;
  if p_destinos is null or jsonb_array_length(p_destinos) = 0 then
    return jsonb_build_object('ok', false, 'erro', 'Um link precisa de pelo menos um destino.');
  end if;
  if coalesce(p_divisao, '') not in ('clique', 'pessoa') then
    return jsonb_build_object('ok', false, 'erro', 'Divisão precisa ser "clique" ou "pessoa".');
  end if;
  if coalesce(p_merge_query, '') not in ('append', 'ignorar', 'whitelist') then
    return jsonb_build_object('ok', false, 'erro', 'Query de entrada: "append", "ignorar" ou "whitelist".');
  end if;

  for d in select * from jsonb_array_elements(p_destinos) loop
    if coalesce(d->>'url', '') !~* '^https?://[^/[:space:]]+' then
      return jsonb_build_object('ok', false,
        'erro', 'Todo destino precisa começar com http:// ou https://. Confere: '
                || coalesce(nullif(trim(coalesce(d->>'url', '')), ''), '(em branco)'));
    end if;
    if coalesce((d->>'peso')::int, 100) < 0 then
      return jsonb_build_object('ok', false, 'erro', 'Peso não pode ser negativo.');
    end if;
  end loop;

  select id into v_proj from public.lnk_projetos where slug = p_projeto and is_active;
  if v_proj is null then
    return jsonb_build_object('ok', false, 'erro', 'Projeto não encontrado: ' || coalesce(p_projeto, '(vazio)'));
  end if;

  -- slug custom: valida ANTES de criar qualquer coisa
  if nullif(trim(coalesce(p_slug, '')), '') is not null then
    v_dom := lower(trim(coalesce(p_dominio, '')));
    if v_dom = '' then
      -- dominio institucional (fora do rodizio) primeiro; e onde link avulso mora
      select hostname into v_dom from public.lnk_dominios
       where status = 'ativo' and (projeto_id = v_proj or projeto_id is null)
       order by no_rodizio, hostname limit 1;
    end if;
    if v_dom is null then
      return jsonb_build_object('ok', false, 'erro', 'Nenhum domínio ativo pra receber o slug.');
    end if;
    if lower(trim(p_slug)) !~ '^[a-z0-9][a-z0-9_-]{2,39}$' then
      return jsonb_build_object('ok', false, 'erro',
        'Slug: de 3 a 40 caracteres, só letras minúsculas, números, traço e sublinhado, começando com letra ou número.');
    end if;
    if exists (select 1 from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
                where dm.hostname = v_dom and u.slug = lower(trim(p_slug))) then
      return jsonb_build_object('ok', false, 'erro', 'O slug "' || lower(trim(p_slug)) || '" já está em uso em ' || v_dom || '.');
    end if;
  end if;

  insert into public.lnk_links (projeto_id, nome, divisao, merge_query, criado_por)
  values (v_proj, trim(p_nome), p_divisao, p_merge_query, auth.uid()) returning id into v_link;

  for d in select * from jsonb_array_elements(p_destinos) loop
    v_i := v_i + 1;
    insert into public.lnk_destinos (link_id, url, rotulo, peso, ordem)
    values (v_link, d->>'url', nullif(trim(coalesce(d->>'rotulo', '')), ''),
            coalesce((d->>'peso')::int, 100), v_i);
  end loop;

  for p in select * from jsonb_array_elements(coalesce(p_params, '[]'::jsonb)) loop
    v_rot := nullif(p->>'rotulo_destino', '');
    v_dest := null;
    if v_rot is not null then
      select id into v_dest from public.lnk_destinos where link_id = v_link and rotulo = v_rot;
      if v_dest is null then
        raise exception 'Não existe destino com o rótulo "%" neste link.', v_rot;
      end if;
    end if;
    insert into public.lnk_params (link_id, destino_id, chave, valor, modo, ordem)
    values (v_link, v_dest, p->>'chave', p->>'valor',
            coalesce(nullif(p->>'modo', ''), 'sobrescrever'), coalesce((p->>'ordem')::int, 0));
  end loop;

  v_urls := public.lnk_sincronizar_urls(v_link);
  perform public.lnk_historico_gravar(v_link, 'criado', '{}', null, public.lnk_link_snapshot(v_link));

  -- extras passam pelo mesmo validador do editar; erro la desfaz tudo aqui
  if p_tags is not null and jsonb_typeof(p_tags) = 'array' and jsonb_array_length(p_tags) > 0 then v_extras := v_extras || jsonb_build_object('tags', p_tags); end if;
  if nullif(trim(coalesce(p_observacao, '')), '') is not null then v_extras := v_extras || jsonb_build_object('observacao', p_observacao); end if;
  if p_expira_em is not null then v_extras := v_extras || jsonb_build_object('expira_em', p_expira_em); end if;
  if p_preview is not null and jsonb_typeof(p_preview) = 'object' then v_extras := v_extras || jsonb_build_object('preview', p_preview); end if;
  if v_extras <> '{}'::jsonb then
    r := public.lnk_link_editar(v_link, v_extras);
    if not (r->>'ok')::boolean then raise exception '%', r->>'erro'; end if;
  end if;
  if nullif(trim(coalesce(p_slug, '')), '') is not null then
    r := public.lnk_url_custom(v_link, v_dom, p_slug, false);
    if not (r->>'ok')::boolean then raise exception '%', r->>'erro'; end if;
  end if;

  return jsonb_build_object('ok', true, 'id', v_link, 'urls_criadas', v_urls,
    'urls', (select jsonb_agg(jsonb_build_object('dominio', dm.hostname, 'slug', u.slug,
                                                 'url', 'https://' || dm.hostname || '/' || u.slug,
                                                 'estado', dm.status))
             from public.lnk_urls u join public.lnk_dominios dm on dm.id = u.dominio_id
             where u.link_id = v_link),
    'link', public.lnk_link_snapshot(v_link));
end $$;
revoke execute on function public.lnk_criar(text, text, jsonb, jsonb, text, text, text, text, jsonb, text, timestamptz, jsonb) from public, anon;
grant execute on function public.lnk_criar(text, text, jsonb, jsonb, text, text, text, text, jsonb, text, timestamptz, jsonb) to authenticated, service_role;
