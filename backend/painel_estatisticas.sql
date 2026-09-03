-- Painel de Estatisticas do Send (03/09/2026)
-- ============================================================================
-- POR QUE EXISTE
-- A tela lia o motor proprio (gghx_*), que a operacao abandonou: gghx_mensagens e
-- gghx_grupo_movimentos sem dado desde 13/07, gghx_grupos desde 11/08. Enquanto
-- isso o SendFlow, onde a operacao roda de verdade, mostrava 101 grupos e 70,53%
-- de taxa de entrada, e a tela mostrava 60 grupos e 0 entradas. O coletor do
-- SendFlow ja existia (desde 11/08) e chega sozinho; faltava a tela ler ele.
--
-- POR QUE UMA RPC, E NAO LEITURA DIRETA DAS VIEWS
--   a) as tabelas sendflow_* tem RLS ligado e ZERO policy: authenticated nao le
--      nenhuma delas (provado: anon recebe [] na tabela e 401 nas views);
--   b) sendflow_funil_dia esta filtrada em 2 release_id hardcoded, entao nao
--      serve pra faixa de topo, que precisa do total;
--   c) uma chamada evita a tela abrir 6 requisicoes e montar numero no cliente.
--
-- CONTRATO: so LEITURA de tabela local. Nunca chamar a SendAPI daqui: o
-- authenticated tem statement_timeout de 8s e a API deles bloqueia a key por
-- 1 HORA depois de uma rajada. Quem fala com a API e o worker (service_role).
--
-- MEDIDO: 77,5ms em 90 dias, 6.717 buffers, tudo shared hit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Receita: DUAS views de proposito
-- ---------------------------------------------------------------------------
-- sendflow_receita_comunidades_dia = historico completo, e o que o painel usa.
-- sendflow_impacto_receita_dia     = recorte de 45 dias, do jeito EXATO que o
--   card 1159 do dash 13 espera (ele faz "select dia, receita from ..." SEM
--   filtro de periodo, entao ampliar a janela mudaria aquele dashboard).
--
-- 🔴 O filtro de origem (source like 'comunidades%') existe nas DUAS. Mudou a
--    definicao de "receita de comunidade"? Mexer nas duas.
-- 🔴 O corte da view do card usa CURRENT_DATE (UTC), entao o primeiro ponto do
--    grafico e um dia PARCIAL (pega 19/07 a partir das 21h de Sao Paulo).
--    Corrigir isso muda o dashboard: proposta pendente pro Matheus, nao aplicar
--    de lado.

create or replace view public.sendflow_receita_comunidades_dia as
select data_br::date as dia,          -- text indexado; bate com o fuso de SP
       count(*) as vendas,
       round(sum(value), 0) as receita
from sortudao_comunidades
where source like 'comunidades%'
group by 1;

grant select on public.sendflow_receita_comunidades_dia to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. A RPC
-- ---------------------------------------------------------------------------
-- Gate mod_is_operador(), igual a todas as outras RPCs deste modulo.
--
-- 🔴 TESTAR ASSIM (senao o gate esconde erro de SQL dentro da funcao; foi como
--    uma versao com "order by" invalido quase foi ao ar):
--      begin;
--      set local role authenticated;
--      set local request.jwt.claims = '{"email":"matheus@hookmidia.com"}';
--      select sendflow_painel(28);
--      rollback;
--    Ressalva: "set local role" NAO aplica os ALTER ROLE SET, entao esse teste
--    nao prova o statement_timeout de 8s.
--
-- 🔴 GRUPO MORTO NAO E SO "sumiu_em": existem gids que voltaram item-not-found
--    num disparo e o coletor nunca carimbou sumiu_em. Eram 5 fantasmas segurando
--    2.174 pessoas nos cards de vivos. Contando os dois caminhos, o painel bate
--    EXATO com o SendFlow: 101 grupos, 37 cheios, 64 livres.
--    DIVIDA DO COLETOR: carimbar sumiu_em quando o progresso devolve item-not-found.
--
-- 🔴 NAO devolver retencao_pct de sendflow_saude_campanha: ela tem vies de
--    construcao. add_total da VIP 01 (16.936) e MENOR que a gente que esta dentro
--    (30.515), porque a API guarda janela parcial de adds mas os removes contam
--    quem entrou fora dela. Ela pintava a maior campanha viva de "-15,6%" e
--    premiava com "+37,2%" a que perdeu 23 dos 30 grupos.
--
-- 🔴 grupos_sumidos_periodo existe porque grupo banido NAO gera evento de saida:
--    as pessoas somem junto com o grupo. Sem esse aviso, a campanha destruida
--    aparece com o melhor saldo da tela. A tela usa isso pra marcar "saldo
--    incompleto" e pra nao acusar de sangria quem perdeu grupo na janela.
--    Pelo mesmo motivo a tela NAO oferece 90 dias: nessa janela o saldo inverte
--    o ranking (a janela tambem comeca antes do que a API registra).

-- A definicao vive no Supabase (7 migrations em 03/09/2026). Para ler a atual:
--   select prosrc from pg_proc where proname = 'sendflow_painel';
-- Para o front: src/lib/sendflowDb.ts -> sendflowPainel(dias)
