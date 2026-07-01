import { sb } from './supabase'
import { CONFIG } from './config'
import type { Grupo, Campanha, Disparo, DisparoItem } from './types'

// ===== Tabelas físicas (ponto único do rename no CUTOVER) =====
// Hoje: "campanha" (lista) = gghx_listas ; "disparo" (envio) = gghx_campanhas/gghx_campanha_itens
const T = {
  grupos: 'gghx_grupos',
  campanhas: 'gghx_listas', // lista de grupos reutilizável
  disparos: 'gghx_campanhas', // evento de envio
  disparoItens: 'gghx_campanha_itens',
  movimentos: 'gghx_grupo_movimentos',
  instanciaStatus: 'gghx_instancia_status',
} as const

async function token(): Promise<string> {
  const { data } = await sb.auth.getSession()
  return data.session?.access_token ?? ''
}

// ===== GRUPOS =====
export async function listGrupos(): Promise<Grupo[]> {
  const { data, error } = await sb
    .from(T.grupos)
    .select('group_id,subject,participantes,is_admin,ativo,last_synced,instancia,community_id,is_announcement')
    .eq('ativo', true)
    .order('subject', { ascending: true })
  if (error) throw error
  return (data ?? []) as Grupo[]
}

export async function syncGrupos(): Promise<{ grupos?: number }> {
  const r = await fetch(CONFIG.N8N_SYNC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return r.json().catch(() => ({}))
}

// ===== CAMPANHAS (listas de grupos) =====
export async function listCampanhas(): Promise<Campanha[]> {
  const { data, error } = await sb.from(T.campanhas).select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((l: Record<string, unknown>) => ({
    id: l.id as number,
    nome: l.nome as string,
    group_ids: (l.group_ids as string[]) ?? [],
    criado_por: (l.criado_por as string) ?? null,
    created_at: (l.created_at as string) ?? null,
  }))
}

export async function createCampanha(nome: string, group_ids: string[]): Promise<void> {
  const { error } = await sb.from(T.campanhas).insert({ nome, group_ids })
  if (error) throw error
}

export async function updateCampanha(id: number, group_ids: string[]): Promise<void> {
  const { error } = await sb.from(T.campanhas).update({ group_ids }).eq('id', id)
  if (error) throw error
}

export async function deleteCampanha(id: number): Promise<void> {
  const { error } = await sb.from(T.campanhas).delete().eq('id', id)
  if (error) throw error
}

// ===== DISPAROS (eventos de envio) =====
export async function listDisparos(limit = 50): Promise<Disparo[]> {
  const { data, error } = await sb
    .from(T.disparos)
    .select('*')
    .order('criado_em', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Disparo[]
}

export async function getDisparoItens(disparoId: number): Promise<DisparoItem[]> {
  const { data, error } = await sb
    .from(T.disparoItens)
    .select('*')
    .eq('campanha_id', disparoId)
    .order('ordem', { ascending: true })
  if (error) throw error
  return (data ?? []) as DisparoItem[]
}

export type NovoDisparo = {
  nome: string | null
  mensagem: string
  tipo_mencao: string
  intervalo_seg: number
  jitter_seg: number
  media_tipo: string
  media_url: string | null
  group_ids: string[]
  subjects: Record<string, string | null>
}

// cria o disparo + itens e chama o motor. Retorna o id do disparo.
export async function criarEDisparar(d: NovoDisparo): Promise<number> {
  const { data: disp, error: e1 } = await sb
    .from(T.disparos)
    .insert({
      nome: d.nome,
      mensagem: d.mensagem,
      tipo_mencao: d.tipo_mencao,
      intervalo_seg: Math.min(180, Math.max(5, d.intervalo_seg || 60)),
      jitter_seg: Math.min(60, Math.max(0, d.jitter_seg || 0)),
      media_tipo: d.media_tipo,
      media_url: d.media_tipo === 'texto' ? null : d.media_url,
      status: 'rascunho',
      total: d.group_ids.length,
    })
    .select('id')
    .single()
  if (e1) throw e1
  const dispId = (disp as { id: number }).id

  const itens = d.group_ids.map((g, i) => ({
    campanha_id: dispId,
    group_id: g,
    subject: d.subjects[g] ?? null,
    ordem: i + 1,
    status: 'pendente',
  }))
  const { error: e2 } = await sb.from(T.disparoItens).insert(itens)
  if (e2) throw e2

  await chamarMotor(dispId)
  return dispId
}

// cria o disparo AGENDADO (status=agendado + scheduled_at) sem chamar o motor.
// O poller n8n (HX-gghx-agendador) inicia quando scheduled_at <= now(). Retorna o id.
export async function agendarDisparo(d: NovoDisparo, scheduledAtISO: string): Promise<number> {
  const { data: disp, error: e1 } = await sb
    .from(T.disparos)
    .insert({
      nome: d.nome,
      mensagem: d.mensagem,
      tipo_mencao: d.tipo_mencao,
      intervalo_seg: Math.min(180, Math.max(5, d.intervalo_seg || 60)),
      jitter_seg: Math.min(60, Math.max(0, d.jitter_seg || 0)),
      media_tipo: d.media_tipo,
      media_url: d.media_tipo === 'texto' ? null : d.media_url,
      status: 'agendado',
      scheduled_at: scheduledAtISO,
      total: d.group_ids.length,
    })
    .select('id')
    .single()
  if (e1) throw e1
  const dispId = (disp as { id: number }).id
  const itens = d.group_ids.map((g, i) => ({
    campanha_id: dispId,
    group_id: g,
    subject: d.subjects[g] ?? null,
    ordem: i + 1,
    status: 'pendente',
  }))
  const { error: e2 } = await sb.from(T.disparoItens).insert(itens)
  if (e2) throw e2
  return dispId
}

export async function chamarMotor(disparoId: number): Promise<Response> {
  const t = await token()
  return fetch(CONFIG.N8N_DISPARAR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campanha_id: disparoId, access_token: t }),
  })
}

// ===== métricas agregadas de um disparo (grupo: entregue/lido é agregado, "lido" é um piso) =====
export type DisparoMetrics = { enviadas: number; entregues: number; lidas: number }

export async function getDisparoMetrics(disparoId: number): Promise<DisparoMetrics> {
  // gghx_mensagens.campanha_id é TEXT; o motor grava String(campId)
  const { data, error } = await sb
    .from('gghx_mensagens')
    .select('status_atual,delivered_at,read_at')
    .eq('campanha_id', String(disparoId))
    .limit(20000)
  if (error) throw error
  const rows = data ?? []
  return {
    enviadas: rows.length,
    entregues: rows.filter((r: { delivered_at: string | null }) => r.delivered_at != null).length,
    lidas: rows.filter((r: { read_at: string | null }) => r.read_at != null).length,
  }
}

// ===== controle de disparo (pausar / cancelar / retomar / reenviar) =====
export async function setDisparoStatus(disparoId: number, status: string): Promise<void> {
  const { error } = await sb.from(T.disparos).update({ status }).eq('id', disparoId)
  if (error) throw error
}

// retomar: só reenvia os pendentes (motor pula os já enviados)
export async function retomarDisparo(disparoId: number): Promise<Response> {
  await setDisparoStatus(disparoId, 'pausada')
  return chamarMotor(disparoId)
}

// reenviar itens de um status (falha/pulado) → volta a pendente e re-dispara
export async function reenviarItens(disparoId: number, deStatus: 'falha' | 'pulado'): Promise<Response> {
  await sb.from(T.disparoItens).update({ status: 'pendente', erro: null }).eq('campanha_id', disparoId).eq('status', deStatus)
  await setDisparoStatus(disparoId, 'pausada')
  return chamarMotor(disparoId)
}

// ===== estatísticas =====
export async function getMovimentosResumo(dias: number): Promise<{ entradas: number; saidas: number }> {
  const desde = new Date(Date.now() - dias * 86400000).toISOString()
  const { data, error } = await sb.from(T.movimentos).select('tipo').gte('momento', desde).limit(50000)
  if (error) throw error
  let entradas = 0
  let saidas = 0
  ;(data ?? []).forEach((m: { tipo: string }) => (m.tipo === 'entrada' ? entradas++ : saidas++))
  return { entradas, saidas }
}

export type Aviso = {
  id: number
  instancia: string | null
  evento: string | null
  motivo: string | null
  momento: string | null
  received_at: string | null
}

export async function listAvisos(limit = 30): Promise<Aviso[]> {
  const { data, error } = await sb
    .from(T.instanciaStatus)
    .select('id,instancia,evento,motivo,momento,received_at')
    .order('received_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Aviso[]
}

// ===== conexão (status/qr/disconnect via n8n) =====
export async function conexaoCall(action: 'status' | 'qr' | 'disconnect'): Promise<Record<string, unknown>> {
  const t = await token()
  const r = await fetch(CONFIG.N8N_CONEXAO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, access_token: t }),
  })
  return r.json().catch(() => ({ ok: false, error: 'resposta inválida' }))
}

// ===== upload de mídia =====
export async function uploadMidia(file: File): Promise<string> {
  const path = 'campanhas/' + Date.now() + '_' + file.name.replace(/[^\w.\-]/g, '_')
  const { error } = await sb.storage.from('gghx-midia').upload(path, file, {
    upsert: true,
    contentType: file.type,
  })
  if (error) throw error
  return sb.storage.from('gghx-midia').getPublicUrl(path).data.publicUrl
}
