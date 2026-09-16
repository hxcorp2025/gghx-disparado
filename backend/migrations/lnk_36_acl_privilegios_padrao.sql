-- lnk_36 (15/09/2026, 21h20 BR): ACL. Achado no gate do hotfix do SendFlow: no Supabase, função
-- nova em `public` nasce com EXECUTE pra anon, authenticated e service_role (ALTER DEFAULT
-- PRIVILEGES do projeto), e `revoke all ... from public` NÃO tira esses grants explícitos.
-- As funções da F3 (lnk_33..35) ficaram com anon = execute mesmo sem intenção. Nenhuma expõe
-- dado sem gate (todas checam mod_is_operador()/lnk_pode() ou o token por dentro; lnk_api_auth
-- só valida um token de 192 bits), mas o grant não deveria existir e eu afirmei ao revisor que
-- não existia. Regra daqui pra frente: TODA função nova em public leva
-- `revoke execute ... from public, anon, authenticated` e o grant explícito do que precisa.
--
-- Esta varredura é idempotente: revoga anon de toda lnk_*/sendflow_* fora da allowlist
-- (edge do Worker + API pública), e revoga authenticated dos helpers internos.
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and (p.proname like 'lnk\_%' or p.proname like 'sendflow\_%')
       and has_function_privilege('anon', p.oid, 'execute')
       and p.proname not in ('lnk_edge_resolver', 'lnk_edge_clique', 'lnk_api_criar', 'lnk_api_ler', 'lnk_api_listar', 'lnk_api_editar')
  loop
    execute format('revoke execute on function public.%I(%s) from anon', r.proname, r.args);
    n := n + 1;
  end loop;
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname in ('lnk_pode', 'lnk_api_auth', 'lnk_api_ve_projeto')
       and has_function_privilege('authenticated', p.oid, 'execute')
  loop
    execute format('revoke execute on function public.%I(%s) from authenticated', r.proname, r.args);
    n := n + 1;
  end loop;
  raise notice 'lnk_36: % revogações', n;
end $$;
