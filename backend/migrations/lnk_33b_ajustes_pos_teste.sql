-- lnk_33b (15/09/2026): dois ajustes achados no teste da lnk_33.
-- 1. histórico: quando a chamada veio pela API, o ator é a chave (api:<nome>),
--    mesmo que exista JWT na sessão (a ação veio pela API, não pela tela).
-- 2. nome derivado da URL sem a barra final ("hx-corp.com/" virava nome feio).
create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

create or replace function public.lnk_historico_gravar(p_link_id uuid, p_acao text, p_campos text[], p_antes jsonb, p_depois jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.lnk_link_historico (link_id, acao, campos, antes, depois, por, por_email)
  values (p_link_id, p_acao, coalesce(p_campos, '{}'), p_antes, p_depois, auth.uid(),
          coalesce(nullif(current_setting('lnk.ator', true), ''), auth.jwt()->>'email'));
$$;

do $$
declare f text; v text;
  s_old text := $x$left(regexp_replace(regexp_replace(v_url, '^https?://(www\.)?', ''), '[?#].*$', ''), 80)$x$;
  s_new text := $x$left(rtrim(regexp_replace(regexp_replace(v_url, '^https?://(www\.)?', ''), '[?#].*$', ''), '/'), 80)$x$;
begin
  foreach f in array array['lnk_api_criar', 'lnk_criar_lote'] loop
    v := pg_get_functiondef(('public.' || f)::regproc);
    if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_33b: nome derivado em %: % ocorrências', f, pg_temp.conta(v, s_old); end if;
    execute replace(v, s_old, s_new);
  end loop;
end $$;
