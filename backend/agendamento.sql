-- ============================================================================
-- AGENDAMENTO de disparos (poller) — Supabase-native (pg_cron + pg_net)
-- Não depende de n8n. Rodar no Supabase → SQL Editor.
--
-- Como funciona: a cada minuto, pega disparos status='agendado' cujo
-- scheduled_at já passou, marca 'rodando' e chama o motor (que a partir daí
-- se auto-continua sozinho, respeitando intervalo/jitter). Respeita a trava de
-- 1 disparo rodando por chip.
-- ============================================================================

-- 1) Coluna (aditiva, idempotente)
ALTER TABLE gghx_campanhas ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
CREATE INDEX IF NOT EXISTS gghx_campanhas_agendado_idx
  ON gghx_campanhas (scheduled_at) WHERE status = 'agendado';

-- 2) Extensões (ou habilitar no Dashboard → Database → Extensions)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3) PRÉ-REQUISITO — guardar o segredo interno do motor no Vault.
--    Pegar o valor de ISECRET no n8n (motor HX-gghx-disparar, id 0W9yI1VhSE05G3HN,
--    Code node, const ISECRET='...') e rodar UMA vez:
--
--    SELECT upsert_secret('gghx_motor_isecret', '<VALOR_DO_ISECRET>', 'segredo interno do motor gghx');
--
--    (o poller lê via get_secret('gghx_motor_isecret'); o segredo NUNCA fica hardcoded aqui)

-- 4) Função que inicia os agendados vencidos (1 por vez, respeitando lock de chip)
CREATE OR REPLACE FUNCTION gghx_fire_scheduled() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  r record;
  sec text;
  motor text := 'https://n8n-n8n.sf6dqo.easypanel.host/webhook/HX-gghx-disparar';
BEGIN
  SELECT get_secret('gghx_motor_isecret') INTO sec;
  IF sec IS NULL THEN RAISE NOTICE 'gghx_motor_isecret ausente no Vault'; RETURN; END IF;

  FOR r IN
    SELECT id FROM gghx_campanhas
    WHERE status = 'agendado' AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
  LOOP
    -- trava: 1 disparo rodando por chip (o motor externo checa isso; o interno não)
    IF EXISTS (SELECT 1 FROM gghx_campanhas WHERE status = 'rodando') THEN EXIT; END IF;

    UPDATE gghx_campanhas
      SET status = 'rodando', iniciado_em = COALESCE(iniciado_em, now())
      WHERE id = r.id AND status = 'agendado';

    IF FOUND THEN
      PERFORM net.http_post(
        url := motor,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('campanha_id', r.id, 'internal', true, 'secret', sec)
      );
    END IF;
  END LOOP;
END $$;

-- 5) Agendar a cada minuto (idempotente: remove antes se já existir)
SELECT cron.unschedule('gghx-agendador') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gghx-agendador');
SELECT cron.schedule('gghx-agendador', '* * * * *', $$ SELECT gghx_fire_scheduled(); $$);

-- 6) Depois de aplicar: no frontend, ligar FEATURES.agendamento = true (src/lib/config.ts) e deployar.

-- ---- VALIDAÇÃO ----
-- Ver o job:            SELECT jobname, schedule, active FROM cron.job WHERE jobname='gghx-agendador';
-- Teste ponta a ponta:  criar um disparo agendado p/ +2min num grupo interno e ver iniciar sozinho.
-- Rollback do job:      SELECT cron.unschedule('gghx-agendador');
