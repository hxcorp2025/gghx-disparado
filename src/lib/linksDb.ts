import { sb } from './supabase'

// ===== Encurtador HX =====
// O redirecionador NAO mora neste repo: e um Worker na borda da Cloudflare
// (repo hx-links). Aqui e so o painel de gestao.
//
// As tabelas lnk_* tem RLS sem policy, entao o painel nao le nada direto:
// tudo passa por RPC security definer com gate mod_is_operador(). Este repo
// e publico e publica o nome da RPC, entao esconder botao nao e permissao.
//
// Escrita que precisa falar com a Cloudflare (provisionar dominio) so
// ENFILEIRA; um worker service_role no pg_cron faz o HTTP com o token do
// Vault. RPC de painel nunca faz HTTP: o papel authenticated tem
// statement_timeout de 8s.

export type DominioEstado =
  | 'pendente' | 'verificando' | 'ativo' | 'pausado' | 'suspeito' | 'banido' | 'removido'

export type LinkDominio = {
  hostname: string
  raiz: string
  estado: DominioEstado
  no_rodizio: boolean
  dns_ok: boolean | null
  ssl_ok: boolean | null
  verificado_em: string | null
  ultimo_erro: string | null
  ultimo_uso: string | null
  urls: number
  entregas_7d: number
  cliques_7d: number
  /** os endereços que o operador copia no registrador do domínio */
  nameservers: string[]
  /** 'pending' enquanto o registrador não apontou; 'active' quando apontou */
  zona_status: string | null
  tentativas: number
  /** quando tem pedido na fila, a tela mostra "provisionando" e faz polling */
  pedido_na_fila: string | null
}

export type LinkDominiosPainel = {
  resumo: {
    ativos: number
    no_rodizio: number
    /** o que importa no anti-ban: dois hostnames da mesma raiz sao UM alvo */
    raizes: number
    minimo: number
    pendentes: number
    suspeitos: number
    banidos: number
  }
  dominios: LinkDominio[]
}

export type LinkDestino = {
  id: string
  url: string
  rotulo: string | null
  peso: number
  peso_efetivo: number | null
  ativo: boolean
  /** percentual efetivo do peso, ja normalizado pela soma dos ativos */
  pct: number | null
}

export type LinkParam = { chave: string; valor: string; destino_id: string | null }

export type LinkUrl = { url: string; dominio: string; estado: DominioEstado; entregas: number }

export type LinkItem = {
  id: string
  nome: string
  projeto: string
  divisao: 'clique' | 'pessoa'
  ativo: boolean
  congelado: boolean
  criado_em: string
  destinos: LinkDestino[] | null
  params: LinkParam[] | null
  urls: LinkUrl[] | null
  /** cliques de GENTE em 7 dias; o total e os robos vivem na aba de cliques */
  cliques_7d: number
  ultimo_clique: string | null
  sem_braco: boolean
}

export type LinkProxima = {
  ok: boolean
  erro?: string
  url: string
  /** o painel devolve isto ao marcar, pra o banco registrar o que foi COPIADO
   *  e não o que ele escolheria de novo meio segundo depois */
  url_id: string
  dominio: string
  raiz: string
  criterio: string
  ultimo_uso: string | null
  raizes_ativas: number
  urls_ativas: number
  minimo: number
  /** nao havia dominio no rodizio: entregou um ativo, mas nao serve pra disparo */
  fora_do_rodizio: boolean
  /** o rodizio andou entre a espiada e o clique (outro operador copiou) */
  mudou: boolean
  aviso: string | null
}

export type LinkCliques = {
  periodo_dias: number
  topo: {
    acessos: number
    robos: number
    cliques: number
    /** ESTIMATIVA: sem cookie nem login, junta acessos parecidos */
    pessoas: number
    pct_robo_por_hit: number | null
    /** se divergir muito da de hit, poucos robos fizeram muitos acessos */
    pct_robo_por_cluster: number | null
  }
  serie: { dia: string; acessos: number; robos: number; cliques: number; parcial: boolean }[]
  por_dominio: {
    dominio: string; raiz: string; estado: DominioEstado
    entregas: number; acessos: number; cliques: number
    perdidos: number; ultimo_clique: string | null
  }[]
  por_destino: {
    link: string; destino: string; peso: number
    pct_configurado: number | null
    acessos: number
    desde: string
    peso_mudou_no_periodo: boolean
    pct_real: number | null
    /** margem estatistica esperada para este N: ver 54/46 em 100 nao e bug */
    margem_pp: number | null
    comparavel: boolean
  }[]
  frescor: { ultimo_evento: string | null; agora: string }
}

// erro de Postgres e tecnico demais pra tela (mesmo molde do traduzErroEvo)
export function traduzErroLinks(msg: string): string {
  const m = (msg || '').toLowerCase()
  if (m.includes('failed to fetch') || m.includes('networkerror'))
    return 'Sem conexão com o servidor. Confere a internet e tenta de novo.'
  if (m.includes('jwt') || m.includes('expired')) return 'Sua sessão expirou. Faz login de novo.'
  if (m.includes('sem permissao') || m.includes('permission') || m.includes('denied') || m.includes('row-level'))
    return 'Você não tem permissão pra isso. Fala com o Matheus.'
  if (m.includes('duplicate key') || m.includes('unique'))
    return 'Isso já existe aqui.'
  return msg || 'Algo deu errado. Tenta de novo.'
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(traduzErroLinks(error.message))
  return data as T
}

function exigirOk<T extends { ok: boolean; erro?: string }>(r: T | null | undefined): T {
  // nunca tratar {ok:false} como sucesso
  if (!r?.ok) throw new Error(r?.erro ?? 'O pedido não foi registrado. Tenta de novo.')
  return r
}

// ---------- leitura ----------
export const linksDominios = () => rpc<LinkDominiosPainel>('lnk_painel_dominios')
export const linksListar = (busca = '', projeto: string | null = null, limite = 60) =>
  rpc<LinkItem[]>('lnk_painel_listar', {
    p_busca: busca.trim() || null, p_projeto: projeto, p_limite: limite,
  })
export const linksCliques = (dias: number, linkId: string | null = null) =>
  rpc<LinkCliques>('lnk_painel_cliques', { p_dias: dias, p_link_id: linkId })

// ---------- rodizio ----------
// Uma RPC, dois usos. p_marcar=false ESPIA (a tela mostra a URL antes do
// clique, sem consumir); p_marcar=true ENTREGA e avanca. p_dominio_esperado
// deixa o banco avisar quando outro operador andou com o rodizio no meio.
const proxima = (linkId: string, marcar: boolean, esperado: string | null, urlId: string | null) =>
  rpc<LinkProxima>('lnk_proxima_url', {
    p_link_id: linkId, p_marcar: marcar, p_dominio_esperado: esperado, p_url_id: urlId,
  })

export const linksEspiar = (linkId: string) => proxima(linkId, false, null, null)

/** urlId = a URL que o operador copiou de fato. Sem ele, o banco escolheria
 *  outra sob concorrência e marcaria a errada. */
export const linksProxima = async (
  linkId: string, esperado: string | null = null, urlId: string | null = null,
) => exigirOk(await proxima(linkId, true, esperado, urlId))

// ---------- escrita ----------
export type NovoDestino = { url: string; rotulo?: string; peso: number }
export type NovoParam = { chave: string; valor: string; rotulo_destino?: string; ordem?: number }

export const linksCriar = async (
  nome: string, destinos: NovoDestino[], params: NovoParam[],
  divisao: 'clique' | 'pessoa' = 'clique', projeto = 'hx-geral',
) =>
  exigirOk(await rpc<{
    ok: boolean; erro?: string; id?: string; urls_criadas?: number
    urls?: { dominio: string; slug: string; url: string; estado: DominioEstado }[]
  }>('lnk_criar', {
    p_projeto: projeto, p_nome: nome, p_destinos: destinos,
    p_params: params, p_divisao: divisao, p_merge_query: 'append',
  }))

export const linksDominioCadastrar = async (hostname: string, raiz: string) =>
  exigirOk(await rpc<{ ok: boolean; erro?: string; hostname?: string; aviso?: string }>(
    'lnk_dominio_cadastrar', { p_hostname: hostname.trim(), p_raiz: raiz.trim() }))

export const linksDominioReverificar = async (hostname: string) =>
  exigirOk(await rpc<{ ok: boolean; erro?: string; aviso?: string }>(
    'lnk_dominio_reverificar', { p_hostname: hostname }))

export const linksDominioEstado = async (hostname: string, estado: DominioEstado, motivo?: string) =>
  exigirOk(await rpc<{ ok: boolean; erro?: string; raizes_ativas?: number; aviso?: string }>(
    'lnk_dominio_estado', { p_hostname: hostname, p_estado: estado, p_motivo: motivo?.trim() || null }))

/**
 * Raiz registravel a partir do hostname.
 * Serve so pra pre-preencher o campo: o banco e a fonte de verdade.
 * Trata os compostos brasileiros (com.br, net.br...), que sao a maioria aqui.
 */
export function raizDe(hostname: string): string {
  const p = hostname.toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split('.')
  if (p.length <= 2) return p.join('.')
  const doisNiveis = ['com', 'net', 'org', 'gov', 'edu', 'ind', 'adv', 'eco', 'app', 'blog']
  if (p.length >= 3 && p[p.length - 1].length === 2 && doisNiveis.includes(p[p.length - 2])) {
    return p.slice(-3).join('.')
  }
  return p.slice(-2).join('.')
}
