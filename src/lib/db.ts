import { sb } from './supabase'
import { CONFIG, FEATURES } from './config'
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

// ===== CONTAS (multi-número; dormante até multiconta.sql + flag) =====
import type { Conta } from './types'

const CONTA_FALLBACK: Conta = { id: 'hxsend', nome: 'HxSend', numero: null, status: 'connected' }

// lê gghx_contas; enquanto multiconta está desligado (tabela pode não existir), retorna fallback
// sem consultar (evita 404 no console). Quando ligar, lê as contas reais.
export async function listContas(): Promise<Conta[]> {
  if (!FEATURES.multiconta) return [CONTA_FALLBACK]
  try {
    const { data, error } = await sb
      .from('gghx_contas')
      .select('id,nome,numero,status')
      .eq('ativo', true)
      .order('criado_em', { ascending: true })
    if (error || !data || !data.length) return [CONTA_FALLBACK]
    return data as Conta[]
  } catch {
    return [CONTA_FALLBACK]
  }
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

export type SyncGruposResp = {
  ok?: boolean
  erro?: string
  aviso?: string
  numeros_varrendo?: number
  mesclados_agora?: { novos?: number; atualizados?: number; inativos?: number }
}

// Sincroniza a lista de grupos. Era um POST no HX-gghx-sync-grupos (n8n -> Z-API),
// que morreu junto com a assinatura da Z-API. Agora pede a varredura pela Evolution:
// a RPC so ENFILEIRA e o worker (cron de 10s) le os grupos; o merge pra gghx_grupos
// roda na hora com o que ja foi lido, pra tela nao ficar parada esperando.
// So entra grupo de numero com CONTA DE DISPARO ATIVA: chip pessoal conectado nao
// contamina a lista (em 11/08 isso despejou 448 grupos pessoais aqui).
export async function syncGrupos(): Promise<SyncGruposResp> {
  const { data, error } = await sb.rpc('gghx_sincronizar_grupos')
  if (error) return { ok: false, erro: error.message }
  return (data ?? {}) as SyncGruposResp
}

// ===== Grupos que o motor pula sozinho =====
// Grupo que recusou 2 vezes seguidas, sem nenhum envio aceito depois, e considerado
// queimado. Insistir nele e o comportamento que queima o CHIP: cada tentativa recusada
// e mais um sinal pro WhatsApp. Um envio aceito depois limpa a ficha.
export type GrupoQueimado = {
  group_id: string
  subject: string | null
  recusas: number
  motivo: string
  ultima: string | null
}
export async function gruposQueimados(): Promise<GrupoQueimado[]> {
  const { data, error } = await sb.rpc('gghx_grupos_queimados')
  if (error) throw error
  return (data ?? []) as GrupoQueimado[]
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
  conta_id?: string // só enviado quando FEATURES.multiconta (senão a coluna nem existe)
  lista_id?: number | null // campanha (lista) de origem, quando o disparo veio de uma
}

// cria o disparo + itens e chama o motor. Retorna o id + se o motor confirmou o start.
export async function criarEDisparar(d: NovoDisparo): Promise<{ id: number; started: boolean }> {
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
      ...(d.conta_id ? { conta_id: d.conta_id } : {}),
      ...(d.lista_id ? { lista_id: d.lista_id } : {}),
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

  // checa se o motor confirmou o start (o motor tem claim atômico → clicar "Iniciar"
  // depois não duplica; mas avisamos se não iniciou pra o operador saber).
  let started = false
  try {
    const resp = await chamarMotor(dispId)
    started = resp.ok
  } catch {
    started = false
  }
  return { id: dispId, started }
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
      ...(d.conta_id ? { conta_id: d.conta_id } : {}),
      ...(d.lista_id ? { lista_id: d.lista_id } : {}),
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

export type MotorResp = {
  ok: boolean
  erro?: string
  aviso?: string
  motor?: 'evolution' | 'zapi'
}

// Inicia o disparo. Quem manda é a CONTA da campanha:
//  - conta com evo_instancia  -> motor novo (Evolution). A RPC só põe status='rodando'
//    e o cron gghx_disparo_tick_15s faz o resto. O painel nunca fala com o WhatsApp.
//  - conta legada Z-API       -> segue chamando o motor do n8n, sem mudar nada.
// Cutover sem big-bang: os dois convivem até o último chip sair da Z-API.
export async function chamarMotor(disparoId: number): Promise<MotorResp> {
  const { data, error } = await sb.rpc('gghx_iniciar_disparo', { p_disparo: disparoId })
  if (error) return { ok: false, erro: error.message }
  const r = (data ?? {}) as MotorResp
  if (r.motor !== 'zapi') return r

  const t = await token()
  try {
    const resp = await fetch(CONFIG.N8N_DISPARAR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campanha_id: disparoId, access_token: t }),
    })
    return {
      ok: resp.ok,
      motor: 'zapi',
      erro: resp.ok ? undefined : 'o motor antigo (Z-API) respondeu ' + resp.status,
    }
  } catch {
    return { ok: false, motor: 'zapi', erro: 'não consegui falar com o motor antigo (Z-API)' }
  }
}

// ===== métricas agregadas de um disparo (grupo: entregue/lido é agregado, "lido" é um piso) =====
export type DisparoMetrics = { enviadas: number; entregues: number; lidas: number }

export async function getDisparoMetrics(disparoId: number): Promise<DisparoMetrics> {
  // gghx_mensagens tem RLS deny-all p/ authenticated; o RPC (definer) devolve os agregados.
  // campanha_id é TEXT; o motor grava String(campId).
  const { data, error } = await sb.rpc('gghx_disparo_metrics', { p_disparo: String(disparoId) })
  if (error) throw error
  const r = (Array.isArray(data) ? data[0] : data) ?? {}
  return {
    enviadas: Number(r.enviadas ?? 0),
    entregues: Number(r.entregues ?? 0),
    lidas: Number(r.lidas ?? 0),
  }
}

export type DispPorCampanha = {
  lista_id: number | null
  campanha: string
  disparos: number
  enviadas: number
  entregues: number
  lidas: number
  ultimo: string | null
}

// agregado de disparos agrupados por campanha (lista de origem). RPC definer.
export async function disparosPorCampanha(): Promise<DispPorCampanha[]> {
  const { data, error } = await sb.rpc('gghx_disparos_por_campanha')
  if (error) throw error
  return (data ?? []).map((r: Record<string, unknown>) => ({
    lista_id: r.lista_id == null ? null : Number(r.lista_id),
    campanha: String(r.campanha ?? '(sem campanha)'),
    disparos: Number(r.disparos ?? 0),
    enviadas: Number(r.enviadas ?? 0),
    entregues: Number(r.entregues ?? 0),
    lidas: Number(r.lidas ?? 0),
    ultimo: (r.ultimo as string) ?? null,
  }))
}

// ===== controle de disparo (pausar / cancelar / retomar / reenviar) =====
export async function setDisparoStatus(disparoId: number, status: string): Promise<void> {
  const { error } = await sb.from(T.disparos).update({ status }).eq('id', disparoId)
  if (error) throw error
}

// retomar: só reenvia os pendentes (motor pula os já enviados)
export async function retomarDisparo(disparoId: number): Promise<MotorResp> {
  await setDisparoStatus(disparoId, 'pausada')
  return chamarMotor(disparoId)
}

// reenviar itens de um status (falha/pulado) → volta a pendente e re-dispara
export async function reenviarItens(disparoId: number, deStatus: 'falha' | 'pulado'): Promise<MotorResp> {
  await sb.from(T.disparoItens).update({ status: 'pendente', erro: null }).eq('campanha_id', disparoId).eq('status', deStatus)
  await setDisparoStatus(disparoId, 'pausada')
  return chamarMotor(disparoId)
}

// ===== dashboard (RPCs de agregação diária) =====
export type StatDia = { dia: string; enviadas: number; entregues: number; lidas: number }
export async function statsDiario(dias = 14): Promise<StatDia[]> {
  const { data, error } = await sb.rpc('gghx_stats_diario', { p_dias: dias })
  if (error) throw error
  return (data ?? []) as StatDia[]
}
export type DisparoDia = { dia: string; n: number }
export async function disparosDiario(dias = 14): Promise<DisparoDia[]> {
  const { data, error } = await sb.rpc('gghx_disparos_diario', { p_dias: dias })
  if (error) throw error
  return (data ?? []) as DisparoDia[]
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

// ===== templates de mensagem =====
export type Template = { id: number; nome: string; mensagem: string; created_at: string | null }
export async function listTemplates(): Promise<Template[]> {
  const { data, error } = await sb
    .from('gghx_templates')
    .select('id,nome,mensagem,created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Template[]
}
export async function createTemplate(nome: string, mensagem: string): Promise<void> {
  const { error } = await sb.from('gghx_templates').insert({ nome, mensagem })
  if (error) throw error
}
export async function deleteTemplate(id: number): Promise<void> {
  const { error } = await sb.from('gghx_templates').delete().eq('id', id)
  if (error) throw error
}

// ===== saúde de chip =====
export type SaudeChip = {
  conta_id: string
  nome: string
  status: string
  limite_hora: number
  limite_dia: number
  enviadas_hora: number
  enviadas_24h: number
  entregues_24h: number
  lidas_24h: number
}
export async function saudeChip(): Promise<SaudeChip[]> {
  const { data, error } = await sb.rpc('gghx_saude_chip')
  if (error) throw error
  return (data ?? []) as SaudeChip[]
}

// ===== conexão =====
// conexaoCall() (status/qr/disconnect da Z-API via n8n) foi REMOVIDA em 11/08/2026:
// a aba Conexão agora conecta números pela nossa Evolution, via src/lib/evoDb.ts.
// O workflow HX-gghx-conexao e CONFIG.N8N_CONEXAO seguem existindo, mas nada no app os chama.

// ===== EXTRAS (ações em massa nas comunidades) =====
export type Acao = {
  id: number
  tipo: string
  conta_id: string | null
  valor: string | null
  status: string
  total: number | null
  enviados: number | null
  falhas: number | null
  intervalo_seg: number
  jitter_seg: number
  criado_em: string | null
  iniciado_em: string | null
  concluido_em: string | null
}
export type AcaoItem = {
  id: number
  acao_id: number
  group_id: string
  subject: string | null
  status: string
  erro: string | null
  executado_em: string | null
}

export async function listAcoes(limit = 50): Promise<Acao[]> {
  const { data, error } = await sb.from('gghx_acoes').select('*').order('criado_em', { ascending: false }).limit(limit)
  if (error) throw error
  return (data ?? []) as Acao[]
}
export async function getAcaoItens(acaoId: number): Promise<AcaoItem[]> {
  const { data, error } = await sb
    .from('gghx_acao_itens')
    .select('*')
    .eq('acao_id', acaoId)
    .order('ordem', { ascending: true })
  if (error) throw error
  return (data ?? []) as AcaoItem[]
}
// Ferramentas (6 operacoes em massa). Mesmo cutover do disparo: a RPC roteia por conta.
// O motor antigo (HX-gghx-extras) resolve credencial Z-API e morreu com a assinatura.
export async function chamarMotorExtras(acaoId: number): Promise<MotorResp> {
  const { data, error } = await sb.rpc('gghx_iniciar_acao', { p_acao: acaoId })
  if (error) return { ok: false, erro: error.message }
  const r = (data ?? {}) as MotorResp
  if (r.motor !== 'zapi') return r

  const t = await token()
  try {
    const resp = await fetch(CONFIG.N8N_EXTRAS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acao_id: acaoId, access_token: t }),
    })
    return { ok: resp.ok, motor: 'zapi',
             erro: resp.ok ? undefined : 'o motor antigo (Z-API) respondeu ' + resp.status }
  } catch {
    return { ok: false, motor: 'zapi', erro: 'não consegui falar com o motor antigo (Z-API)' }
  }
}
export async function setAcaoStatus(acaoId: number, status: string): Promise<void> {
  const { error } = await sb.from('gghx_acoes').update({ status }).eq('id', acaoId)
  if (error) throw error
}

export type NovaAcao = {
  tipo: string
  conta_id: string
  valor: string
  intervalo_seg: number
  jitter_seg: number
  group_ids: string[]
  subjects: Record<string, string | null>
}
export async function criarEExecutarAcao(a: NovaAcao): Promise<{ id: number; started: boolean }> {
  const { data: ac, error: e1 } = await sb
    .from('gghx_acoes')
    .insert({
      tipo: a.tipo,
      conta_id: a.conta_id,
      valor: a.valor,
      intervalo_seg: Math.min(600, Math.max(3, a.intervalo_seg || 60)),
      jitter_seg: Math.min(120, Math.max(0, a.jitter_seg || 0)),
      status: 'rascunho',
      total: a.group_ids.length,
    })
    .select('id')
    .single()
  if (e1) throw e1
  const acaoId = (ac as { id: number }).id
  const itens = a.group_ids.map((g, i) => ({
    acao_id: acaoId,
    group_id: g,
    subject: a.subjects[g] ?? null,
    ordem: i + 1,
    status: 'pendente',
  }))
  const { error: e2 } = await sb.from('gghx_acao_itens').insert(itens)
  if (e2) throw e2
  let started = false
  try {
    const r = await chamarMotorExtras(acaoId)
    started = r.ok
  } catch {
    started = false
  }
  return { id: acaoId, started }
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
