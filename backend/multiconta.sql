-- ============================================================================
-- MULTI-CONTA (Fase 3) — várias contas Z-API (números), cada disparo escolhe
-- de qual número sai; tag de origem por conta nos grupos.
-- Rodar no Supabase → SQL Editor, em janela de baixo tráfego, SEM disparo rodando.
-- Tudo idempotente. Aditivo (não dropa nada). Backfill preserva o estado atual.
-- ============================================================================

-- 1) Tabela de contas (1 linha por número/instância Z-API)
CREATE TABLE IF NOT EXISTS gghx_contas (
  id            text PRIMARY KEY,              -- slug: 'hxsend', 'conta2'...
  nome          text NOT NULL,                 -- exibição: "HxSend", "Disparador 2"
  numero        text,                          -- telefone (só display)
  -- nomes dos secrets no Vault (o motor lê via get_secret); segredo NUNCA fica em coluna
  vault_instance     text NOT NULL,            -- ex: 'zapi_hxsend_instance_id'
  vault_token        text NOT NULL,            -- ex: 'zapi_hxsend_instance_token'
  vault_client_token text NOT NULL DEFAULT 'zapi_account_client_token',
  status        text DEFAULT 'desconhecido',   -- connected/disconnected (atualizado pelo tracking)
  ativo         boolean DEFAULT true,
  criado_em     timestamptz DEFAULT now()
);
ALTER TABLE gghx_contas ENABLE ROW LEVEL SECURITY;
-- leitura pra usuário logado (nomes/numero/status; NÃO expõe segredo, que está no Vault)
DROP POLICY IF EXISTS gghx_contas_read ON gghx_contas;
CREATE POLICY gghx_contas_read ON gghx_contas FOR SELECT TO authenticated USING (true);

-- 2) Seed da conta atual (HxSend) referenciando os secrets que já existem no Vault
INSERT INTO gghx_contas (id, nome, numero, vault_instance, vault_token, vault_client_token, status)
VALUES ('hxsend', 'HxSend', NULL,
        'zapi_hxsend_instance_id', 'zapi_hxsend_instance_token', 'zapi_account_client_token', 'connected')
ON CONFLICT (id) DO NOTHING;

-- 3) conta_id nos grupos (= tag de origem) e no disparo (= quem envia)
ALTER TABLE gghx_grupos    ADD COLUMN IF NOT EXISTS conta_id text REFERENCES gghx_contas(id);
ALTER TABLE gghx_campanhas ADD COLUMN IF NOT EXISTS conta_id text REFERENCES gghx_contas(id);

-- backfill: tudo que existe hoje é da HxSend
UPDATE gghx_grupos    SET conta_id = 'hxsend' WHERE conta_id IS NULL;
UPDATE gghx_campanhas SET conta_id = 'hxsend' WHERE conta_id IS NULL;

CREATE INDEX IF NOT EXISTS gghx_grupos_conta_idx    ON gghx_grupos (conta_id);
CREATE INDEX IF NOT EXISTS gghx_campanhas_conta_idx ON gghx_campanhas (conta_id);

-- ---- VALIDAÇÃO ----
-- SELECT id, nome, status, ativo FROM gghx_contas;
-- SELECT conta_id, count(*) FROM gghx_grupos GROUP BY conta_id;
-- SELECT conta_id, count(*) FROM gghx_campanhas GROUP BY conta_id;

-- ============================================================================
-- Depois deste SQL, faltam (ver backend/README.md → seção Multi-conta):
--   A) Motor: resolver ZBASE/ZCLIENT por conta (lê gghx_contas + get_secret), e
--      trocar o LOCK de "1 rodando global" para "1 rodando POR conta_id".
--   B) Sync/Conexão: aceitar conta_id (grava tag de origem / conecta a instância certa).
--   C) Partner API: criar novas instâncias e gravar secrets + linha em gghx_contas.
--   D) Frontend: FEATURES.multiconta = true (liga seletor de número real + envia conta_id).
-- ============================================================================
