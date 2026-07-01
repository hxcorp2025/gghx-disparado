// Tipos espelhando o schema REAL verificado (2026-07-01) + vocabulário-alvo do Peterson.
//
// VOCABULÁRIO (Peterson):
//   Campanha = lista de grupos reutilizável (hoje tabela física `gghx_listas`)
//   Disparo  = evento de envio (hoje tabela física `gghx_campanhas` / `gghx_campanha_itens`)
// O rename físico das tabelas acontece no CUTOVER; até lá o data-layer (db.ts) mapeia.

export type Grupo = {
  group_id: string
  subject: string | null
  participantes: number | null
  is_admin: boolean | null
  ativo: boolean | null
  last_synced: string | null
  instancia: string | null // vira conta_id na Fase 3
  community_id: string | null
  is_announcement: boolean | null
}

// "Campanha" = lista salva de grupos (físico: gghx_listas)
export type Campanha = {
  id: number
  nome: string
  group_ids: string[]
  criado_por: string | null
  created_at: string | null
  // futuro (cutover): tags: string[]
}

export type MencaoTipo = 'fantasma' | 'all' | 'nenhuma'
export type MediaTipo = 'texto' | 'imagem' | 'video' | 'audio'
export type DisparoStatus =
  | 'rascunho'
  | 'agendado'
  | 'rodando'
  | 'pausada'
  | 'concluida'
  | 'cancelada'
  | 'erro'

// "Disparo" = evento de envio (físico: gghx_campanhas)
export type Disparo = {
  id: number
  nome: string | null
  mensagem: string
  tipo_mencao: MencaoTipo
  intervalo_seg: number
  jitter_seg: number
  status: DisparoStatus
  total: number | null
  enviados: number | null
  falhas: number | null
  criado_por: string | null
  criado_em: string | null
  iniciado_em: string | null
  concluido_em: string | null
  media_tipo: MediaTipo | null
  media_url: string | null
}

export type ItemStatus = 'pendente' | 'enviando' | 'enviado' | 'falha' | 'pulado'

// item de disparo (físico: gghx_campanha_itens)
export type DisparoItem = {
  id: number
  campanha_id: number // FK física p/ gghx_campanhas (o disparo)
  group_id: string
  subject: string | null
  ordem: number | null
  status: ItemStatus
  message_id: string | null
  enviado_em: string | null
  erro: string | null
}

// conta/número conectado (físico: gghx_contas na Fase 3; hoje derivado de gghx_grupos.instancia)
export type Conta = {
  id: string
  nome: string
  numero?: string | null
  status?: string | null
}
