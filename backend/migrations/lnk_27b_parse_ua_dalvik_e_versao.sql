-- =====================================================================
-- lnk_27b: correcao do gate de paridade + versao das regras num lugar so
-- (aplicada em 15/09/2026 logo depois da lnk_27)
--
-- 1. App Android que fala "Dalvik/2.1.0 (Linux; U; Android 12; ...)" nao
--    manda "Mobile" e caia em tablet pela regra "Android sem Mobile".
--    Regra nova: Android sem Mobile E sem Dalvik = tablet.
-- 2. lnk_ua_v() devolve a versao atual das regras (2). O Worker tem UA_V
--    com o mesmo numero. Mudou regra: sobe os dois e roda
--    select lnk_reclassificar_ua(lnk_ua_v());
--
-- O corpo de lnk_parse_ua e lnk_edge_clique e o da lnk_27 com essas duas
-- mudancas; a fonte completa aplicada esta no historico de migrations do
-- Supabase (lnk_27b_parse_ua_dalvik_e_versao).
-- =====================================================================
create or replace function public.lnk_ua_v() returns smallint language sql immutable as $$ select 2::smallint $$;
revoke execute on function public.lnk_ua_v() from public, anon, authenticated;

-- em lnk_parse_ua:
--   if ua ~* 'iPad|Tablet' or (ua ~* 'Android' and ua !~* 'Mobile|Dalvik') then v_dev := 'tablet';
-- em lnk_edge_clique:
--   coalesce((p_evento->>'ua_v')::smallint, case when v_p <> '{}'::jsonb then public.lnk_ua_v() end)
