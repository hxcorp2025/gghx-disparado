/**
 * Regras do construtor de UTM.
 *
 * Funcoes puras de proposito: sao a unica parte com regra de negocio que da
 * pra testar na mao, e nao devem depender de React. O banco revalida tudo;
 * o front valida pra ENSINAR, o banco valida pra VALER.
 */

export const UTMS_PADRAO = [
  { chave: 'utm_source', rotulo: 'De onde vem', dica: 'whatsapp, instagram, email' },
  { chave: 'utm_medium', rotulo: 'Tipo de canal', dica: 'grupo, cpc, organico' },
  { chave: 'utm_campaign', rotulo: 'Campanha', dica: 'vip-setembro' },
  { chave: 'utm_content', rotulo: 'Peça ou braço', dica: 'braco-a (é isto que separa o A/B)' },
  { chave: 'utm_term', rotulo: 'Palavra', dica: 'raro no WhatsApp' },
] as const

export type ParDeUtm = { chave: string; valor: string }

/**
 * Normaliza o VALOR de uma UTM enquanto a pessoa digita.
 * Sem isso, "Black Friday" e "black-friday" viram duas campanhas diferentes
 * no Google Analytics e a soma nunca fecha.
 * O hifen no fim e preservado, senao e impossivel escrever "black-friday".
 */
export function normalizaValor(v: string): string {
  return v
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
}

export function normalizaChave(c: string): string {
  return c.trim().replace(/[^A-Za-z0-9_.-]/g, '')
}

export type LeituraDoDestino = {
  ok: boolean
  erro?: string
  /** o destino sem as UTMs, que e o que volta pro campo */
  base: string
  /** as utm_* que ja vinham na URL e subiram pros campos */
  utmsAchadas: ParDeUtm[]
  /** parametros que NAO sao utm e continuam intocados */
  outrosParams: ParDeUtm[]
  ancora: string | null
}

/**
 * Le um destino colado e separa o que e UTM do que nao e.
 * Nada some em silencio: o que nao for UTM continua no link e a tela avisa.
 */
export function lerDestino(bruto: string): LeituraDoDestino {
  const txt = (bruto || '').trim()
  if (!txt) return { ok: false, erro: 'Cola o endereço de destino.', base: '', utmsAchadas: [], outrosParams: [], ancora: null }

  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(txt) ? txt : 'https://' + txt)
  } catch {
    return { ok: false, erro: 'Isso não parece um endereço. Começa com http?', base: '', utmsAchadas: [], outrosParams: [], ancora: null }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, erro: 'Só aceito endereço http ou https.', base: '', utmsAchadas: [], outrosParams: [], ancora: null }
  }

  const utms: ParDeUtm[] = []
  const outros: ParDeUtm[] = []
  for (const [k, v] of [...u.searchParams]) {
    if (/^utm_/i.test(k)) utms.push({ chave: k.toLowerCase(), valor: v })
    else outros.push({ chave: k, valor: v })
  }

  // a base volta sem as UTMs (elas passam a viver nos campos), mas com o que
  // nao e UTM e com a ancora
  const base = new URL(u.toString())
  for (const { chave } of utms) base.searchParams.delete(chave)

  return {
    ok: true,
    base: base.toString(),
    utmsAchadas: utms,
    outrosParams: outros,
    ancora: u.hash ? u.hash.slice(1) : null,
  }
}

export type Problema = { onde: string; msg: string }

/**
 * Valida o conjunto antes de deixar criar. Devolve os problemas em linguagem
 * de operador, nunca de banco.
 */
export function validar(
  destinoBase: string,
  padrao: ParDeUtm[],
  custom: ParDeUtm[],
  extras: { url: string; peso: number }[] = [],
): Problema[] {
  const p: Problema[] = []
  const leitura = lerDestino(destinoBase)
  if (!leitura.ok) p.push({ onde: 'destino', msg: leitura.erro! })

  // Destino extra em branco passava batido: o peso dele já entrava na soma, a
  // tela mostrava "33,3%" ao lado de um campo vazio, e um terço do disparo ia
  // pra um destino que não existe.
  extras.forEach((d, i) => {
    if (!d.url.trim()) {
      p.push({ onde: `destino-${i}`, msg: 'Esse destino está sem endereço.' })
    } else if (!/^https?:\/\//i.test(d.url.trim())) {
      // O banco exige o esquema. Sem esta linha o campo passava aqui, porque
      // lerDestino prefixa https sozinho, e só falhava lá no submit com um erro
      // genérico no topo. Não normalizo em silêncio de propósito: transformar
      // //evil.com em https://evil.com seria pior que recusar.
      p.push({ onde: `destino-${i}`, msg: 'Esse endereço precisa começar com http:// ou https://.' })
    } else if (!lerDestino(d.url).ok) {
      p.push({ onde: `destino-${i}`, msg: 'Esse endereço não parece válido.' })
    }
    if (!(d.peso >= 0)) {
      p.push({ onde: `destino-${i}`, msg: 'O peso precisa ser 0 ou mais.' })
    }
  })

  const vistas = new Set(padrao.filter((x) => x.valor.trim()).map((x) => x.chave.toLowerCase()))
  custom.forEach((c, i) => {
    const chave = normalizaChave(c.chave).toLowerCase()
    if (!chave && c.valor.trim()) {
      p.push({ onde: `custom-${i}`, msg: 'Essa linha tem valor mas está sem nome.' })
      return
    }
    if (!chave) return
    if (vistas.has(chave)) {
      p.push({ onde: `custom-${i}`, msg: `"${chave}" já está lá em cima. Muda o nome ou apaga.` })
    }
    vistas.add(chave)
  })
  return p
}

/**
 * Monta a URL final pra PREVIA na tela.
 * O redirecionador na borda faz o mesmo, mas quem manda la e o banco: esta
 * funcao existe pra pessoa ver o que vai acontecer antes de criar.
 */
export function montarPreview(destinoBase: string, padrao: ParDeUtm[], custom: ParDeUtm[]): string {
  const leitura = lerDestino(destinoBase)
  if (!leitura.ok) return ''
  let u: URL
  try { u = new URL(leitura.base) } catch { return '' }

  for (const { chave, valor } of [...padrao, ...custom]) {
    const c = normalizaChave(chave)
    if (!c || !valor.trim()) continue
    u.searchParams.set(c, valor.trim())
  }
  // a ancora fica no fim, que e a unica ordem que o navegador entende.
  // new URL ja cuida disso ao serializar.
  return u.toString()
}
