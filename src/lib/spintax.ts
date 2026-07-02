// Spintax: {opção A|opção B|opção C} gera 1 variação aleatória por envio (anti-ban).
// Suporta aninhamento: {oi {mano|chefe}|e aí}. Variáveis usam colchetes: [grupo] (trocado no motor).

// expande spintax escolhendo aleatoriamente (innermost-first). NÃO toca em [variaveis].
export function spin(text: string, rand: () => number = Math.random): string {
  let s = text
  const re = /\{([^{}]*)\}/
  let guard = 0
  while (re.test(s) && guard++ < 10000) {
    s = s.replace(re, (_m, inner: string) => {
      const opts = inner.split('|')
      return opts[Math.floor(rand() * opts.length)]
    })
  }
  return s
}

// conta o total de variações distintas (parser recursivo; trata aninhamento e números literais).
export function countVariations(text: string): number {
  let i = 0
  // sequência até fim / '}' / (se stopOnBar) '|' → produto dos grupos internos
  function parseSeq(stopOnBar: boolean): number {
    let product = 1
    while (i < text.length) {
      const c = text[i]
      if (c === '}') break
      if (stopOnBar && c === '|') break
      if (c === '{') {
        i++ // consome '{'
        product *= parseGroup()
      } else {
        i++ // literal, não afeta a contagem
      }
    }
    return product
  }
  // alternativas até '}' → soma da contagem de cada alternativa
  function parseGroup(): number {
    let sum = parseSeq(true)
    while (i < text.length && text[i] === '|') {
      i++ // consome '|'
      sum += parseSeq(true)
    }
    if (i < text.length && text[i] === '}') i++ // consome '}'
    return sum
  }
  return parseSeq(false)
}

// true se o texto usa spintax (tem pelo menos um grupo com opções)
export function hasSpintax(text: string): boolean {
  return /\{[^{}]*\|[^{}]*\}/.test(text)
}
