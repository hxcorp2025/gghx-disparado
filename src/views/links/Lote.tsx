import { useMemo, useState } from 'react'
import { Check, Copy, Download, Layers, ArrowLeft } from 'lucide-react'
import { Modal } from '../../components/Modal'
import {
  linksCriarLote, normalizaSlug, LOTE_MAX, LOTE_PASSO,
  type LinkProjeto, type LinhaLote, type LinhaLoteResultado, type LoteResultado,
} from '../../lib/linksDb'
import { toast } from '../../lib/toast'
import { Ajuda, copiarTexto, n } from './comum'

type Props = {
  projetos: LinkProjeto[]
  projetoInicial: string
  onFechar: () => void
  /** chamado depois de qualquer criacao (inclusive parcial), pra lista recarregar */
  onCriou: () => void
}

// =====================================================================
// Criar varios links de uma vez colando linhas. O front so LE o texto e
// mostra; quem valida e cria e o banco (lnk_criar_lote), linha a linha:
// uma linha ruim nao derruba as outras. Dois passos de proposito:
// "Conferir" (nada e criado) e so depois "Criar as N".
// =====================================================================

/**
 * Uma linha por link: `url` ou `url, nome, slug, tag1|tag2`. Tab e ponto e
 * virgula separam colunas; a virgula so separa quando vem seguida de espaco.
 * Virgula colada e parte do endereco (`?utm_content=video,carrossel`,
 * `?ids=1,2,3`): cortar ali criava um link apontando pro destino errado e
 * o banco nao pega, porque so valida o comeco da URL (revisao 15/09).
 */
export function lerLinhas(texto: string): LinhaLote[] {
  const out: LinhaLote[] = []
  texto.split(/\r?\n/).forEach((bruta, idx) => {
    const l = bruta.trim()
    if (!l) return
    // cabecalho de planilha ("url,nome,slug,tags") nao e link
    if (/^(url|destino|link)\b/i.test(l) && !/:\/\//.test(l)) return
    const sep = l.includes('\t') ? '\t' : l.includes(';') ? ';' : /,\s/.test(l) ? ',' : null
    // com virgula, so a "virgula + espaco" separa: a colada continua no endereco
    const partes = sep ? l.split(sep === ',' ? /,\s+/ : sep).map((p) => p.trim()) : [l]
    const [url = '', nome = '', slug = '', tags = ''] = partes
    out.push({
      n: idx + 1, url, nome: nome || null, slug: slug ? normalizaSlug(slug) : null,
      tags: tags ? tags.split('|').map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
    })
  })
  return out
}

function baixarCsv(linhas: LinhaLoteResultado[]) {
  const esc = (s: string | null) => `"${(s ?? '').replace(/"/g, '""')}"`
  const corpo = ['nome;url_curta;destino;slug;tags',
    ...linhas.map((l) => [esc(l.nome), esc(l.url_curta), esc(l.url), esc(l.slug), esc(l.tags.join('|'))].join(';'))].join('\n')
  const href = URL.createObjectURL(new Blob(['﻿' + corpo], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = href
  a.download = `links-lote-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

/** o que a tela SABE quando uma fatia falha: o que ja voltou criado, a faixa
 *  em voo (pode ter sido criada ou nao) e o que nem chegou a ser tentado */
type Parada = { msg: string; de: number; ate: number; naoTentadas: number[] }

export function Lote({ projetos, projetoInicial, onFechar, onCriou }: Props) {
  const [texto, setTexto] = useState('')
  const [projeto, setProjeto] = useState(projetoInicial)
  const [tagsTodos, setTagsTodos] = useState('')
  const [conferido, setConferido] = useState<LoteResultado | null>(null)
  // o texto exatamente como estava na conferencia: mudou uma virgula, confere de novo
  const [textoConferido, setTextoConferido] = useState('')
  const [fase, setFase] = useState<'colar' | 'criando' | 'feito'>('colar')
  const [progresso, setProgresso] = useState({ feitas: 0, total: 0 })
  const [criadas, setCriadas] = useState<LinhaLoteResultado[]>([])
  const [falhas, setFalhas] = useState<LinhaLoteResultado[]>([])
  const [parou, setParou] = useState<Parada | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const linhas = useMemo(() => lerLinhas(texto), [texto])
  const defaults = useMemo(() => ({
    tags: tagsTodos.split(/[,|]/).map((t) => t.trim().toLowerCase()).filter(Boolean),
  }), [tagsTodos])

  async function conferir() {
    if (ocupado) return
    if (!linhas.length) { toast('Cola pelo menos uma linha com um destino.', true); return }
    if (linhas.length > LOTE_MAX) { toast(`No máximo ${LOTE_MAX} links por vez. Vieram ${n(linhas.length)}: divide em duas colagens.`, true); return }
    setOcupado(true)
    try {
      const r = await linksCriarLote(projeto, linhas, true, defaults)
      setConferido(r)
      setTextoConferido(texto)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function criar() {
    if (!conferido || ocupado) return
    const validas = conferido.linhas.filter((l) => l.ok)
    if (!validas.length) return
    setOcupado(true)
    setFase('criando')
    setProgresso({ feitas: 0, total: validas.length })
    const ok: LinhaLoteResultado[] = []
    const ruim: LinhaLoteResultado[] = []
    let houveParada = false
    try {
      // 50 por chamada: o papel do painel tem 8 s por pedido, e cada link
      // grava destinos, params, URLs, historico e a fila do KV
      for (let i = 0; i < validas.length; i += LOTE_PASSO) {
        const fatia: LinhaLote[] = validas.slice(i, i + LOTE_PASSO)
          .map((l) => ({ n: l.n, url: l.url, nome: l.nome, slug: l.slug, tags: l.tags }))
        // a faixa em voo: se a resposta se perder, o banco pode ter commitado
        // e a tela NAO sabe. Ela precisa dizer isso em vez de fingir certeza.
        const faixa = { de: fatia[0].n, ate: fatia[fatia.length - 1].n }
        try {
          const r = await linksCriarLote(projeto, fatia, false, defaults)
          for (const l of r.linhas) (l.ok ? ok : ruim).push(l)
        } catch (e) {
          houveParada = true
          setParou({
            msg: e instanceof Error ? e.message : 'Falhou',
            de: faixa.de, ate: faixa.ate,
            naoTentadas: validas.slice(i + LOTE_PASSO).map((l) => l.n),
          })
          break
        }
        setProgresso({ feitas: Math.min(i + LOTE_PASSO, validas.length), total: validas.length })
        setCriadas([...ok])
        setFalhas([...ruim])
      }
    } finally {
      setCriadas([...ok])
      setFalhas([...ruim])
      setFase('feito')
      setOcupado(false)
      // parou no meio tambem recarrega a lista: e la que a pessoa confere o
      // que existe de verdade antes de colar de novo
      if (ok.length || houveParada) onCriou()
    }
  }

  async function copiarTodas() {
    const txt = criadas.map((l) => `${l.nome ?? ''}\t${l.url_curta ?? ''}`).join('\n')
    const ok = await copiarTexto(txt)
    toast(ok ? `${n(criadas.length)} endereço(s) copiado(s), um por linha.` : 'Não consegui copiar. Baixa o CSV.', !ok)
  }

  function fecharResultado() {
    if (fase === 'criando') { toast('Espera terminar: fechar agora não desfaz o que já foi criado.'); return }
    onFechar()
  }

  const resumoFaixas = (de: number, ate: number) => (de === ate ? `linha ${de}` : `linhas ${de} a ${ate}`)

  // ---------- resultado ----------
  if (fase === 'criando' || fase === 'feito') {
    const pct = progresso.total ? Math.round((100 * progresso.feitas) / progresso.total) : 0
    return (
      <Modal title={fase === 'criando' ? 'Criando os links...' : parou ? 'Parou no meio' : 'Lote criado'}
        sub={fase === 'criando'
          ? 'Não fecha esta janela: cada linha vira um link com URL curta e histórico.'
          : `${n(criadas.length)} link(s) criado(s)${falhas.length ? `, ${n(falhas.length)} não` : ''}.`}
        onClose={fecharResultado}>
        <div className="lote-prog" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="lote-prog-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="mut" style={{ fontSize: 12.5, margin: '6px 0 12px' }}>{n(progresso.feitas)} de {n(progresso.total)}</p>

        {parou && (
          <div className="card" style={{ marginBottom: 12, borderColor: 'var(--red)' }}>
            <b>Parou no meio: {parou.msg}</b>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
              {criadas.length > 0 && <li><b>{n(criadas.length)} já existem</b>: são as da tabela abaixo.</li>}
              <li><b>{resumoFaixas(parou.de, parou.ate)} podem ter sido criadas ou não</b>: não recebi a confirmação
                dessa fatia. Confere na lista (busca pelo destino) antes de colar essas de novo.</li>
              {parou.naoTentadas.length > 0 && (
                <li><b>{resumoFaixas(parou.naoTentadas[0], parou.naoTentadas[parou.naoTentadas.length - 1])} não foram criadas</b>: essas pode colar de novo à vontade.</li>
              )}
            </ul>
          </div>
        )}

        {falhas.length > 0 && (
          <div className="card" style={{ marginBottom: 12, borderColor: 'var(--amber)' }}>
            <b>{n(falhas.length)} linha(s) não criada(s)</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
              {falhas.map((l) => <li key={l.n}>linha {l.n}: {l.erro}</li>)}
            </ul>
          </div>
        )}

        {criadas.length > 0 && (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={copiarTodas}><Copy size={13} />Copiar todas (nome e URL)</button>
              <button className="btn ghost sm" onClick={() => baixarCsv(criadas)}><Download size={13} />Baixar CSV</button>
            </div>
            <div className="scroll">
              {/* sem largura minima: no celular a coluna do botao de copiar precisa caber na tela */}
              <table>
                <thead><tr><th>#</th><th>Nome</th><th>URL curta</th><th>Copiar</th></tr></thead>
                <tbody>
                  {criadas.map((l) => (
                    <tr key={l.n}>
                      <td className="num">{l.n}</td>
                      <td>{l.nome}</td>
                      <td><code style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{(l.url_curta ?? '').replace(/^https:\/\//, '')}</code></td>
                      <td>
                        <button className="btn ghost sm" aria-label={`Copiar ${l.url_curta ?? ''}`} onClick={async () => {
                          const ok = await copiarTexto(l.url_curta ?? '')
                          toast(ok ? 'Copiado' : 'Toque e segure no endereço pra copiar', !ok)
                        }}><Copy size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {fase === 'feito' && (
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={onFechar}><Check size={15} />Fechar</button>
          </div>
        )}
      </Modal>
    )
  }

  // ---------- colar e conferir ----------
  const validas = conferido?.linhas.filter((l) => l.ok) ?? []
  const invalidas = conferido?.linhas.filter((l) => !l.ok) ?? []
  const desatualizado = !!conferido && texto !== textoConferido
  const projetoNome = projetos.find((p) => p.slug === projeto)?.nome ?? projeto

  return (
    <Modal title="Criar vários links" sub="Cola uma lista, confere, cria. Cada linha vira um link com URL curta." onClose={onFechar}>
      <div className="field">
        <label htmlFor="lote-txt">Uma linha por link</label>
        <textarea id="lote-txt" className="lote-txt" value={texto} rows={8} spellCheck={false}
          placeholder={'https://exemplo.com/pagina-1\nhttps://exemplo.com/pagina-2, Nome do link, slug-curto, tag1|tag2'}
          onChange={(e) => setTexto(e.target.value)} />
        <span className="mut" style={{ fontSize: 12 }}>
          {n(linhas.length)} linha(s) com conteúdo{linhas.length > LOTE_MAX ? ` (máximo ${LOTE_MAX} por vez)` : ''}.
          Só a URL já basta; nome, slug e tags são opcionais.
        </span>
      </div>

      <div className="grid2">
        <div className="field">
          <label htmlFor="lote-proj">Projeto</label>
          <select id="lote-proj" value={projeto} onChange={(e) => { setProjeto(e.target.value); setConferido(null) }}>
            {projetos.map((p) => <option key={p.slug} value={p.slug}>{p.nome}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="lote-tags">Tags pra todos <span className="mut">(opcional)</span></label>
          <input id="lote-tags" value={tagsTodos} placeholder="lote-set, promo" onChange={(e) => { setTagsTodos(e.target.value); setConferido(null) }} />
        </div>
      </div>

      <Ajuda titulo="como montar a lista">
        Cola direto de uma planilha (tab separa as colunas) ou escreve à mão, nesta ordem:
        <b> destino, nome, slug, tags</b>. Depois da vírgula, deixa um espaço: vírgula colada conta
        como parte do endereço (<code>?ids=1,2,3</code> continua inteiro). Se preferir, separa por
        ponto e vírgula. Tags separadas por barra vertical (<code>vip|setembro</code>). Sem nome,
        uso o próprio endereço. Sem slug, sai um aleatório de 6 letras. Slug personalizado nasce no
        domínio institucional (fora do rodízio); os outros domínios ativos ganham slug aleatório,
        igual ao link criado um a um. Na conferência o destino aparece inteiro: é ali que você vê
        se alguma linha foi lida errado.
      </Ajuda>

      {conferido && !desatualizado && (
        <div className="card" style={{ marginTop: 14 }}>
          <b>{n(validas.length)} pronta(s) pra criar em {projetoNome}{invalidas.length ? `, ${n(invalidas.length)} com problema` : ''}</b>
          {conferido.dominio && validas.some((l) => l.slug) && (
            <p className="mut" style={{ fontSize: 12.5, margin: '4px 0 0' }}>Slugs personalizados vão nascer em {conferido.dominio}.</p>
          )}
          {invalidas.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
              {invalidas.map((l) => (
                <li key={l.n}><b>linha {l.n}</b>: {l.erro} <span className="mut" style={{ wordBreak: 'break-all' }}>({l.url || 'vazia'})</span></li>
              ))}
            </ul>
          )}
          {validas.length > 0 && (
            <div className="scroll" style={{ marginTop: 10 }}>
              <table className="tabela-min">
                <thead><tr><th>#</th><th>Destino (inteiro)</th><th>Nome</th><th>Slug</th><th>Tags</th></tr></thead>
                <tbody>
                  {validas.slice(0, 60).map((l) => (
                    <tr key={l.n}>
                      <td className="num">{l.n}</td>
                      <td><span className="mut" style={{ fontSize: 12, wordBreak: 'break-all' }}>{l.url.replace(/^https?:\/\//, '')}</span></td>
                      <td>{l.nome}</td>
                      <td><code style={{ fontSize: 12 }}>{l.slug ?? 'aleatório'}</code></td>
                      <td>{l.tags.join(', ') || '·'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {validas.length > 60 && <p className="mut" style={{ fontSize: 12, margin: '6px 0 0' }}>Mostrando 60 de {n(validas.length)}.</p>}
            </div>
          )}
        </div>
      )}
      {desatualizado && (
        <p className="st-pulado" style={{ fontSize: 12.5, marginTop: 10 }}>O texto mudou depois da conferência. Confere de novo antes de criar.</p>
      )}

      <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
        {!conferido || desatualizado ? (
          <button className="btn" onClick={conferir} disabled={ocupado || !linhas.length || linhas.length > LOTE_MAX}>
            {ocupado ? <i className="spin" /> : <Layers size={15} />}{ocupado ? 'Conferindo...' : 'Conferir (não cria nada ainda)'}
          </button>
        ) : (
          <>
            <button className="btn" onClick={criar} disabled={ocupado || !validas.length}>
              <Check size={15} />Criar {n(validas.length)} link(s){invalidas.length ? ` e pular ${n(invalidas.length)}` : ''}
            </button>
            <button className="btn ghost" onClick={() => setConferido(null)}><ArrowLeft size={14} />Voltar e corrigir</button>
          </>
        )}
        <button className="btn ghost" onClick={onFechar}>Cancelar</button>
      </div>
    </Modal>
  )
}
