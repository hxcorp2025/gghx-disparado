-- lnk_35b (15/09/2026): bug pré-existente em lnk_link_editar (lnk_28/31), achado
-- pelo teste da API na F3: `v_aviso := v_aviso || 'A data de expiração já passou…'`
-- com literal de tipo unknown vira text[] || text[] e o Postgres tenta ler a frase
-- como array ("malformed array literal"). Efeito: editar expira_em pra uma data
-- passada estourava exceção no painel (nada gravado, erro feio) e {ok:false} na API.
-- O outro aviso da função já era text (concatenação), por isso nunca quebrou.
create or replace function pg_temp.conta(v text, s text) returns int language sql immutable as
  $$ select (length(v) - length(replace(v, s, ''))) / length(s) $$;

do $$
declare v text;
  s_old text := $x$v_aviso := v_aviso || 'A data de expiração já passou: o link expira agora.';$x$;
  s_new text := $x$v_aviso := v_aviso || 'A data de expiração já passou: o link expira agora.'::text;$x$;
begin
  v := pg_get_functiondef('public.lnk_link_editar'::regproc);
  if pg_temp.conta(v, s_old) <> 1 then raise exception 'lnk_35b: aviso em lnk_link_editar: % ocorrências', pg_temp.conta(v, s_old); end if;
  execute replace(v, s_old, s_new);
end $$;
