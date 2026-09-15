import { useEffect, useMemo, useState } from 'react'
import { Plus, X, Lock, Save, Check } from 'lucide-react'
import { Modal } from '../../components/Modal'
import {
  linksCriar, linksEditar, linksSlug, normalizaSlug, problemaDoSlug,
  type LinkSnapshot, type LinkDominiosPainel, type NovoDestino, type NovoParam, type PatchLink, type LinkPreview,
} from '../../lib/linksDb'
import {
  UTMS_PADRAO, lerDestino, montarPreview, normalizaValor, normalizaChave, validar, type ParDeUtm,
} from '../../lib/utm'
import { toast } from '../../lib/toast'
import { pct, Ajuda } from './comum'

type Props = {
  modo: 'criar' | 'editar'
  link?: LinkSnapshot
  doms: LinkDominiosPainel | null
  onFechar: () => void
  onSalvo: (link: LinkSnapshot | null) => void
  /** o slug mudou mas o formulario continua aberto: o pai so recarrega */
  onMudouUrls?: () => void
}

// ISO (UTC) -> valor de <input type="datetime-local"> em horario de Brasilia
function isoParaLocal(iso: string | null): string {
  if (!iso) return ''
  const s = new Date(iso).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo', hour12: false })
  return s.replace(' ', 'T').slice(0, 16)
}
// o inverso. Brasil nao tem horario de verao desde 2019, entao -03:00 e fixo.
function localParaIso(local: string): string | null {
  if (!local) return null
  return `${local}:00-03:00`
}

const iguais = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// =====================================================================
// Criar e editar no mesmo formulario. Regra: o front valida pra ENSINAR,
// o banco valida pra VALER (e devolve o erro em portugues). Nada aqui
// e destrutivo: destino que sai da lista e desligado, nunca apagado.
// =====================================================================
export function Editor({ modo, link, doms, onFechar, onSalvo, onMudouUrls }: Props) {
  const editando = modo === 'editar' && !!link

  // ---------- basico ----------
  const [nome, setNome] = useState(link?.nome ?? '')
  const [divisao, setDivisao] = useState<'clique' | 'pessoa'>(link?.divisao ?? 'clique')
  const [mergeQuery, setMergeQuery] = useState<'append' | 'ignorar' | 'whitelist'>(link?.merge_query ?? 'append')

  // ---------- destinos ----------
  // criar: um campo principal (com leitura de UTMs coladas) + extras
  // editar: a lista inteira, com ligar/desligar
  const [destinoBase, setDestinoBase] = useState('')
  const [extras, setExtras] = useState<NovoDestino[]>([])
  const [destinos, setDestinos] = useState<NovoDestino[]>(
    (link?.destinos ?? []).map((d) => ({ id: d.id, url: d.url, rotulo: d.rotulo ?? '', peso: d.peso, ativo: d.ativo })))

  // ---------- UTMs ----------
  const paramsIniciais = link?.params ?? []
  const [padrao, setPadrao] = useState<ParDeUtm[]>(UTMS_PADRAO.map((u) => ({
    chave: u.chave, valor: paramsIniciais.find((p) => p.chave === u.chave && !p.destino_id)?.valor ?? '' })))
  const [custom, setCustom] = useState<ParDeUtm[]>(paramsIniciais
    .filter((p) => !p.destino_id && !UTMS_PADRAO.some((u) => u.chave === p.chave))
    .map((p) => ({ chave: p.chave, valor: p.valor })))
  // parametro amarrado a um braco especifico: raro, e o editor nao mexe nele
  const paramsDeBraco = paramsIniciais.filter((p) => !!p.destino_id)

  // ---------- avancado ----------
  const [tags, setTags] = useState<string[]>(link?.tags ?? [])
  const [tagTxt, setTagTxt] = useState('')
  const [observacao, setObservacao] = useState(link?.observacao ?? '')
  const [expira, setExpira] = useState(isoParaLocal(link?.expira_em ?? null))
  const [destinoExpirado, setDestinoExpirado] = useState(link?.destino_expirado ?? '')
  const [preview, setPreview] = useState<LinkPreview>(link?.preview ?? { modo: 'passthrough', titulo: null, desc: null, img: null })
  const [anuncio, setAnuncio] = useState(link?.is_destino_de_anuncio ?? false)
  const [slug, setSlug] = useState('')
  const dominiosAtivos = (doms?.dominios ?? []).filter((d) => d.estado === 'ativo')
  const [dominioSlug, setDominioSlug] = useState(
    dominiosAtivos.find((d) => !d.no_rodizio)?.hostname ?? dominiosAtivos[0]?.hostname ?? '')
  // renomear slug (editar): um campo por endereco
  const [novoSlug, setNovoSlug] = useState<Record<string, string>>({})
  const [urlsAgora, setUrlsAgora] = useState(link?.urls ?? [])

  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [confirmar, setConfirmar] = useState<{ msg: string; acao: () => Promise<void> } | null>(null)
  const [criado, setCriado] = useState<LinkSnapshot | null>(null)

  // ---------- leitura do destino colado (so criar) ----------
  const leitura = useMemo(() => lerDestino(destinoBase), [destinoBase])
  useEffect(() => {
    if (editando || !leitura.ok || !leitura.utmsAchadas.length) return
    setPadrao((p) => p.map((x) => {
      const achou = leitura.utmsAchadas.find((u) => u.chave === x.chave)
      return achou && !x.valor ? { ...x, valor: normalizaValor(achou.valor) } : x
    }))
    const naoPadrao = leitura.utmsAchadas.filter((u) => !UTMS_PADRAO.some((p) => p.chave === u.chave))
    if (naoPadrao.length) setCustom((c) => (c.length ? c : naoPadrao))
  }, [destinoBase, leitura, editando])

  const todosCriar: NovoDestino[] = useMemo(() => {
    const principal: NovoDestino = { url: leitura.ok ? leitura.base : destinoBase, rotulo: 'principal', peso: 100 }
    return [principal, ...extras]
  }, [leitura, destinoBase, extras])

  const listaAtual = editando ? destinos : todosCriar
  const urlPrincipal = editando ? (destinos.find((d) => d.ativo !== false)?.url ?? '') : destinoBase
  const problemas = useMemo(() => {
    if (editando) {
      const ativos = destinos.filter((d) => d.ativo !== false)
      if (!ativos.length) return [{ onde: 'destinos', msg: 'Deixa pelo menos um destino ligado. Pra tirar do ar, usa Pausar.' }]
      return validar(ativos[0].url, padrao, custom, ativos.slice(1))
    }
    return destinoBase ? validar(destinoBase, padrao, custom, extras) : []
  }, [editando, destinos, destinoBase, padrao, custom, extras])
  const previa = useMemo(() => montarPreview(urlPrincipal, padrao, custom), [urlPrincipal, padrao, custom])
  const soma = listaAtual.reduce((s, d) => s + (d.ativo === false ? 0 : (d.peso > 0 ? d.peso : 0)), 0)
  const slugLimpo = normalizaSlug(slug)
  const slugProblema = problemaDoSlug(slugLimpo)

  function addTag(txt: string) {
    const t = txt.trim().toLowerCase()
    if (!t) return
    if (tags.length >= 10) { toast('No máximo 10 tags por link.', true); return }
    if (!tags.includes(t)) setTags([...tags, t])
    setTagTxt('')
  }

  function montarParams(): NovoParam[] {
    const gerais: NovoParam[] = [...padrao, ...custom]
      .filter((p) => p.chave.trim() && p.valor.trim())
      .map((p, i) => ({ chave: normalizaChave(p.chave), valor: p.valor.trim(), ordem: i }))
    const braco: NovoParam[] = paramsDeBraco.map((p, i) => ({
      chave: p.chave, valor: p.valor, destino_id: p.destino_id, ordem: 100 + i }))
    return [...gerais, ...braco]
  }

  function previewParaEnviar(): Partial<LinkPreview> | null {
    if (preview.modo === 'passthrough' && !preview.titulo && !preview.desc && !preview.img) return null
    return { modo: preview.modo, titulo: preview.titulo || null, desc: preview.desc || null, img: preview.img || null }
  }

  async function salvar() {
    if (ocupado) return
    if (problemas.length) { setErro(problemas[0].msg); return }
    if (!nome.trim()) { setErro('O link precisa de um nome pra você achar depois.'); return }
    if (!editando && slugLimpo && slugProblema) { setErro(slugProblema); return }
    // o banco tambem recusa, mas na criacao a marcacao de anuncio so entra num
    // segundo passo; sem esta trava o link nasceria com card proprio e anunciado
    if (anuncio && preview.modo === 'card_proprio') {
      setErro('Link de anúncio não pode usar card próprio: o robô da Meta veria uma coisa e a pessoa outra (cloaking). Troca a prévia pra "mostra a prévia do destino".')
      return
    }
    setOcupado(true)
    setErro(null)
    try {
      if (!editando) {
        const r = await linksCriar(nome.trim(), todosCriar, montarParams(), divisao, 'hx-geral', {
          merge_query: mergeQuery,
          slug: slugLimpo || null, dominio: slugLimpo ? dominioSlug : null,
          tags, observacao: observacao || null, expira_em: localParaIso(expira),
          preview: previewParaEnviar(),
        })
        let criadoLink = r.link ?? null
        // dois campos que a criacao nao aceita entram logo em seguida pelo editar
        if (criadoLink && (destinoExpirado || anuncio)) {
          const r2 = await linksEditar(criadoLink.id, { destino_expirado: destinoExpirado || null, is_destino_de_anuncio: anuncio })
          if (!r2.ok) toast(`Link criado, mas não consegui salvar o destino de expirado ou a marcação de anúncio: ${r2.erro ?? ''} Abre Editar pra ajustar.`, true)
          else if (r2.link) criadoLink = r2.link
        }
        toast(`Link criado${r.urls_criadas ? ` em ${r.urls_criadas} domínio(s)` : ''}.`)
        if (criadoLink) setCriado(criadoLink)
        else onSalvo(null)
        return
      }

      // editar: manda so o que mudou
      const patch: PatchLink = {}
      if (nome.trim() !== link!.nome) patch.nome = nome.trim()
      if (divisao !== link!.divisao) patch.divisao = divisao
      if (mergeQuery !== link!.merge_query) patch.merge_query = mergeQuery
      if (!iguais(tags, link!.tags)) patch.tags = tags
      if ((observacao || null) !== (link!.observacao || null)) patch.observacao = observacao || null
      if (localParaIso(expira) !== (link!.expira_em ? localParaIso(isoParaLocal(link!.expira_em)) : null)) patch.expira_em = localParaIso(expira)
      if ((destinoExpirado || null) !== (link!.destino_expirado || null)) patch.destino_expirado = destinoExpirado || null
      if (anuncio !== link!.is_destino_de_anuncio) patch.is_destino_de_anuncio = anuncio
      const pv = { modo: preview.modo, titulo: preview.titulo || null, desc: preview.desc || null, img: preview.img || null }
      const pv0 = { modo: link!.preview.modo, titulo: link!.preview.titulo || null, desc: link!.preview.desc || null, img: link!.preview.img || null }
      if (!iguais(pv, pv0)) patch.preview = pv
      const d0 = link!.destinos.map((d) => ({ id: d.id, url: d.url, rotulo: d.rotulo ?? '', peso: d.peso, ativo: d.ativo }))
      if (!iguais(destinos, d0)) patch.destinos = destinos.map((d) => ({ ...d, rotulo: d.rotulo || undefined }))
      const params = montarParams()
      const p0 = paramsIniciais.map((p, i) => ({ chave: p.chave, valor: p.valor, ...(p.destino_id ? { destino_id: p.destino_id } : {}), ordem: p.destino_id ? 100 + i : i }))
      // por conjunto, nao por posicao: a ordem do banco pode divergir da do
      // formulario sem nada ter mudado, e mandar params a toa apaga e reinsere
      const chaveP = (p: { chave: string; valor: string; destino_id?: string | null }) => `${p.chave}|${p.valor}|${p.destino_id ?? ''}`
      if (!iguais([...params.map(chaveP)].sort(), [...p0.map(chaveP)].sort())) patch.params = params

      if (!Object.keys(patch).length) { toast('Nada mudou.'); onFechar(); return }
      const r = await linksEditar(link!.id, patch)
      if (!r.ok) { setErro(r.erro ?? 'Não consegui salvar.'); return }
      if (r.aviso) toast(r.aviso)
      toast('Salvo. ' + (r.propagacao ?? ''))
      onSalvo(r.link ?? null)
    } catch (e) {
      // NÃO limpa o formulário: perder cinco campos de UTM por causa de um
      // erro de rede é inaceitável
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setOcupado(false)
    }
  }

  async function renomear(hostname: string, forcar = false) {
    const s = normalizaSlug(novoSlug[hostname] ?? '')
    const p = problemaDoSlug(s)
    if (!s) return
    if (p) { setErro(p); return }
    setOcupado(true)
    setErro(null)
    try {
      const r = await linksSlug(link!.id, hostname, s, forcar)
      if (!r.ok) {
        if (r.precisa_forcar) { setConfirmar({ msg: r.erro ?? '', acao: () => renomear(hostname, true) }); return }
        setErro(r.erro ?? 'Não consegui renomear.')
        return
      }
      setConfirmar(null)
      toast(r.sem_mudanca ? 'Já era esse slug.' : `Agora responde em ${r.url}. ${r.propagacao ?? ''}`)
      // NAO fecha o editor: quem mexeu em nome, UTMs e tags antes de renomear
      // perderia tudo. So atualiza os enderecos e avisa o pai pra recarregar.
      if (r.link) setUrlsAgora(r.link.urls)
      onMudouUrls?.()
      setNovoSlug({ ...novoSlug, [hostname]: '' })
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setOcupado(false)
    }
  }

  // ---------- criado: mostra as URLs e manda pro detalhe ----------
  if (criado) {
    return (
      <Modal title="Link criado" sub="Cola no grupo, no pop-up ou onde precisar." onClose={() => onSalvo(criado)}>
        {criado.urls.map((u) => (
          <div key={u.url} className="urlbox hero" style={{ marginBottom: 8 }}>
            <code>{u.url.replace(/^https:\/\//, '')}</code>
            <button className="btn sm" onClick={async () => {
              const ok = await navigator.clipboard?.writeText(u.url).then(() => true).catch(() => false)
              toast(ok ? 'Copiado' : 'Toque e segure no endereço pra copiar', !ok)
            }}><Check size={13} />Copiar</button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => onSalvo(criado)}>Ver o detalhe e o QR</button>
        </div>
      </Modal>
    )
  }

  const titulo = editando ? `Editar: ${link!.nome}` : 'Novo link'
  const sub = editando
    ? 'Muda o que precisar. O endereço curto não muda por aqui.'
    : 'Cola o destino, dá um nome, sai uma URL curta.'

  return (
    <Modal title={titulo} sub={sub} onClose={onFechar}>
      {confirmar && (
        <div className="card confirmar" style={{ marginBottom: 14 }}>
          <b>Confirma?</b>
          <p style={{ fontSize: 13, margin: '6px 0 10px' }}>{confirmar.msg}</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => confirmar.acao()} disabled={ocupado}>Sim, forçar</button>
            <button className="btn ghost" onClick={() => setConfirmar(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* ---------- destino ---------- */}
      {!editando && (
        <div className="field">
          <label htmlFor="lk-destino">Para onde este link leva</label>
          <input id="lk-destino" value={destinoBase} placeholder="https://exemplo.com/pagina"
            onChange={(e) => setDestinoBase(e.target.value)} autoFocus />
          {!leitura.ok && destinoBase && (
            <span className="st-falha" role="alert" style={{ fontSize: 12.5 }}>{leitura.erro}</span>
          )}
          {leitura.ok && leitura.utmsAchadas.length > 0 && (
            <span className="mut" style={{ fontSize: 12 }}>
              Esse endereço já vinha com {leitura.utmsAchadas.length} UTM. Puxei pros campos abaixo.
            </span>
          )}
          {leitura.ok && leitura.outrosParams.length > 0 && (
            <span className="mut" style={{ fontSize: 12 }}>
              Tem {leitura.outrosParams.length} parâmetro que não é UTM
              ({leitura.outrosParams.map((p) => p.chave).join(', ')}). Fica intocado.
            </span>
          )}
        </div>
      )}

      <div className="grid2">
        <div className="field">
          <label htmlFor="lk-nome">Nome (pra você achar depois)</label>
          <input id="lk-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="VIP setembro" />
        </div>
        <div className="field">
          <label htmlFor="lk-div">Como dividir entre os destinos</label>
          <select id="lk-div" value={divisao} onChange={(e) => setDivisao(e.target.value as 'clique' | 'pessoa')}>
            <option value="clique">Por clique (rotação de carga)</option>
            <option value="pessoa">Por pessoa (teste A/B)</option>
          </select>
        </div>
      </div>

      <Ajuda titulo="qual das duas divisões usar">
        <b>Por clique</b> sorteia a cada acesso. Serve pra distribuir carga, por exemplo entre
        dois grupos de WhatsApp.<br />
        <b>Por pessoa</b> manda sempre a mesma pessoa pro mesmo destino (pelo cookie de visitante).
        É o que torna um teste A/B honesto: sem isso, quem abre o link duas vezes entra nos dois
        braços e contamina o resultado.
      </Ajuda>

      {/* ---------- destinos com peso ---------- */}
      <div className="grouplbl" style={{ marginTop: 16 }}>DESTINOS E PESO</div>
      {!editando && (
        <div className="urlbox" style={{ marginBottom: 8 }}>
          <code>{leitura.ok ? leitura.base : '(preencha o destino acima)'}</code>
          <span className="mchip">peso 100</span>
          <span className="mchip">{soma > 0 ? pct((100 * 100) / soma) : '·'}</span>
        </div>
      )}
      {(editando ? destinos : extras).map((d, i) => {
        // no editar, `problemas` foi calculado sobre os destinos LIGADOS (ativos.slice(1));
        // o indice da linha na lista completa nao e o mesmo quando ha destino desligado
        const ligados = editando ? destinos.filter((x) => x.ativo !== false) : extras
        const idxProblema = editando ? ligados.indexOf(d) - 1 : i
        const pd = idxProblema >= 0 ? problemas.find((x) => x.onde === `destino-${idxProblema}`) : undefined
        const lista = editando ? destinos : extras
        const setLista = editando ? setDestinos : setExtras
        const desligado = d.ativo === false
        return (
          <div key={d.id ?? i} style={{ marginBottom: 8, opacity: desligado ? 0.55 : 1 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input value={d.url} placeholder="https://outro-destino.com" style={{ flex: '1 1 220px' }}
                disabled={desligado}
                onChange={(e) => setLista(lista.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
              <input value={d.rotulo ?? ''} placeholder="rótulo" style={{ maxWidth: 130 }} disabled={desligado}
                onChange={(e) => setLista(lista.map((x, j) => j === i ? { ...x, rotulo: e.target.value } : x))} />
              <input type="number" min={0} value={d.peso} style={{ maxWidth: 90 }} disabled={desligado}
                aria-label="peso"
                onChange={(e) => setLista(lista.map((x, j) => j === i ? { ...x, peso: Number(e.target.value) } : x))} />
              <span className="mchip">{soma > 0 && !desligado ? pct((d.peso * 100) / soma) : '·'}</span>
              {editando && d.id ? (
                <button className="btn ghost sm" title={desligado ? 'Ligar de novo' : 'Desligar (o histórico de cliques fica)'}
                  onClick={() => setDestinos(destinos.map((x, j) => j === i ? { ...x, ativo: desligado } : x))}>
                  {desligado ? 'ligar' : 'desligar'}
                </button>
              ) : (
                <button className="btn ghost sm" aria-label="Tirar destino" onClick={() => setLista(lista.filter((_, j) => j !== i))}>
                  <X size={13} />
                </button>
              )}
            </div>
            {pd && <span className="st-falha" role="alert" style={{ fontSize: 12.5 }}>{pd.msg}</span>}
          </div>
        )
      })}
      <button className="btn ghost sm"
        onClick={() => editando
          ? setDestinos([...destinos, { url: '', rotulo: '', peso: 50, ativo: true }])
          : setExtras([...extras, { url: '', rotulo: '', peso: 50 }])}>
        <Plus size={13} />Adicionar destino
      </button>

      <Ajuda titulo="como o peso funciona">
        O peso é relativo: não precisa somar 100. Se você põe 3 e 1, o primeiro leva 75% e o
        segundo 25%. Peso 0 ou destino desligado sai do sorteio sem apagar, então o histórico de
        cliques dele continua no relatório.<br />
        Sorteio tem variação natural: com 50/50 e 100 cliques, ver 54 e 46 é o esperado. O
        detalhe do link mostra a margem esperada ao lado do número.
      </Ajuda>

      {/* ---------- UTMs ---------- */}
      <div className="grouplbl" style={{ marginTop: 16 }}>AS 5 DE SEMPRE</div>
      <div className="grid2">
        {UTMS_PADRAO.map((u, i) => (
          <div className="field" key={u.chave}>
            <label htmlFor={'utm-' + u.chave}>{u.rotulo} <span className="mut">({u.chave})</span></label>
            <input id={'utm-' + u.chave} value={padrao[i].valor} placeholder={u.dica}
              onChange={(e) => setPadrao(padrao.map((p, j) =>
                j === i ? { ...p, valor: normalizaValor(e.target.value) } : p))} />
          </div>
        ))}
      </div>
      <p className="mut" style={{ fontSize: 12 }}>
        Acento, espaço e maiúscula somem enquanto você digita. É de propósito: o Google Analytics
        conta "Black Friday" e "black-friday" como duas campanhas diferentes.
      </p>

      <div className="grouplbl" style={{ marginTop: 14 }}>AS SUAS PRÓPRIAS</div>
      {custom.map((c, i) => {
        const p = problemas.find((x) => x.onde === `custom-${i}`)
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <input value={c.chave} placeholder="sck" style={{ maxWidth: 180 }}
                onChange={(e) => setCustom(custom.map((x, j) => j === i ? { ...x, chave: normalizaChave(e.target.value) } : x))} />
              <input value={c.valor} placeholder="valor"
                onChange={(e) => setCustom(custom.map((x, j) => j === i ? { ...x, valor: normalizaValor(e.target.value) } : x))} />
              <button className="btn ghost sm" aria-label="Tirar parâmetro" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>
                <X size={13} />
              </button>
            </div>
            {p && <span className="st-falha" role="alert" style={{ fontSize: 12.5 }}>{p.msg}</span>}
          </div>
        )
      })}
      <button className="btn ghost sm" onClick={() => setCustom([...custom, { chave: '', valor: '' }])}>
        <Plus size={13} />Adicionar parâmetro
      </button>
      {paramsDeBraco.length > 0 && (
        <p className="mut" style={{ fontSize: 12, marginTop: 8 }}>
          Este link tem {paramsDeBraco.length} parâmetro amarrado a um braço específico; eles ficam como estão.
        </p>
      )}

      {previa && (
        <>
          <div className="grouplbl" style={{ marginTop: 16 }}>PARA ONDE LEVA DE VERDADE</div>
          <div className="urlbox"><code>{previa}</code></div>
          <p className="mut" style={{ fontSize: 12, marginTop: 8 }}>
            O que você cola sai curto. Isto aqui fica escondido atrás dele: quem clica não vê nada disso.
          </p>
        </>
      )}

      {/* ---------- endereco curto ---------- */}
      <div className="grouplbl" style={{ marginTop: 18 }}>ENDEREÇO CURTO</div>
      {!editando ? (
        <div className="grid2">
          <div className="field">
            <label htmlFor="lk-slug">Slug personalizado <span className="mut">(opcional)</span></label>
            <input id="lk-slug" value={slug} placeholder="deixa vazio pra sair aleatório (abc123)"
              onChange={(e) => setSlug(e.target.value)} onBlur={() => setSlug(slugLimpo)} />
            {slugLimpo && slugProblema && <span className="st-falha" style={{ fontSize: 12.5 }}>{slugProblema}</span>}
            {slugLimpo && !slugProblema && dominioSlug && (
              <span className="mut" style={{ fontSize: 12 }}>Vai ficar <code>{dominioSlug}/{slugLimpo}</code></span>
            )}
          </div>
          <div className="field">
            <label htmlFor="lk-dom">No domínio</label>
            <select id="lk-dom" value={dominioSlug} onChange={(e) => setDominioSlug(e.target.value)} disabled={!slugLimpo}>
              {dominiosAtivos.map((d) => (
                <option key={d.hostname} value={d.hostname}>{d.hostname}{!d.no_rodizio ? ' (institucional)' : ''}</option>
              ))}
            </select>
            <span className="mut" style={{ fontSize: 12 }}>Os outros domínios ativos ganham um slug aleatório.</span>
          </div>
        </div>
      ) : (
        <>
          {urlsAgora.map((u) => (
            <div key={u.dominio} style={{ marginBottom: 10 }}>
              <div className="urlbox">
                <code>{u.dominio}/{u.slug}</code>
                {u.protegida && <span className="badge b-rascunho"><Lock size={11} />em produção</span>}
                {u.ativa === false && <span className="badge b-erro">inativa</span>}
              </div>
              {u.protegida ? (
                <p className="mut" style={{ fontSize: 12, margin: '6px 0 0' }}>
                  Esse endereço está colado fora do Send (pop-up, material). O slug não muda; se precisar
                  de outro endereço, cria um link novo.
                </p>
              ) : (
                <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <input value={novoSlug[u.dominio] ?? ''} placeholder="novo slug" style={{ maxWidth: 240 }}
                    aria-label={`Novo slug em ${u.dominio}`}
                    onChange={(e) => setNovoSlug({ ...novoSlug, [u.dominio]: e.target.value })} />
                  <button className="btn ghost sm" disabled={ocupado || !normalizaSlug(novoSlug[u.dominio] ?? '')}
                    onClick={() => renomear(u.dominio)}>Renomear</button>
                  <span className="mut" style={{ fontSize: 12 }}>
                    Quem já tem o endereço antigo perde o link. Com clique registrado, eu peço confirmação.
                  </span>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {/* ---------- avancado ---------- */}
      <details className="ajuda" style={{ marginTop: 14 }}>
        <summary>tags, observação, expiração, preview e query</summary>
        <div style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="lk-tags">Tags <span className="mut">(pra filtrar a lista; até 10)</span></label>
            <div className="taginput">
              {tags.map((t) => (
                <span className="tagchip" key={t}>{t}
                  <button aria-label={`tirar ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><X size={11} /></button>
                </span>
              ))}
              <input id="lk-tags" value={tagTxt} placeholder="digita e dá Enter" list="lk-tags-sug"
                onChange={(e) => setTagTxt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagTxt) } }}
                onBlur={() => addTag(tagTxt)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="lk-obs">Observação <span className="mut">(pra quem abrir isso daqui a seis meses)</span></label>
            <textarea id="lk-obs" value={observacao} onChange={(e) => setObservacao(e.target.value)}
              placeholder="Onde esse link está colado, quem pediu, quando pode sair do ar." />
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="lk-exp">Expira em <span className="mut">(horário de Brasília; vazio = nunca)</span></label>
              <input id="lk-exp" type="datetime-local" value={expira} onChange={(e) => setExpira(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="lk-expd">Depois de expirar ou pausar, manda pra</label>
              <input id="lk-expd" value={destinoExpirado} placeholder="https://... (vazio = página do domínio)"
                onChange={(e) => setDestinoExpirado(e.target.value)} />
            </div>
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="lk-prev">Prévia do link (o card que o WhatsApp e a Meta mostram)</label>
              <select id="lk-prev" value={preview.modo}
                onChange={(e) => setPreview({ ...preview, modo: e.target.value as LinkPreview['modo'] })}>
                <option value="passthrough">Mostra a prévia do destino (padrão)</option>
                <option value="card_proprio">Card próprio (título, descrição e imagem abaixo)</option>
                <option value="bloquear">Sem prévia (o robô recebe vazio)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="lk-anuncio">Esse link é destino de anúncio?</label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                <input id="lk-anuncio" type="checkbox" checked={anuncio} onChange={(e) => setAnuncio(e.target.checked)} />
                <span className="mut" style={{ fontSize: 12.5 }}>Sim, roda em Meta ou Google Ads</span>
              </label>
              {anuncio && preview.modo === 'card_proprio' && (
                <span className="st-falha" style={{ fontSize: 12.5 }}>
                  Anúncio com card próprio é cloaking (o robô da Meta vê uma coisa e a pessoa outra) e derruba a conta. Troca a prévia.
                </span>
              )}
            </div>
          </div>
          {preview.modo === 'card_proprio' && (
            <>
              <div className="grid2">
                <div className="field">
                  <label htmlFor="lk-pt">Título do card</label>
                  <input id="lk-pt" value={preview.titulo ?? ''} onChange={(e) => setPreview({ ...preview, titulo: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="lk-pi">Imagem (https)</label>
                  <input id="lk-pi" value={preview.img ?? ''} placeholder="https://cdn.hx-corp.com/..." onChange={(e) => setPreview({ ...preview, img: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="lk-pd">Descrição</label>
                <input id="lk-pd" value={preview.desc ?? ''} onChange={(e) => setPreview({ ...preview, desc: e.target.value })} />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="lk-mq">O que fazer com parâmetros que vierem colados no link curto</label>
            <select id="lk-mq" value={mergeQuery} onChange={(e) => setMergeQuery(e.target.value as typeof mergeQuery)}>
              <option value="append">Repassa pro destino (padrão: fbclid, gclid, tudo)</option>
              <option value="ignorar">Ignora tudo que vier colado</option>
              <option value="whitelist">Só os da lista (configurada no banco)</option>
            </select>
          </div>
        </div>
      </details>

      {erro && <p className="st-falha" role="alert" style={{ fontSize: 13, marginTop: 12 }}>{erro}</p>}
      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <button className="btn" onClick={salvar}
          disabled={ocupado || problemas.length > 0 || !nome.trim() || (!editando && !leitura.ok)}>
          {ocupado ? <i className="spin" /> : <Save size={15} />}
          {ocupado ? 'Salvando...' : editando ? 'Salvar' : 'Criar link'}
        </button>
        <button className="btn ghost" onClick={onFechar}>Cancelar</button>
      </div>
    </Modal>
  )
}
