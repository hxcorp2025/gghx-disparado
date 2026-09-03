// Rede de seguranca do CSS. O app nao tem teste, e as duas regressoes mais caras
// aqui nao geram erro de build: classe que perde o estilo e token que some.
// A classe .b-pausada, por exemplo, e montada em template string a partir do
// status que vem do banco: apagar ela do CSS deixa o badge invisivel em
// producao sem ninguem perceber.
//
// Rodar: npm run verifica
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const raiz = process.cwd()
const anda = (dir, filtro, achados = []) => {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome === 'dist' || nome === 'legacy' || nome.startsWith('.')) continue
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) anda(caminho, filtro, achados)
    else if (filtro.test(nome)) achados.push(caminho)
  }
  return achados
}
const ler = (paths) => paths.map((p) => readFileSync(p, 'utf8')).join('\n')
const curto = (p) => relative(raiz, p).replace(/\\/g, '/')

const cssPaths = anda(join(raiz, 'src'), /\.css$/)
// fonts.css e so @font-face: sem seletor, e o .woff2 dos nomes de arquivo
// entraria na lista de classes
const cssComSeletor = cssPaths.filter((p) => !p.endsWith('fonts.css'))
const tsxPaths = anda(join(raiz, 'src'), /\.tsx$/)
const htmlPaths = [join(raiz, 'index.html'), join(raiz, 'public', 'manual.html')]

const css = ler(cssPaths)
const cssSeletores = ler(cssComSeletor)
const jsx = ler(tsxPaths)
const html = ler(htmlPaths)
const cssLimpo = css.replace(/\/\*[\s\S]*?\*\//g, '')

// --- 1. classe usada no JSX que ficou sem estilo ---------------------------
const definidas = new Set(
  [...cssSeletores.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
)

// Le so o VALOR de className, com chaves balanceadas: pegar a linha inteira faz
// texto em portugues virar "classe orfa" e enche o relatorio de ruido.
const classesDoJsx = (txt) => {
  const achadas = new Set()
  for (const m of txt.matchAll(/className=/g)) {
    let i = m.index + m[0].length
    let fatia = ''
    if (txt[i] === '{') {
      let nivel = 0
      let j = i
      for (; j < txt.length; j++) {
        if (txt[j] === '{') nivel++
        else if (txt[j] === '}' && --nivel === 0) break
      }
      fatia = txt.slice(i + 1, j)
    } else if (txt[i] === '"' || txt[i] === "'") {
      fatia = txt.slice(i + 1, txt.indexOf(txt[i], i + 1))
    } else continue
    const literais = [...fatia.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map(
      (x) => x[1] ?? x[2] ?? x[3] ?? '',
    )
    for (const bruto of literais.length ? literais : [fatia]) {
      for (const c of bruto.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(c)) achadas.add(c)
      }
    }
  }
  return achadas
}

const usadas = classesDoJsx(jsx)
// Nem toda classe passa por className: STATUS_LOTE, ROTULO e STATUS guardam o
// nome do badge numa constante e so depois concatenam. Sem varrer literal solto,
// apagar .b-pausada do CSS passaria batido por aqui.
const familias = /^(b|st|c|sc|gtag|pill)-[a-z0-9_]+$/
for (const m of jsx.matchAll(/['"`]([a-z]+-[a-z0-9_]+)['"`]/g)) {
  if (familias.test(m[1])) usadas.add(m[1])
}
// 'badge b-' + status monta o nome em pedacos: o pedaco vale se alguma classe
// definida comeca ou termina com ele.
const eFragmento = (c) =>
  [...definidas].some((d) =>
    c.endsWith('-') ? d.startsWith(c) : d.startsWith(`${c}-`) || d.endsWith(`-${c}`),
  )
const orfas = [...usadas].filter((c) => !definidas.has(c) && !eFragmento(c)).sort()

// checagem reversa: classe definida que ninguem usa. Nao reprova (variante de
// estado pode estar so no banco), mas foi assim que apareceu o .vidro morto.
const semUso = [...definidas]
  .filter((d) => {
    const solto = new RegExp(String.raw`(^|[^\w-])` + d.replace(/-/g, '\-') + String.raw`([^\w-]|$)`)
    return !usadas.has(d) && !solto.test(jsx) && !solto.test(html) && !familias.test(d)
  })
  .sort()

// --- 2. var(--token) sem definicao ----------------------------------------
// duas declaracoes na mesma linha sao comuns (--ok: x; --ok-soft: y)
const declarados = new Set([...css.matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]))
const tudo = css + jsx + html
const usados = new Set([...tudo.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))
// token lido em runtime pelo grafico: tok('--serie-1', ...)
for (const m of jsx.matchAll(/tok\(\s*'(--[\w-]+)'/g)) usados.add(m[1])
const comAlternativa = new Set([...tudo.matchAll(/var\(\s*(--[\w-]+)\s*,/g)].map((m) => m[1]))
const indefinidos = [...usados].filter((t) => !declarados.has(t) && !comAlternativa.has(t)).sort()

// --- 3. invariantes do padrao (DESIGN.md) ---------------------------------
const avisos = []
const seletoresBlur = [
  ...new Set([...cssLimpo.matchAll(/([^{}\n]+)\{[^{}]*backdrop-filter:(?!\s*none)/g)].map((m) => m[1].trim())),
]
if (/#000\b|#000000\b/.test(cssLimpo)) avisos.push('preto puro no CSS: o mais escuro do padrao e #08090b')
if (css.includes('url(#vidro-liquido)') && !html.includes('vidro-liquido'))
  avisos.push('o CSS usa o filtro #vidro-liquido, mas o <svg> nao esta no HTML')

// travessao no texto que o operador LE (comentario de codigo fica de fora)
const semComentario = (t) =>
  t
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
const comTravessao = [...tsxPaths, ...htmlPaths].filter((p) =>
  semComentario(readFileSync(p, 'utf8')).includes('—'),
)
if (comTravessao.length) avisos.push(`travessao em texto de interface: ${comTravessao.map(curto).join(', ')}`)

console.log(`css: ${cssPaths.map(curto).join(', ')}`)
console.log(`classes definidas ${definidas.size} · usadas no JSX ${usadas.size}`)
console.log(`tokens declarados ${declarados.size} · usados ${usados.size}`)
console.log(`superficies com blur: ${seletoresBlur.length} · ${seletoresBlur.join(' | ')}`)
console.log('')

let falhou = false
if (orfas.length) {
  falhou = true
  console.log(`CLASSE USADA SEM ESTILO (${orfas.length}):`)
  orfas.forEach((c) => console.log(`   .${c}`))
} else console.log('ok: toda classe do JSX tem estilo')

if (indefinidos.length) {
  falhou = true
  console.log(`TOKEN USADO E NAO DEFINIDO (${indefinidos.length}):`)
  indefinidos.forEach((t) => console.log(`   ${t}`))
} else console.log('ok: nenhum var(--token) sem definicao')

if (semUso.length) console.log(`aviso: ${semUso.length} classes definidas e sem uso: ${semUso.join(', ')}`)
avisos.forEach((a) => console.log(`aviso: ${a}`))
process.exit(falhou ? 1 : 0)
