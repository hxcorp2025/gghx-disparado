// ===== CONFIG =====
// anon key é pública por design (RLS protege). service_role e token Z-API NUNCA aqui — só no n8n.
export const CONFIG = {
  SUPABASE_URL: 'https://ntavetjmfotlwmcgwsju.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50YXZldGptZm90bHdtY2d3c2p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQwNTAzNDksImV4cCI6MjA1OTYyNjM0OX0.jWCJr4qPHjiun2BCdx8U4Oi7cQ2gQmU-D0vrk10FGao',
  N8N_BASE: 'https://n8n-n8n.sf6dqo.easypanel.host/webhook',
  // webhooks (nomes iguais aos atuais; parametrizados por conta na Fase 3)
  N8N_SYNC: 'https://n8n-n8n.sf6dqo.easypanel.host/webhook/HX-gghx-sync-grupos',
  N8N_DISPARAR: 'https://n8n-n8n.sf6dqo.easypanel.host/webhook/HX-gghx-disparar',
  N8N_CONEXAO: 'https://n8n-n8n.sf6dqo.easypanel.host/webhook/HX-gghx-conexao',
  N8N_SNAPSHOT: 'https://n8n-n8n.sf6dqo.easypanel.host/webhook/HX-gghx-snapshot',
  N8N_EXTRAS: 'https://n8n-n8n.sf6dqo.easypanel.host/webhook/HX-gghx-extras',
} as const

export const MEDIA_BUCKET = 'gghx-midia'

// PostHog (project token é write-only/público por design, safe no client)
export const POSTHOG_KEY = 'phc_zUH9XZoLvnhyRch9E37kTtNFZg3cdiV9PJ2ZjXCPxPMj'
export const POSTHOG_HOST = 'https://us.i.posthog.com'

// Flags de feature. Ligar quando o backend correspondente estiver no ar.
export const FEATURES = {
  // 🔴 DESLIGADO em 17/09/2026. Este agendamento era do WIZARD ANTIGO (motor próprio):
  // o poller gghx_fire_scheduled chamava um webhook n8n DESATIVADO desde 11/08 e ainda
  // pulava as guardas do motor Evolution (marcava a campanha como 'rodando' sem checar
  // janela, teto do chip nem disparo concorrente). Nunca foi usado: scheduled_at está
  // nulo em todas as campanhas. O cron 'gghx-agendador' (jobid 2) foi desligado junto
  // (religar: select cron.alter_job(2, active := true) + voltar esta flag pra true).
  // Agendar de verdade agora é na Mesa de Disparo, aba "Disparar cópias"
  // (PRD_mesa_agendar_disparo_2026-09-17).
  agendamento: false,
  // Multi-conta: só ligar depois de backend/multiconta.sql + motor parametrizado por conta.
  multiconta: false,
} as const
