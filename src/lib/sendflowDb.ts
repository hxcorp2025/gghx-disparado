import { sb } from './supabase'

// ===== Ponte de disparo via SendFlow (paliativo) =====
// A tela NUNCA fala com o SendFlow direto: as RPCs abaixo so LEEM (grupos VIP) ou
// ENFILEIRAM (disparo); um worker no banco (cron, service_role) faz o POST na SendAPI
// com a chave do Vault. Mesmo contrato do motor de copy (copyDb.ts) e da Conexao.
// As tabelas sendflow_* nao sao legiveis pelo painel: tudo passa por RPC com gate
// mod_is_operador(). Ref: PRD_sendflow_ponte_copy_ia_2026-08-12.

export type SendflowGrupoVip = {
  gid: string
  nome: string
  participantes: number
  cheio: boolean
  numero_grupo: number | null
  release_id: string
  release_nome: string
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

// F1 - lista os grupos VIP vivos (releases Comunidades VIP 01/02).
// releaseId null = todas as releases VIP; ou passa um release_id especifico.
export const sendflowGruposVip = (releaseId: string | null = null) =>
  rpc<SendflowGrupoVip[]>('sendflow_grupos_vip', { p_release_id: releaseId })

export type SendflowDisparoResultado = {
  ok: boolean
  disparo_id: string
  lotes: number // lotes enfileirados (variacao x release)
  grupos: number // total de grupos que vao receber
  variacoes: number
  mencao: boolean | null // null = usa a flag de cada variacao
  intervalo_min: number // segundos entre mensagens (ritmo do chip)
  intervalo_max: number
  ignorados: string[] // gids passados que nao entraram (inexistentes/sumidos)
  ignorados_n: number
}

// Bloco da sequência de disparo (PRD_send_upload_midia_2026-08-24): a copy da variação
// entra em EXATAMENTE um lugar — bloco 'copy' OU legenda_copy de UMA mídia. O banco valida
// de novo e resolve midia_id -> URL (a tela nunca manda URL).
export type BlocoDisparo =
  | { tipo: 'copy' }
  | { tipo: 'midia'; midia_id: number; legenda_copy?: boolean }

// F3 - enfileira um disparo: round-robin das variacoes aprovadas pelos grupos escolhidos.
// So ENFILEIRA (o worker no banco faz o POST na SendAPI). Nada dispara pela tela.
// blocos null/[] = disparo de texto puro (comportamento original, intocado).
// partidaEmS > 0 = partida agendada: os lotes entram com proximo_em no futuro e o worker
// so pega depois — e a janela em que sendflowDisparoCancelar desfaz TUDO (estudo UX 24/08).
export const sendflowDisparar = async (
  gids: string[],
  variacaoIds: number[],
  mencao = false,
  intervaloMin = 80,
  intervaloMax = 160,
  blocos: BlocoDisparo[] | null = null,
  partidaEmS = 0,
) => {
  const r = await rpc<SendflowDisparoResultado & { partida_em: string }>('sendflow_disparar', {
    p_gids: gids,
    p_variacao_ids: variacaoIds,
    p_mencao: mencao,
    p_intervalo_min: intervaloMin,
    p_intervalo_max: intervaloMax,
    p_blocos: blocos && blocos.length > 0 ? blocos : null,
    p_partida_em_s: partidaEmS,
  })
  // mesmo cinto do exigirOk() do copyDb: nunca tratar {ok:false} como sucesso
  if (!r.ok) throw new Error('Não consegui enfileirar o disparo.')
  return r
}

// ===== Acompanhamento vivo do disparo (Mesa de Disparo, estudo UX 24/08) =====
// Um LOTE = variação × release (um POST na SendAPI, que entrega paceado nos gids).
// Só lote 'pending'/'paused' é controlável daqui; 'sending'/'done' já virou ação no SendFlow.

export type LoteStatus = {
  id: number
  release_id: string
  braco_ab: string | null
  variacao_id: number
  status: 'pending' | 'paused' | 'sending' | 'done' | 'error' | 'incerto' | 'cancelled'
  n_gids: number
  proximo_em: string | null
  sending_em: string | null
  concluido_em: string | null
  ultimo_erro: string | null
  acao: {
    processada: boolean | null
    sucesso: boolean | null
    erro: string | null
    iniciada_em: string | null
    concluida_em: string | null
  } | null
}

export type DisparoStatus = {
  lotes: LoteStatus[]
  resumo: {
    total: number
    pending: number
    paused: number
    sending: number
    done: number
    error: number
    cancelled: number
    grupos_total: number
    grupos_feitos: number
  }
  partida_em: string | null
}

export const sendflowDisparoStatus = (disparoId: string) =>
  rpc<DisparoStatus>('sendflow_disparo_status', { p_disparo: disparoId })

export const sendflowDisparoCancelar = (disparoId: string) =>
  rpc<{ ok: boolean; cancelados: number; ja_no_motor: number }>('sendflow_disparo_cancelar', { p_disparo: disparoId })

export const sendflowDisparoAgora = (disparoId: string) =>
  rpc<{ ok: boolean; liberados: number }>('sendflow_disparo_agora', { p_disparo: disparoId })

export const sendflowDisparoPausar = (disparoId: string) =>
  rpc<{ ok: boolean; pausados: number }>('sendflow_disparo_pausar', { p_disparo: disparoId })

export const sendflowDisparoRetomar = (disparoId: string) =>
  rpc<{ ok: boolean; retomados: number }>('sendflow_disparo_retomar', { p_disparo: disparoId })

// Cooldown de grupo: quando cada gid recebeu disparo pela última vez (pra mesa
// desmarcar por padrão grupo que recebeu há menos de X horas).
export const sendflowGruposUltimoEnvio = () =>
  rpc<{ gid: string; ultimo_em: string }[]>('sendflow_grupos_ultimo_envio')
