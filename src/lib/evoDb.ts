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

export const evoListar = () => rpc<EvoInstancia[]>('evo_painel')
export const evoSincronizar = () => pedir('sincronizar', null)
export const evoCriar = (nome: string, rotulo: string) => pedir('criar', nome, { rotulo })
export const evoConectar = (nome: string) => pedir('conectar', nome)
export const evoEstado = (nome: string) => pedir('estado', nome)
export const evoDesconectar = (nome: string) => pedir('logout', nome)
export const evoApagar = (nome: string, confirmo: string) => pedir('deletar', nome, { confirmo })
