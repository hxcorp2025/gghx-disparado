import { sb } from './supabase'

// ===== Encurtador HX =====
// O redirecionador NAO mora neste repo: e um Worker na borda da Cloudflare
// (repo hx-links). Aqui e so o painel de gestao.
//
// As tabelas lnk_* tem RLS sem policy, entao o painel nao le nada direto:
// tudo passa por RPC security definer com gate mod_is_operador(). Este repo
// e publico e publica o nome da RPC, entao esconder botao nao e permissao.
//
// Escrita que precisa falar com a Cloudflare (provisionar dominio, publicar
// no KV) so ENFILEIRA; um worker service_role no pg_cron faz o HTTP com o
// token do Vault. RPC de painel nunca faz HTTP: o papel authenticated tem
// statement_timeout de 8s.
//
// v2 (15/09/2026): lista com URL curta e sparkline, detalhe por link,
// editar/pausar/congelar/expirar, slug personalizado, historico.
// Contrato completo: backend/encurtador.sql (secao V2) e backend/migrations/.

export type DominioEstado =
  | 'pendente' | 'verificando' | 'ativo' | 'pausado' | 'suspeito' | 'banido' | 'removido'

export type LinkEstado = 'ativo' | 'pausado' | 'congelado' | 'expirado'

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
  pct?: number | null
  ordem?: number
}

export type LinkParam = {
  id?: string
  chave: string
  valor: string
  modo?: 'sobrescrever' | 'se_ausente'
  destino_id: string | null
  ordem?: number
}

export type LinkUrl = {
  id?: string
  url: string
  dominio: string
  slug?: string
  estado?: DominioEstado
  estado_dominio?: DominioEstado
  entregas: number
  ativa?: boolean
  protegida?: boolean
  no_rodizio?: boolean
}

export type LinkPreview = {
  modo: 'passthrough' | 'card_proprio' | 'bloquear'
  titulo: string | null
  desc: string | null
  img: string | null
}

/** uma linha da lista (lnk_painel_listar) */
export type LinkItem = {
  id: string
  nome: string
  projeto: string
  divisao: 'clique' | 'pessoa'
  ativo: boolean
  congelado: boolean
  estado: LinkEstado
  expira_em: string | null
  tags: string[]
  observacao: string | null
  /** slug em producao fora do nosso controle: nao renomeia, pausar pede confirmacao */
  protegido: boolean
  criado_em: string
  url_curta: string | null
  destinos: LinkDestino[] | null
  params: LinkParam[] | null
  urls: LinkUrl[] | null
  /** cliques de GENTE em 7 dias; robo, 404, pausado e expirado ficam fora */
  cliques_7d: number
  acessos_7d: number
  cliques_hoje: number
  cliques_total: number
  /** pessoas pelo cookie hxv; NULL enquanto nao houver cookie (Worker 1.2.0), nunca zero */
  pessoas_7d: number | null
  /** 7 dias, do mais antigo pro de hoje */
  sparkline_7d: number[]
  ultimo_clique: string | null
  sem_braco: boolean
}

/** o link inteiro, como o banco enxerga (lnk_link_snapshot) */
export type LinkSnapshot = {
  id: string
  nome: string
  projeto: string
  divisao: 'clique' | 'pessoa'
  merge_query: 'append' | 'ignorar' | 'whitelist'
  query_whitelist: string[]
  ativo: boolean
  congelado: boolean
  estado: LinkEstado
  expira_em: string | null
  destino_expirado: string | null
  tags: string[]
  observacao: string | null
  is_destino_de_anuncio: boolean
  preview: LinkPreview
  destinos: LinkDestino[]
  params: LinkParam[]
  urls: LinkUrl[]
  url_curta: string | null
  protegido: boolean
  criado_em: string
  atualizado_em: string
}

export type Dim = {
  itens: { k: string; n: number; pct: number | null }[]
  total: number
  restantes: number
  sem_valor: number
}

export type LinkDetalhe = {
  ok: boolean
  erro?: string
  link: LinkSnapshot
  periodo: { de: string; ate: string; grao: 'hora' | 'dia'; tz: string; dias: number }
  kpis: {
    acessos: number
    cliques: number
    robos: number
    crawlers: number
    internos: number
    bloqueados: number
    nao_classificados: number
    pct_robo: number | null
    pessoas: number | null
    cliques_com_cookie: number
    pct_com_cookie: number | null
    visitas_repetidas: number
    ips_distintos: number
    cliques_hoje: number
    primeiro_clique: string | null
    ultimo_clique: string | null
    completude: { aparelho: number | null; cidade: number | null; referer: number | null; cookie: number | null }
    cliques_periodo_anterior: number
    variacao_pct: number | null
  }
  serie: { t: string; acessos: number; cliques: number; robos: number; parcial: boolean }[]
  por_aparelho: Dim
  por_sistema: Dim
  por_navegador: Dim
  por_familia: Dim
  por_pais: Dim
  por_regiao: Dim
  por_cidade: Dim
  por_referer: Dim
  por_utm: { source: Dim; medium: Dim; campaign: Dim; content: Dim; term: Dim }
  por_destino: {
    id: string; rotulo: string; url: string; ativo: boolean
    peso: number; peso_base: number
    pct_configurado: number | null
    cliques: number; cliques_janela: number
    pct_real: number | null; margem_pp: number | null
    desde: string; janela_truncada: boolean; comparavel: boolean
  }[]
  por_dominio: { host: string; slug: string; acessos: number; cliques: number; robos: number; ultimo: string | null }[]
  ultimos_acessos: {
    id: string; ts: string; classe: string; motivos: string[]; contavel: boolean
    device: string | null; os: string | null; browser: string | null; familia: string | null
    cidade: string | null; regiao: string | null; pais: string | null
    referer: string | null; destino: string | null
    utm_source: string | null; utm_campaign: string | null; utm_content: string | null
    host: string; slug: string; cookie: 'novo' | 'volta' | null
    worker_v: string | null; fonte: string | null
  }[]
  historico: {
    id: number; acao: string; campos: string[]; por: string | null; em: string; resumo: string
    antes: Record<string, unknown> | null; depois: Record<string, unknown> | null
  }[]
  frescor: { ultimo_evento: string | null; agora: string }
  /** camada didatica, escrita no banco pra ficar igual em toda tela */
  notas: Record<string, string>
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

/** resposta de escrita: ok, ou erro em portugues; `precisa_forcar` = o banco
 *  quer uma confirmacao explicita antes de fazer o que foi pedido */
export type Resposta<T = Record<string, never>> = T & {
  ok: boolean
  erro?: string
  precisa_forcar?: boolean
  aviso?: string | null
  propagacao?: string
}

function exigirOk<T extends { ok: boolean; erro?: string }>(r: T | null | undefined): T {
  // nunca tratar {ok:false} como sucesso
  if (!r?.ok) throw new Error(r?.erro ?? 'O pedido não foi registrado. Tenta de novo.')
  return r
}

// ---------- leitura ----------
export const linksDominios = () => rpc<LinkDominiosPainel>('lnk_painel_dominios')

export type OrdemLista = 'recentes' | 'cliques' | 'nome' | 'ultimo'
export const linksListar = (
  busca = '', projeto: string | null = null, limite = 60,
  ordem: OrdemLista = 'recentes', tag: string | null = null, estado: LinkEstado | null = null,
) =>
  rpc<LinkItem[]>('lnk_painel_listar', {
    p_busca: busca.trim() || null, p_projeto: projeto, p_limite: limite,
    p_ordem: ordem, p_tag: tag, p_estado: estado,
  })

export const linksTags = (projeto: string | null = null) =>
  rpc<{ tag: string; n: number }[]>('lnk_painel_tags', { p_projeto: projeto })

export const linksCliques = (dias: number, linkId: string | null = null) =>
  rpc<LinkCliques>('lnk_painel_cliques', { p_dias: dias, p_link_id: linkId })

/** detalhe por link. de/ate em ISO; grao 'hora' | 'dia' | null (o banco escolhe) */
export const linksDetalhe = async (
  id: string, de: string | null = null, ate: string | null = null, grao: 'hora' | 'dia' | null = null,
) => exigirOk(await rpc<LinkDetalhe>('lnk_painel_link', { p_link_id: id, p_de: de, p_ate: ate, p_grao: grao }))

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
export type NovoDestino = { id?: string; url: string; rotulo?: string; peso: number; ativo?: boolean }
export type NovoParam = { chave: string; valor: string; rotulo_destino?: string; destino_id?: string | null; ordem?: number }

export type ExtrasCriar = {
  slug?: string | null
  dominio?: string | null
  tags?: string[]
  observacao?: string | null
  expira_em?: string | null
  preview?: Partial<LinkPreview> | null
}

export const linksCriar = async (
  nome: string, destinos: NovoDestino[], params: NovoParam[],
  divisao: 'clique' | 'pessoa' = 'clique', projeto = 'hx-geral', extras: ExtrasCriar = {},
) =>
  exigirOk(await rpc<Resposta<{
    id?: string; urls_criadas?: number
    urls?: { dominio: string; slug: string; url: string; estado: DominioEstado }[]
    link?: LinkSnapshot
  }>>('lnk_criar', {
    p_projeto: projeto, p_nome: nome, p_destinos: destinos,
    p_params: params, p_divisao: divisao, p_merge_query: 'append',
    p_slug: extras.slug?.trim() || null, p_dominio: extras.dominio || null,
    p_tags: extras.tags ?? [], p_observacao: extras.observacao?.trim() || null,
    p_expira_em: extras.expira_em || null, p_preview: extras.preview ?? null,
  }))

/** patch: so o que veio muda. destinos e params sao a LISTA COMPLETA. */
export type PatchLink = {
  nome?: string
  divisao?: 'clique' | 'pessoa'
  merge_query?: 'append' | 'ignorar' | 'whitelist'
  query_whitelist?: string[]
  tags?: string[]
  observacao?: string | null
  expira_em?: string | null
  destino_expirado?: string | null
  is_destino_de_anuncio?: boolean
  preview?: Partial<LinkPreview>
  destinos?: NovoDestino[]
  params?: NovoParam[]
}

/** o banco valida tudo antes de gravar; erro volta em portugues, nada meio-escrito */
export const linksEditar = (id: string, patch: PatchLink) =>
  rpc<Resposta<{ link?: LinkSnapshot; campos?: string[] }>>('lnk_link_editar', { p_link_id: id, p_patch: patch })

/** pausado = fora do ar · congelado = no ar, config nao muda (cache longo) · ativo */
export const linksEstado = (id: string, estado: 'ativo' | 'pausado' | 'congelado', forcar = false) =>
  rpc<Resposta<{ link?: LinkSnapshot; estado?: string }>>('lnk_link_estado', {
    p_link_id: id, p_estado: estado, p_forcar: forcar,
  })

/** cria ou renomeia o slug do link num dominio. Renomear com clique pede forcar;
 *  URL protegida nunca renomeia (o banco recusa mesmo com forcar). */
export const linksSlug = (id: string, hostname: string, slug: string, forcar = false) =>
  rpc<Resposta<{ url?: string; renomeado_de?: string | null; sem_mudanca?: boolean; link?: LinkSnapshot }>>(
    'lnk_url_custom', { p_link_id: id, p_hostname: hostname, p_slug: slug, p_forcar: forcar })

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

/** regra do slug personalizado, igual a do banco (o banco revalida) */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/
export const SLUGS_RESERVADOS = new Set([
  'api', 'admin', 'app', 'login', 'logout', 'static', 'assets', 'www', 'health', 'status',
  'dev', 'test', 'null', 'undefined', 'robots', 'favicon', 'sitemap', 'warm',
])
export function normalizaSlug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
}
export function problemaDoSlug(s: string): string | null {
  if (!s) return null
  if (!SLUG_RE.test(s)) return 'De 3 a 40 caracteres: letras minúsculas, números, traço e sublinhado.'
  if (SLUGS_RESERVADOS.has(s)) return 'Esse slug é reservado.'
  return null
}
