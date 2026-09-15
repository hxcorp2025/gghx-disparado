import { useCallback, useEffect, useRef, useState } from 'react'
import { Link2, Plus, RefreshCw, ChevronRight, Send, Lock, Copy, X } from 'lucide-react'
import {
  linksListar, linksTags, linksEspiar, linksProxima,
  type LinkItem, type LinkDominiosPainel, type LinkProxima, type OrdemLista, type LinkEstado,
} from '../../lib/linksDb'
import { Empty } from '../../components/Empty'
import { SkeletonList } from '../../components/Skeleton'
import { toast } from '../../lib/toast'
import { n, quando, Ajuda, ESTADO_LINK, Sparkline, UrlCurta, copiarTexto } from './comum'
import { Editor } from './Editor'

type Props = { doms: LinkDominiosPainel | null; onAbrir: (id: string) => void }

// o que lnk_proxima_url devolve em `criterio`, traduzido pra frase de operador
const CRITERIO: Record<string, string> = {
  'raiz global mais parada': 'ficou mais tempo parado',
  'fora do rodizio': 'fora do rodízio',
  'url informada pelo painel': 'a que você copiou',
}

const ESTADOS: { id: LinkEstado | null; txt: string }[] = [
  { id: null, txt: 'Todos' },
  { id: 'ativo', txt: 'No ar' },
  { id: 'pausado', txt: 'Pausados' },
  { id: 'congelado', txt: 'Congelados' },
  { id: 'expirado', txt: 'Expirados' },
]

// =====================================================================
// "Copiar pra disparo" na linha: a URL do rodizio.
// Copia PRIMEIRO e so entao marca a entrega. Marcar antes queimava o
// dominio mesmo quando a copia falhava, corrompendo o "ficou mais tempo
// parado" (o mecanismo anti-ban) e inflando `entregas`, que e o alarme de
// dominio bloqueado. Se a copia falhar, a URL fica VISIVEL na linha pra
// pessoa tocar e segurar, e o rodizio so avanca quando ela confirmar.
// =====================================================================
function CopiarParaDisparo({ link }: { link: LinkItem }) {
  const [espiada, setEspiada] = useState<LinkProxima | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [naMao, setNaMao] = useState(false)
  const campo = useRef<HTMLInputElement>(null)

  async function espiar() {
    if (ocupado) return
    setOcupado(true)
    try {
      const r = await linksEspiar(link.id)
      if (!r.ok) { toast(r.erro ?? 'Não consegui ver a próxima URL.', true); return }
      setEspiada(r)
      setNaMao(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function marcar(r: LinkProxima, copiou: boolean) {
    // esperado + url_id: o banco avisa se outro operador andou com o rodizio no
    // meio e marca exatamente a URL que foi copiada
    const m = await linksProxima(link.id, r.dominio, r.url_id)
    if (m.url !== r.url) {
      // nao deveria acontecer com url_id, mas se a URL foi desativada entre a
      // espiada e o toque, o operador precisa saber que saiu OUTRO endereco
      toast(`Atenção: o banco marcou ${m.dominio}, não o endereço que você copiou. Copia de novo: ${m.url}`, true)
    } else {
      toast(m.aviso ?? `${copiou ? 'Copiado. ' : ''}Entrega marcada em ${m.dominio}.`)
    }
    setEspiada(null)
    setNaMao(false)
  }

  async function copiarEMarcar() {
    if (!espiada || ocupado) return
    setOcupado(true)
    try {
      const copiou = await copiarTexto(espiada.url, campo.current)
      if (!copiou) {
        setNaMao(true)
        toast('Não consegui copiar. Toque e segure no endereço abaixo.', true)
        return
      }
      await marcar(espiada, true)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  if (!espiada) {
    return (
      <button className="btn ghost sm" onClick={espiar} disabled={ocupado}
        title="Mostra a URL do próximo domínio do rodízio; a entrega só é marcada depois de copiar">
        {ocupado ? <i className="spin" /> : <Send size={13} />}Copiar pra disparo
      </button>
    )
  }
  return (
    <div className="lk-rodizio">
      <div className="urlbox">
        <code>{espiada.url.replace(/^https:\/\//, '')}</code>
        <button className="btn sm" onClick={copiarEMarcar} disabled={ocupado}>
          {ocupado ? <i className="spin" /> : <Copy size={13} />}Copiar e marcar entrega
        </button>
        <button className="btn ghost sm" onClick={() => setEspiada(null)} aria-label="Fechar"><X size={13} /></button>
      </div>
      <input ref={campo} readOnly aria-hidden="true" tabIndex={-1} className="lk-campo-copia" />
      <p className="mut" style={{ fontSize: 12, margin: '6px 0 0' }}>
        {espiada.fora_do_rodizio
          ? 'Não há domínio no rodízio: esta é uma URL ativa, mas não serve pra disparo em massa.'
          : `${espiada.dominio} (${CRITERIO[espiada.criterio] ?? `usado ${quando(espiada.ultimo_uso)}`}). O rodízio só avança depois que você copiar.`}
      </p>
      {naMao && (
        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <span className="st-falha" style={{ fontSize: 12.5 }}>Toque e segure no endereço pra copiar.</span>
          <button className="btn ghost sm" disabled={ocupado} onClick={async () => {
            setOcupado(true)
            try { await marcar(espiada, false) } catch (e) { toast(e instanceof Error ? e.message : 'Falhou', true) } finally { setOcupado(false) }
          }}>Já copiei, pode avançar o rodízio</button>
        </div>
      )}
    </div>
  )
}

// =====================================================================
// A lista e a tela principal: URL curta, copiar, QR e os cliques de gente
// dos ultimos 7 dias em cada linha. O rodizio de dominio so aparece como
// acao na linha quando ha 2+ raizes, porque com uma so nao existe rodizio.
// =====================================================================
export function Lista({ doms, onAbrir }: Props) {
  const [links, setLinks] = useState<LinkItem[] | null>(null)
  const [tags, setTags] = useState<{ tag: string; n: number }[]>([])
  const [busca, setBusca] = useState('')
  const [buscaLenta, setBuscaLenta] = useState('')
  const [ordem, setOrdem] = useState<OrdemLista>('recentes')
  const [estado, setEstado] = useState<LinkEstado | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [novo, setNovo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)
  // guarda de corrida: a resposta mais lenta nunca sobrescreve a mais nova
  const seq = useRef(0)

  // a busca bate no banco (acha por nome, slug, destino e tag), entao espera
  // a pessoa parar de digitar em vez de disparar uma RPC por tecla
  useEffect(() => {
    const t = setTimeout(() => setBuscaLenta(busca), 250)
    return () => clearTimeout(t)
  }, [busca])

  const carregar = useCallback(async () => {
    const meu = ++seq.current
    setCarregando(true)
    try {
      const [l, t] = await Promise.all([
        linksListar(buscaLenta, null, 100, ordem, tag, estado),
        linksTags(),
      ])
      if (meu !== seq.current) return
      setLinks(l ?? [])
      setTags(t ?? [])
      setErro(null)
    } catch (e) {
      if (meu !== seq.current) return
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      if (meu === seq.current) setCarregando(false)
    }
  }, [buscaLenta, ordem, tag, estado])

  useEffect(() => { carregar() }, [carregar])

  // Decisao do PRD (15/09): o rodizio so protagoniza com 2+ raizes distintas.
  const rodizio = (doms?.resumo.raizes ?? 0) >= 2
  const semDominio = !!doms && doms.resumo.ativos === 0
  const filtrando = !!buscaLenta || estado !== null || tag !== null

  return (
    <>
      {novo && (
        <Editor modo="criar" doms={doms} onFechar={() => setNovo(false)}
          onSalvo={(link) => { setNovo(false); carregar(); if (link) onAbrir(link.id) }} />
      )}

      <div className="toolbar between">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="count-pill"><b>{n(links?.length ?? 0)}</b> links</span>
          <input className="search" value={busca} placeholder="buscar por nome, slug, destino ou tag"
            aria-label="Buscar links" onChange={(e) => setBusca(e.target.value)} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select value={ordem} aria-label="Ordenar" onChange={(e) => setOrdem(e.target.value as OrdemLista)}>
            <option value="recentes">Mais recentes</option>
            <option value="cliques">Mais cliques (7d)</option>
            <option value="ultimo">Último clique</option>
            <option value="nome">Nome</option>
          </select>
          <button className="btn" onClick={() => setNovo(true)} disabled={semDominio}
            title={semDominio ? 'Cadastra um domínio antes' : undefined}>
            <Plus size={15} />Novo link
          </button>
        </div>
      </div>

      <div className="filtros" style={{ marginBottom: 14 }}>
        {ESTADOS.map((e) => (
          <button key={e.txt} className={'chip' + (estado === e.id ? ' on' : '')}
            aria-pressed={estado === e.id} onClick={() => setEstado(e.id)}>{e.txt}</button>
        ))}
        {tags.length > 0 && (
          <>
            <span className="mut" style={{ fontSize: 12, marginLeft: 6 }}>tag:</span>
            {tags.map((t) => (
              <button key={t.tag} className={'chip' + (tag === t.tag ? ' on' : '')}
                aria-pressed={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)}>
                {t.tag} <span className="mut">{t.n}</span>
              </button>
            ))}
          </>
        )}
      </div>

      {erro && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--red)' }}>
          <b>Não consegui carregar</b>
          <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>{erro}</p>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={carregar}>
            <RefreshCw size={13} />Tentar de novo
          </button>
        </div>
      )}

      {carregando && !links && <SkeletonList rows={4} height={92} />}

      {links && links.length === 0 && !novo && (
        filtrando
          ? <Empty Icon={Link2} title="Nenhum link com esse filtro" sub="Limpa a busca ou os filtros pra ver todos." />
          : <Empty Icon={Link2} title="Nenhum link ainda"
              sub="Crie o primeiro: cola o destino, dá um nome e sai uma URL curta com QR." />
      )}

      {links?.map((l) => {
        const est = ESTADO_LINK[l.estado] ?? ESTADO_LINK.ativo
        // destino desligado nao esta no ar: nao conta como "N destinos" nem como braco
        const ativos = (l.destinos ?? []).filter((d) => d.ativo)
        return (
          <div className="lk-row" key={l.id}>
            <button className="lk-main" onClick={() => onAbrir(l.id)} aria-label={`Abrir ${l.nome}`}>
              <div className="lk-title">
                <b>{l.nome}</b>
                <span className={'badge ' + est.cls}>{est.txt}</span>
                {l.protegido && (
                  <span className="badge b-rascunho" title="Esse endereço está colado em produção fora do Send: o slug não muda e pausar pede confirmação.">
                    <Lock size={11} />em produção
                  </span>
                )}
                {l.sem_braco && ativos.length > 1 && <span className="badge b-erro">sem braço</span>}
              </div>
              {l.tags.length > 0 && (
                <div className="lk-tags">{l.tags.map((t) => <span className="tagchip off" key={t}>{t}</span>)}</div>
              )}
              <div className="lk-meta">
                {ativos.length > 1
                  ? `${ativos.length} destinos, ${l.divisao === 'pessoa' ? 'por pessoa' : 'por clique'}`
                  : ativos.length === 1
                    ? ativos[0].url.replace(/^https?:\/\//, '').slice(0, 60)
                    : 'nenhum destino no ar'}
                {' · '}último clique {quando(l.ultimo_clique)}
                {l.expira_em && ` · expira ${quando(l.expira_em).replace('há', 'em')}`}
              </div>
            </button>

            <div className="lk-url"><UrlCurta url={l.url_curta} nome={l.nome} /></div>

            <div className="lk-stats">
              <Sparkline pontos={l.sparkline_7d} />
              <div className="lk-num"><b>{n(l.cliques_7d)}</b><span>cliques 7d</span></div>
              <div className="lk-num"><b>{n(l.cliques_hoje)}</b><span>hoje</span></div>
              {l.pessoas_7d != null && <div className="lk-num"><b>{n(l.pessoas_7d)}</b><span>pessoas 7d</span></div>}
            </div>

            <div className="lk-acoes">
              {rodizio && <CopiarParaDisparo link={l} />}
              <button className="btn ghost sm" onClick={() => onAbrir(l.id)}>
                Abrir<ChevronRight size={14} />
              </button>
            </div>
          </div>
        )
      })}

      {links && links.length > 0 && (
        <Ajuda titulo="o que cada número da linha quer dizer">
          <b>Cliques 7d</b> conta só gente, com o link no ar: o robô que o WhatsApp manda pra montar
          a prévia não entra, e acesso em link pausado ou expirado também não. <b>Hoje</b> é o mesmo
          número desde a meia-noite de Brasília. A linha pequena é o desenho dos 7 dias, do mais
          antigo (esquerda) até hoje.<br />
          <b>Pessoas 7d</b> só aparece quando o link tem cookie de visitante; enquanto não tem, a
          coluna fica de fora em vez de mostrar zero.<br />
          <b>Em produção</b> marca um endereço que está colado fora do Send (pop-up, material). Ele não
          muda de slug, e pausar pede uma confirmação a mais.
        </Ajuda>
      )}
    </>
  )
}
