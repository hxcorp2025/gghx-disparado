import { sb } from './supabase'

// ===== Motor de copy com IA (Opus 5) =====
// O app nao fala com a Anthropic: hx_copy_pedir() so ENFILEIRA e um worker no banco
// (cron, service_role) faz a chamada com a chave do Vault. Mesmo contrato da Conexao.
// As tabelas/views hx_copy_* NAO sao legiveis pelo painel: tudo passa por RPC com gate
// (uma view sem security_invoker furava a RLS e deixava a chave anon ler tudo, 11/08).

export type CopyFila = {
  id: number
  projeto: string
  briefing: string
  n_variacoes: number
  status: string // pending | doing | ok | error
  tentativas: number
  ultimo_erro: string | null
  criado_por: string | null
  criado_em: string
  concluido_em: string | null
  variacoes: number
}

export type CopyVariacao = {
  id: number
  fila_id: number
  idx: number
  projeto: string
  origem: string | null
  template_base: string | null
  angulo: string | null
  texto: string
  dominio_link: string | null
  tem_link: boolean
  chars: number
  usa_mencao_todos: boolean
  violacoes: string[] | null
  reprovada_na_guarda: boolean
  aprovada: boolean | null
  braco_ab: string | null
  criado_em: string
}

export type CopyResumo = {
  modelo: string | null
  key_pronta: boolean
  custo_30d: { dia: string; chamadas: number; tokens_in: number; tokens_out: number; custo_usd: number; ms_medio: number }[]
  diagnostico: {
    templates?: number
    com_mencao_todos?: number
    pct_mencao_todos?: number
    com_link?: number
    pct_com_link?: number
    dominios_distintos?: number
  }
  aprovadas: number
  pendentes: number
  regras: { categoria: string; regra: string }[]
  erro?: string
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

function exigirOk(r: { ok?: boolean; erro?: string; aviso?: string } | null) {
  if (!r?.ok) throw new Error(r?.erro ?? 'Não consegui registrar o pedido.')
  return r
}

export const copyResumo = () => rpc<CopyResumo>('hx_copy_resumo')
export const copyFila = (limite = 20) => rpc<CopyFila[]>('hx_copy_painel', { p_limite: limite })
export const copyRevisar = (soPendentes = true) =>
  rpc<CopyVariacao[]>('hx_copy_revisar', { p_so_pendentes: soPendentes })

export const copyPedir = async (
  briefing: string,
  n: number,
  dominios: string[],
  instrucoes: string,
) =>
  exigirOk(
    await rpc<{ ok: boolean; erro?: string; aviso?: string; fila_id?: number }>('hx_copy_pedir', {
      p_briefing: briefing,
      p_n: n,
      p_dominios: dominios.length ? dominios : null,
      p_instrucoes: instrucoes || null,
    }),
  )

export const copyDecidir = async (id: number, aprovada: boolean) =>
  exigirOk(
    await rpc<{ ok: boolean; erro?: string }>('hx_copy_decidir', {
      p_id: id,
      p_aprovada: aprovada,
    }),
  )
