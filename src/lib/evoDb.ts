import { sb } from './supabase'

// ===== Instâncias Evolution (números próprios, no lugar da Z-API) =====
// O app NUNCA fala com a Evolution direto: evo_pedir() só ENFILEIRA e um worker
// no banco executa em até ~10s e grava o resultado.
// (Regra da casa: RPC de painel não faz HTTP, o papel authenticated tem
// statement_timeout de 8s e a criação de instância passa disso.)

export interface EvoInstancia {
  nome: string
  rotulo: string | null
  estado: string | null // open | connecting | close
  numero: string | null
  perfil: string | null
  foto_url: string | null
  qr_base64: string | null // só vem preenchido enquanto o QR é válido
  qr_fresco: boolean | null // NULL quando qr_em é nulo (comparação com NULL)
  pareamento: string | null
  proxy_ativo: boolean
  proxy_host: string | null
  ultimo_erro: string | null
  criada_por: string | null
  criada_em: string
  visto_em: string | null
  pedido_em_andamento: string | null
}

// erro de Postgres é técnico demais pra tela; traduz o que a equipe pode ver
export function traduzErroEvo(msg: string): string {
  const m = (msg || '').toLowerCase()
  if (m.includes('failed to fetch') || m.includes('networkerror'))
    return 'Sem conexão com o servidor. Confere a internet e tenta de novo.'
  if (m.includes('jwt') || m.includes('expired')) return 'Sua sessão expirou. Faz login de novo.'
  if (m.includes('permission') || m.includes('denied') || m.includes('row-level'))
    return 'Você não tem permissão pra isso. Fala com o Matheus.'
  return msg || 'Algo deu errado. Tenta de novo.'
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(traduzErroEvo(error.message))
  return data as T
}

function exigirOk(r: { ok: boolean; erro?: string } | null | undefined) {
  if (!r?.ok) throw new Error(r?.erro ?? 'O pedido não foi registrado. Tenta de novo.')
  return r
}

type Acao = 'criar' | 'conectar' | 'estado' | 'logout' | 'deletar' | 'sincronizar' | 'proxy'

const pedir = async (acao: Acao, instancia: string | null, params?: Record<string, unknown>) =>
  exigirOk(
    await rpc<{ ok: boolean; erro?: string; fila_id?: number }>('evo_pedir', {
      p_acao: acao,
      p_instancia: instancia,
      p_params: params ?? null,
    }),
  )

// ===== Saude e limites por chip (warmup / anti-ban) =====
// A view evo_chips_saude fica FECHADA pro painel: view sem security_invoker fura a
// RLS da tabela de baixo. Quem le e a RPC, com allowlist dentro.

export interface EvoChipSaude {
  nome: string
  rotulo: string | null
  estado: string | null
  numero: string | null
  aquecendo: boolean | null
  dia_do_warmup: number | null
  teto_hoje: number | null
  enviadas_hoje: number
  ultima_hora: number
  falhas_24h: number
  proxy_ativo: boolean
  politica_ativa: boolean | null
  travado_por: string | null // null = pode enviar agora
  teto_hora: number | null
  janela_inicio: string | null
  janela_fim: string | null
  intervalo_min_ms: number | null
  intervalo_max_ms: number | null
}

export type PoliticaForm = {
  aquecendo: boolean
  teto_dia: number
  teto_hora: number
  janela_ini: string
  janela_fim: string
  intervalo_min_ms: number
  intervalo_max_ms: number
  ativo: boolean
}

export const evoSaudeChips = () => rpc<EvoChipSaude[]>('evo_saude_chips')

export const evoPoliticaSalvar = async (instancia: string, p: PoliticaForm) =>
  exigirOk(
    await rpc<{ ok: boolean; erro?: string }>('evo_politica_salvar', {
      p_instancia: instancia,
      p_aquecendo: p.aquecendo,
      p_teto_dia: p.teto_dia,
      p_teto_hora: p.teto_hora,
      p_janela_ini: p.janela_ini,
      p_janela_fim: p.janela_fim,
      p_intervalo_min_ms: p.intervalo_min_ms,
      p_intervalo_max_ms: p.intervalo_max_ms,
      p_ativo: p.ativo,
    }),
  )

export const evoListar = () => rpc<EvoInstancia[]>('evo_painel')
export const evoSincronizar = () => pedir('sincronizar', null)
export const evoCriar = (nome: string, rotulo: string) => pedir('criar', nome, { rotulo })
export const evoConectar = (nome: string) => pedir('conectar', nome)
export const evoEstado = (nome: string) => pedir('estado', nome)
export const evoDesconectar = (nome: string) => pedir('logout', nome)
export const evoApagar = (nome: string, confirmo: string) => pedir('deletar', nome, { confirmo })
