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
} as const

export const MEDIA_BUCKET = 'gghx-midia'

// Flags de feature. Ligar quando o backend correspondente estiver no ar.
export const FEATURES = {
  // Agendamento: só ligar depois da coluna scheduled_at + poller n8n (HX-gghx-agendador) prontos.
  agendamento: false,
} as const
