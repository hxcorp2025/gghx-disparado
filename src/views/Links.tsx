import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Link2, Globe, MousePointerClick, Copy, Check, Plus, X, RefreshCw, AlertTriangle,
} from 'lucide-react'
import {
  linksDominios, linksListar, linksCliques, linksEspiar, linksProxima, linksCriar,
  linksDominioCadastrar, linksDominioEstado, linksDominioReverificar, raizDe,
  type LinkDominiosPainel, type LinkItem, type LinkCliques, type LinkProxima,
  type DominioEstado, type NovoDestino, type NovoParam,
} from '../lib/linksDb'
import {
  UTMS_PADRAO, lerDestino, montarPreview, normalizaValor, normalizaChave, validar,
  type ParDeUtm,
} from '../lib/utm'
import { Empty } from '../components/Empty'
import { SkeletonList, SkeletonCards } from '../components/Skeleton'
import { toast } from '../lib/toast'

type Secao = 'links' | 'dominios' | 'cliques'

const n = (x: number | null | undefined) => (x ?? 0).toLocaleString('pt-BR')
const pct = (x: number | null | undefined) => (x == null ? '·' : x.toFixed(1).replace('.', ',') + '%')

function quando(iso: string | null): string {
  if (!iso) return 'nunca'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  return `há ${Math.floor(s / 86400)} d`
}

function Ajuda({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  // <p> e nao <div>: o CSS estiliza `.ajuda p`, entao com div o bloco
  // renderiza sem cor apagada, sem a barra lateral e colado no summary
  return (
    <details className="ajuda">
      <summary>{titulo}</summary>
      <p>{children}</p>
    </details>
  )
}

/**
 * Copiar de um jeito que funcione no navegador in-app, que e onde o Peterson
 * opera. `navigator.clipboard` e undefined fora de contexto seguro e lanca
 * TypeError sincrono; sem o fallback, a tela dizia "Copiado" sobre uma area
 * de transferencia vazia.
 */
async function copiarTexto(texto: string, campo?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto)
      return true
    }
  } catch { /* cai no fallback */ }
  if (campo) {
    try {
      campo.value = texto
      campo.removeAttribute('aria-hidden')
      campo.focus()
      campo.select()
      campo.setSelectionRange(0, 99999)
      return document.execCommand('copy')
    } catch { /* nem isso */ }
  }
  return false
}

const BADGE: Record<DominioEstado, { txt: string; cls: string }> = {
  pendente:    { txt: 'preparando',            cls: 'b-rascunho' },
  // o nome diz de quem é a vez: o sistema já fez a parte dele
  verificando: { txt: 'esperando você apontar', cls: 'b-agendado' },
  ativo:       { txt: 'ativo',               cls: 'b-concluida' },
  pausado:     { txt: 'fora do rodízio',     cls: 'b-rascunho' },
  suspeito:    { txt: 'suspeito',            cls: 'b-agendado' },
  banido:      { txt: 'banido',              cls: 'b-erro' },
  removido:    { txt: 'removido',            cls: 'b-rascunho' },
}

// =====================================================================
// A próxima do rodízio: a interação mais importante da tela.
// O operador não escolhe o domínio. Escolher é pensar, pensar é enviesar,
// e enviesar significa voltar a usar sempre os mesmos.
// =====================================================================
function ProximaUrl({ links }: { links: LinkItem[] }) {
  const [linkId, setLinkId] = useState<string>('')
  const [espiada, setEspiada] = useState<LinkProxima | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [copiado, setCopiado] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  // quando nem o clipboard nem o execCommand funcionam (webview do iOS costuma
  // barrar), a URL aparece VISÍVEL pra pessoa tocar e segurar. "Dá Ctrl+C" não
  // existe em celular, que é onde o operador vive.
  const [naMao, setNaMao] = useState<{ url: string; motivo: 'falhou' | 'trocou' } | null>(null)
  const campo = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!linkId && links.length) setLinkId(links[0].id)
  }, [links, linkId])

  // Trocar de link duas vezes rápido deixava duas espiadas em voo e a mais
  // lenta vencia, mostrando a URL do link ERRADO. E o estado antigo ficava na
  // tela até a nova resposta chegar. Mostrar uma URL velha como se fosse a
  // próxima é a pior falha possível aqui, porque ela vai para 101 grupos.
  useEffect(() => {
    if (!linkId) return
    let vivo = true
    setEspiada(null); setErro(null); setCopiado(false); setNaMao(null)
    linksEspiar(linkId)
      .then((r) => {
        if (!vivo) return
        if (!r.ok) setErro(r.erro ?? 'Não consegui ver a próxima URL.')
        else setEspiada(r)
      })
      .catch((e) => { if (vivo) setErro(e instanceof Error ? e.message : 'Falhou') })
    return () => { vivo = false }
  }, [linkId])

  // limpa o timer do "Copiado" quando o componente sai
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Registra a entrega da URL que foi COPIADA (url_id), não da que o banco
  // escolheria de novo meio segundo depois: sob dois operadores em paralelo,
  // os dois clipboards recebem a mesma URL e o banco marcaria domínios
  // diferentes, corrompendo o histórico que o rodízio usa para decidir.
  async function marcarEntrega(urlId: string, dominio: string, urlCopiada: string) {
    const r = await linksProxima(linkId, dominio, urlId)
    if (timer.current) clearTimeout(timer.current)
    setCopiado(true)
    timer.current = setTimeout(() => setCopiado(false), 2200)
    if (r.mudou || r.url !== urlCopiada) {
      const ok2 = await copiarTexto(r.url, campo.current)
      setNaMao({ url: r.url, motivo: ok2 ? 'trocou' : 'falhou' })
      if (!ok2) setCopiado(false)
      toast(`Saiu outro domínio no rodízio. Confere: ${r.dominio}`)
    } else {
      setNaMao(null)
      toast('Copiado. O próximo disparo sai em outro domínio.')
    }
    const nova = await linksEspiar(linkId)
    setEspiada(nova.ok ? nova : null)
  }

  // o operador copiou à mão pelo bloco visível; sem isto o rodízio não anda
  async function confirmarManual() {
    if (ocupado || !espiada?.ok || !naMao) return
    setOcupado(true)
    try {
      await marcarEntrega(espiada.url_id, espiada.dominio, naMao.url)
      setNaMao(null)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setOcupado(false)
    }
  }

  async function copiar() {
    if (ocupado || !linkId || !espiada?.ok) return
    setOcupado(true)
    setErro(null)
    setNaMao(null)
    try {
      // Copia PRIMEIRO e só então marca a entrega. Marcar antes queimava o
      // domínio mesmo quando a cópia falhava ou o operador clicava duas vezes,
      // corrompendo o "ficou mais tempo parado" que é o mecanismo anti-ban e
      // inflando `entregas`, que é o alarme de domínio bloqueado.
      const copiou = await copiarTexto(espiada.url, campo.current)
      if (!copiou) {
        // NÃO marca aqui: a pessoa ainda não copiou nada. Mas também não pode
        // ficar assim em silêncio, senão a mesma URL volta a ser "a que ficou
        // mais tempo parada" e o operador dispara o mesmo domínio de novo, que
        // é exatamente o que derrubou as comunidades em agosto. Por isso o
        // botão de confirmação aparece logo abaixo.
        setNaMao({ url: espiada.url, motivo: 'falhou' })
        return
      }
      await marcarEntrega(espiada.url_id, espiada.dominio, espiada.url)
    } catch (e) {
      setEspiada(null)
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setOcupado(false)
    }
  }

  if (!links.length) return null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <b style={{ fontSize: 15 }}>A próxima do rodízio</b>
        <select value={linkId} onChange={(e) => setLinkId(e.target.value)} style={{ maxWidth: 320 }}>
          {links.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
        </select>
      </div>

      {espiada && espiada.ok ? (
        <>
          <div className="urlbox hero">
            <code>{espiada.url}</code>
            <button className="btn" onClick={copiar} disabled={ocupado}>
              {copiado ? <Check size={15} /> : <Copy size={15} />}
              {copiado ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <div className="dispmeta" style={{ marginTop: 10, marginBottom: 0 }}>
            <span className="mchip">{espiada.raizes_ativas} de {espiada.minimo} domínios no rodízio</span>
            <span className="mchip">este ficou parado {quando(espiada.ultimo_uso)}</span>
            {espiada.fora_do_rodizio && (
              <span className="badge b-agendado">fora do rodízio</span>
            )}
          </div>
          {espiada.aviso && (
            <p className="mut" style={{ fontSize: 12.5, marginTop: 8 }}>{espiada.aviso}</p>
          )}
        </>
      ) : (
        !erro && <SkeletonCards n={1} />
      )}

      {naMao && (
        <div style={{ marginTop: 10 }}>
          <p className="mut" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
            {naMao.motivo === 'falhou'
              ? 'Seu navegador não deixou copiar sozinho. Toque e segure no endereço abaixo pra copiar.'
              : 'Este é o endereço que ficou na área de transferência. Confere antes de colar.'}
          </p>
          <div className="urlbox"><code>{naMao.url}</code></div>
          {naMao.motivo === 'falhou' && (
            <>
              <button className="btn sm" style={{ marginTop: 8 }} disabled={ocupado}
                onClick={confirmarManual}>
                Já copiei, pode avançar o rodízio
              </button>
              <p className="mut" style={{ fontSize: 12, marginTop: 6 }}>
                Enquanto você não confirmar, o rodízio fica parado neste domínio. Sem isso, o
                próximo disparo sairia no mesmo endereço.
              </p>
            </>
          )}
        </div>
      )}

      {erro && (
        <div className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
          <AlertTriangle size={16} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }} />
          <span className="st-falha" role="alert" style={{ fontSize: 13 }}>{erro}</span>
        </div>
      )}
      {/* campo do execCommand: fica fora da vista, mas o fallback de verdade
          é o bloco visível acima, porque input escondido não é tocável */}
      <input ref={campo} readOnly className="search"
        style={{ position: 'absolute', left: -9999, width: 1, height: 1 }}
        tabIndex={-1} aria-hidden="true" />

      <Ajuda titulo="como funciona">
        Cada vez que você copia, sai um domínio diferente, sempre o que ficou mais tempo parado.
        A conta é por domínio raiz, não por endereço: dois endereços do mesmo domínio contam
        como um só para quem bloqueia, então alternar entre eles não seria rodízio nenhum.
        Foi repetir sempre os mesmos que derrubou as comunidades em agosto.
      </Ajuda>
    </div>
  )
}

// =====================================================================
// Novo link: construtor de UTM + destinos com peso
// =====================================================================
function NovoLink({ aoCriar, aoFechar }: { aoCriar: () => void; aoFechar: () => void }) {
  const [destinoBase, setDestinoBase] = useState('')
  const [nome, setNome] = useState('')
  const [divisao, setDivisao] = useState<'clique' | 'pessoa'>('clique')
  const [padrao, setPadrao] = useState<ParDeUtm[]>(UTMS_PADRAO.map((u) => ({ chave: u.chave, valor: '' })))
  const [custom, setCustom] = useState<ParDeUtm[]>([])
  const [extras, setExtras] = useState<NovoDestino[]>([])
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [criado, setCriado] = useState<{ url: string; dominio: string }[] | null>(null)

  const leitura = useMemo(() => lerDestino(destinoBase), [destinoBase])
  const problemas = useMemo(
    () => (destinoBase ? validar(destinoBase, padrao, custom, extras) : []),
    [destinoBase, padrao, custom, extras])
  const previa = useMemo(
    () => montarPreview(destinoBase, padrao, custom),
    [destinoBase, padrao, custom])

  // sobe pros campos as UTMs que já vinham coladas no destino
  useEffect(() => {
    if (!leitura.ok || !leitura.utmsAchadas.length) return
    setPadrao((p) => p.map((x) => {
      const achou = leitura.utmsAchadas.find((u) => u.chave === x.chave)
      return achou && !x.valor ? { ...x, valor: normalizaValor(achou.valor) } : x
    }))
    const naoPadrao = leitura.utmsAchadas.filter(
      (u) => !UTMS_PADRAO.some((p) => p.chave === u.chave))
    if (naoPadrao.length) setCustom((c) => (c.length ? c : naoPadrao))
    // Depende de destinoBase, NAO de leitura.base. `base` e o destino SEM as
    // UTMs, entao trocar ?utm_campaign=vip por ?utm_campaign=black-friday dava
    // a mesma base, o efeito nao rodava, e o operador disparava a campanha
    // velha pra 30 mil pessoas com o campo antigo na tela.
  }, [destinoBase, leitura])

  const todos: NovoDestino[] = useMemo(() => {
    const principal: NovoDestino = { url: leitura.ok ? leitura.base : destinoBase, rotulo: 'principal', peso: 100 }
    return [principal, ...extras]
  }, [leitura, destinoBase, extras])

  const soma = todos.reduce((s, d) => s + (d.peso > 0 ? d.peso : 0), 0)

  async function criar() {
    if (ocupado) return
    if (problemas.length) { setErro(problemas[0].msg); return }
    if (!nome.trim()) { setErro('O link precisa de um nome pra você achar depois.'); return }
    setOcupado(true)
    setErro(null)
    try {
      const params: NovoParam[] = [...padrao, ...custom]
        .filter((p) => p.chave.trim() && p.valor.trim())
        .map((p, i) => ({ chave: normalizaChave(p.chave), valor: p.valor.trim(), ordem: i }))
      const r = await linksCriar(nome.trim(), todos, params, divisao)
      setCriado((r.urls ?? []).map((u) => ({ url: u.url, dominio: u.dominio })))
      toast(`Link criado em ${r.urls_criadas ?? 0} domínio(s).`)
      aoCriar()
    } catch (e) {
      // NÃO limpa o formulário: perder cinco campos de UTM por causa de um
      // erro de rede é inaceitável
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setOcupado(false)
    }
  }

  if (criado) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <b>Link criado em {criado.length} domínio(s)</b>
          <button className="btn ghost sm" onClick={aoFechar}><X size={14} />Fechar</button>
        </div>
        {criado.map((u) => (
          <div key={u.url} className="urlbox" style={{ marginBottom: 8 }}>
            <code>{u.url}</code>
            <button className="btn ghost sm" onClick={async () => {
              // navigator.clipboard e undefined fora de contexto seguro e lanca
              // TypeError sincrono: sem isto, o toast dizia "Copiado" sobre uma
              // area de transferencia vazia
              const ok = await copiarTexto(u.url)
              toast(ok ? 'Copiado' : 'Não consegui copiar. Toque e segure no endereço.', !ok)
            }}>
              <Copy size={13} />
            </button>
          </div>
        ))}
        <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
          Não precisa escolher: o botão do rodízio lá em cima entrega uma por vez, na ordem certa.
        </p>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Novo link</b>
        <button className="btn ghost sm" onClick={aoFechar}><X size={14} />Cancelar</button>
      </div>

      <div className="field">
        <label htmlFor="lk-destino">Para onde este link leva</label>
        <input id="lk-destino" value={destinoBase} placeholder="https://exemplo.com/pagina"
          onChange={(e) => setDestinoBase(e.target.value)} />
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
        {leitura.ok && leitura.ancora && (
          <span className="mut" style={{ fontSize: 12 }}>
            Tem uma âncora (#{leitura.ancora}). Ela continua no fim, que é a única ordem que o
            navegador entende.
          </span>
        )}
      </div>

      <div className="grid2">
        <div className="field">
          <label htmlFor="lk-nome">Nome (pra você achar depois)</label>
          <input id="lk-nome" value={nome} onChange={(e) => setNome(e.target.value)}
            placeholder="VIP setembro" />
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
        <b>Por pessoa</b> manda sempre a mesma pessoa pro mesmo destino. É o que torna um teste
        A/B honesto: sem isso, quem abre o link duas vezes entra nos dois braços e contamina o
        resultado.
      </Ajuda>

      {/* ---------- destinos com peso ---------- */}
      <div className="grouplbl" style={{ marginTop: 16 }}>DESTINOS E PESO</div>
      <div className="urlbox" style={{ marginBottom: 8 }}>
        <code>{leitura.ok ? leitura.base : '(preencha o destino acima)'}</code>
        <span className="mchip">peso 100</span>
        <span className="mchip">{soma > 0 ? pct((100 * 100) / soma) : '·'}</span>
      </div>
      {extras.map((d, i) => {
        const pd = problemas.find((x) => x.onde === `destino-${i}`)
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <input value={d.url} placeholder="https://outro-destino.com"
                onChange={(e) => setExtras(extras.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
              <input value={d.rotulo ?? ''} placeholder="rótulo" style={{ maxWidth: 130 }}
                onChange={(e) => setExtras(extras.map((x, j) => j === i ? { ...x, rotulo: e.target.value } : x))} />
              <input type="number" min={0} value={d.peso} style={{ maxWidth: 90 }}
                onChange={(e) => setExtras(extras.map((x, j) => j === i ? { ...x, peso: Number(e.target.value) } : x))} />
              <span className="mchip">{soma > 0 ? pct((d.peso * 100) / soma) : '·'}</span>
              <button className="btn ghost sm" onClick={() => setExtras(extras.filter((_, j) => j !== i))}>
                <X size={13} />
              </button>
            </div>
            {pd && <span className="st-falha" role="alert" style={{ fontSize: 12.5 }}>{pd.msg}</span>}
          </div>
        )
      })}
      <button className="btn ghost sm"
        onClick={() => setExtras([...extras, { url: '', rotulo: '', peso: 50 }])}>
        <Plus size={13} />Adicionar destino
      </button>

      <Ajuda titulo="como o peso funciona">
        O peso é relativo: não precisa somar 100. Se você põe 3 e 1, o primeiro leva 75% e o
        segundo 25%. Peso 0 desliga o destino sem apagar, então o histórico de cliques dele
        continua no relatório.<br />
        Um detalhe que evita susto: sorteio tem variação natural. Com 50/50 e 100 cliques, ver
        54 e 46 é o esperado, não é defeito. A aba de Cliques mostra a margem esperada ao lado
        do número, e ela vai apertando conforme o volume cresce.
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
              <button className="btn ghost sm" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>
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

      {previa && (
        <>
          <div className="grouplbl" style={{ marginTop: 16 }}>PARA ONDE LEVA DE VERDADE</div>
          <div className="urlbox"><code>{previa}</code></div>
          <p className="mut" style={{ fontSize: 12, marginTop: 8 }}>
            O que você cola no grupo sai curto e muda de domínio a cada disparo. Isto aqui fica
            escondido atrás dele: quem clica não vê nada disso.
          </p>
        </>
      )}

      {erro && (
        <p className="st-falha" role="alert" style={{ fontSize: 13, marginTop: 12 }}>{erro}</p>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={criar}
          disabled={ocupado || problemas.length > 0 || !leitura.ok || !nome.trim()}>
          {ocupado ? <i className="spin" /> : <Plus size={15} />}
          {ocupado ? 'Criando...' : 'Criar link'}
        </button>
        <button className="btn ghost" onClick={aoFechar}>Cancelar</button>
      </div>
    </div>
  )
}

// =====================================================================
export function Links() {
  const [secao, setSecao] = useState<Secao>('links')
  const [doms, setDoms] = useState<LinkDominiosPainel | null>(null)
  const [links, setLinks] = useState<LinkItem[] | null>(null)
  const [cliques, setCliques] = useState<LinkCliques | null>(null)
  const [dias, setDias] = useState(7)
  const [busca, setBusca] = useState('')
  const [novo, setNovo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [novoDom, setNovoDom] = useState('')
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    setCarregando(true)
    try {
      const [d, l] = await Promise.all([linksDominios(), linksListar(busca)])
      setDoms(d)
      setLinks(l)
      setErro(null)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setCarregando(false)
    }
  }, [busca])

  useEffect(() => { carregar() }, [carregar])

  useEffect(() => {
    if (secao !== 'cliques') return
    let vivo = true
    linksCliques(dias)
      .then((c) => { if (vivo) setCliques(c) })
      .catch((e) => { if (vivo) setErro(e instanceof Error ? e.message : 'Falhou') })
    return () => { vivo = false }
  }, [secao, dias])

  // enquanto houver domínio esperando provisionamento, olha de perto;
  // fora isso, devagar. E pausa com a aba escondida, senão uma aba
  // esquecida martela o banco a noite toda.
  // Depender de [doms] rearmava o intervalo a cada poll (o objeto muda de
  // identidade), então o timing nunca era o escrito. E o polling rodava nas
  // três seções, martelando o banco com ninguém olhando.
  const temFila = !!doms?.dominios.some((d) => d.pedido_na_fila || d.estado === 'verificando')
  useEffect(() => {
    if (secao !== 'dominios' && !temFila) return
    const t = setInterval(() => {
      if (!document.hidden) linksDominios().then(setDoms).catch(() => {})
    }, temFila ? 10000 : 60000)
    return () => clearInterval(t)
  }, [temFila, secao])

  async function cadastrarDominio() {
    const h = novoDom.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
    if (!h || ocupado) return
    setOcupado(true)
    try {
      const r = await linksDominioCadastrar(h, raizDe(h))
      toast(r.aviso ?? 'Domínio cadastrado.')
      setNovoDom('')
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function reverificar(host: string) {
    if (ocupado) return
    setOcupado(true)
    try {
      const r = await linksDominioReverificar(host)
      toast(r.aviso ?? 'Vou conferir agora.')
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function mudarEstado(host: string, estado: DominioEstado) {
    try {
      const r = await linksDominioEstado(host, estado)
      toast(r.aviso ?? 'Pronto.')
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    }
  }

  const resumo = doms?.resumo
  const poucos = resumo ? resumo.raizes < resumo.minimo : false

  return (
    <section>
      <div className="toolbar between">
        <div>
          <h2>Links</h2>
          <p className="mut" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
            O link curto que vai pro grupo, com as UTMs escondidas atrás dele.
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {([['links', 'Links'], ['dominios', 'Domínios'], ['cliques', 'Cliques']] as const).map(([id, t]) => (
            <button key={id} className={'btn sm' + (secao === id ? '' : ' ghost')}
              aria-pressed={secao === id} onClick={() => setSecao(id)}>{t}</button>
          ))}
        </div>
      </div>

      {/* faixa do rodízio, visível nas três seções */}
      {resumo && (
        <div className="dispmeta">
          <span className={'badge ' + (poucos ? 'b-agendado' : 'b-concluida')}>
            Rodízio: {resumo.raizes} de {resumo.minimo} domínios
          </span>
          <span className="mchip">{resumo.ativos} ativos</span>
          {resumo.pendentes > 0 && <span className="mchip">{resumo.pendentes} esperando DNS</span>}
          {resumo.banidos > 0 && <span className="mchip">{resumo.banidos} banidos</span>}
        </div>
      )}

      {poucos && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--amber)' }}>
          <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
            <AlertTriangle size={17} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <b>O rodízio está com {resumo!.raizes} domínio(s) de raiz distinta.</b>
              <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>
                A forense de 11/08 escreveu com todas as letras: rodízio sobre poucas opções não é
                rodízio. Cada domínio novo divide a exposição de todos os outros.
                {secao !== 'dominios' && ' Cadastra os novos na aba Domínios.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {erro && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--red)' }}>
          <b>Não consegui carregar</b>
          <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>{erro}</p>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={carregar}>
            <RefreshCw size={13} />Tentar de novo
          </button>
        </div>
      )}

      {/* ================= LINKS ================= */}
      {secao === 'links' && (
        <>
          {carregando && !links && <SkeletonList rows={4} height={72} />}
          {links && links.length > 0 && <ProximaUrl links={links} />}
          {novo && <NovoLink aoCriar={carregar} aoFechar={() => setNovo(false)} />}

          <div className="toolbar between">
            <span className="count-pill">{n(links?.length ?? 0)} links</span>
            <div className="row" style={{ gap: 8 }}>
              <input className="search" value={busca} placeholder="buscar"
                onChange={(e) => setBusca(e.target.value)} />
              {!novo && (
                <button className="btn" onClick={() => setNovo(true)}
                  disabled={!resumo || resumo.ativos === 0}
                  title={resumo && resumo.ativos === 0 ? 'Cadastra um domínio antes' : undefined}>
                  <Plus size={15} />Novo link
                </button>
              )}
            </div>
          </div>

          {links && links.length === 0 && !novo && (
            <Empty Icon={Link2} title="Nenhum link ainda"
              sub="Crie o primeiro pra ter uma URL curta que muda de domínio a cada disparo." />
          )}

          {links?.map((l) => (
            <div className="listrow" key={l.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{l.nome}</b>
                <div className="row" style={{ gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                  <span className="badge b-rascunho">{l.destinos?.length ?? 0} destino(s)</span>
                  <span className="badge b-rascunho">{l.params?.length ?? 0} utms</span>
                  <span className="badge b-rascunho">
                    {l.divisao === 'pessoa' ? 'por pessoa' : 'por clique'}
                  </span>
                  {l.sem_braco && <span className="badge b-erro">sem braço</span>}
                  {l.congelado && <span className="badge b-rodando">congelado</span>}
                </div>
                <p className="mut" style={{ fontSize: 12, marginTop: 6 }}>
                  {n(l.cliques_7d)} cliques de gente em 7 dias · último {quando(l.ultimo_clique)}
                  {(l.destinos?.length ?? 0) > 1 && ' · ' +
                    (l.destinos ?? []).map((d) => `${d.rotulo ?? 'destino'} ${pct(d.pct)}`).join(' / ')}
                </p>
              </div>
            </div>
          ))}
        </>
      )}

      {/* ================= DOMÍNIOS ================= */}
      {secao === 'dominios' && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <b style={{ fontSize: 15 }}>Adicionar um domínio</b>
            <p className="mut" style={{ fontSize: 13, margin: '6px 0 14px' }}>
              Você só precisa ter comprado o domínio. O resto acontece aqui.
            </p>

            <div className="field">
              <label htmlFor="dom-novo">1. Qual endereço você quer usar nos links</label>
              <div className="row" style={{ gap: 8 }}>
                <input id="dom-novo" value={novoDom} placeholder="l.meudominio.com.br"
                  onChange={(e) => setNovoDom(e.target.value)} />
                <button className="btn" onClick={cadastrarDominio} disabled={ocupado || !novoDom.trim()}>
                  {ocupado ? <i className="spin" /> : <Plus size={15} />}Cadastrar
                </button>
              </div>
              {novoDom.trim() && (
                <span className="mut" style={{ fontSize: 12 }}>
                  Vira <code>https://{novoDom.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]}/abc123</code>
                  {' · '}raiz que conta pro rodízio: <b>{raizDe(novoDom)}</b>
                </span>
              )}
            </div>

            <div className="grouplbl" style={{ marginTop: 14 }}>DEPOIS DE CADASTRAR</div>
            <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>
              <b>2.</b> Eu mostro dois endereços de nameserver aqui embaixo, no cartão do domínio.
              Você entra no site onde comprou o domínio (Registro.br, GoDaddy, Hostinger) e troca os
              nameservers dele por esses dois.
            </p>
            <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>
              <b>3.</b> Só isso. Eu confiro de minuto em minuto e, quando o apontamento chegar,
              crio o endereço, peço o certificado e ligo o domínio no rodízio sozinho. Você não
              precisa ficar olhando a tela.
            </p>
            <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
              A troca de nameserver costuma valer em 10 a 30 minutos, mas o registrador pode levar
              algumas horas. Enquanto isso o domínio fica como "esperando você" e não entra no
              rodízio, então nenhum disparo sai por ele antes da hora.
            </p>

            <Ajuda titulo="por que preciso trocar o nameserver e não só criar um registro">
              Trocar o nameserver passa o domínio inteiro pra nossa conta, e é isso que me deixa
              criar o endereço e o certificado sem você mexer em mais nada, além de trocar destino
              e desligar o domínio na hora se ele for bloqueado. Com um registro avulso eu
              dependeria de você pra cada mudança, e numa hora de bloqueio isso custa caro.
              O domínio continua seu: você pode levar embora quando quiser.
            </Ajuda>
          </div>

          {carregando && !doms && <SkeletonList rows={3} height={110} />}
          {doms && doms.dominios.length === 0 && (
            <Empty Icon={Globe} title="Nenhum domínio cadastrado"
              sub="Sem domínio o encurtador não tem onde publicar." />
          )}

          {doms?.dominios.map((d) => (
            <div className="card" key={d.hostname} style={{ marginBottom: 10 }}>
              <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <b>{d.hostname}</b>{' '}
                  <span className={'badge ' + BADGE[d.estado].cls}>{BADGE[d.estado].txt}</span>
                  {!d.no_rodizio && <span className="badge b-rascunho">fora do rodízio</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {d.estado === 'ativo' && (
                    <button className="btn ghost sm" onClick={() => mudarEstado(d.hostname, 'suspeito')}>
                      Marcar suspeito
                    </button>
                  )}
                  {(d.estado === 'suspeito' || d.estado === 'pausado') && (
                    <button className="btn ghost sm" onClick={() => mudarEstado(d.hostname, 'ativo')}>
                      Voltar pro rodízio
                    </button>
                  )}
                </div>
              </div>
              {/* o passo que depende do operador: os endereços pra copiar */}
              {d.estado !== 'ativo' && d.nameservers?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="grouplbl">TROCA OS NAMESERVERS DESTE DOMÍNIO POR ESTES DOIS</div>
                  {d.nameservers.map((ns) => (
                    <div className="urlbox" key={ns} style={{ marginBottom: 6 }}>
                      <code>{ns}</code>
                      <button className="btn ghost sm" onClick={async () => {
                        const ok = await copiarTexto(ns)
                        toast(ok ? 'Copiado' : 'Toque e segure no endereço pra copiar', !ok)
                      }}><Copy size={13} /></button>
                    </div>
                  ))}
                  <p className="mut" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
                    Isso é feito no site onde você comprou o domínio, na parte de DNS ou
                    nameservers. Troca os dois que estiverem lá por estes.
                    {d.tentativas > 0 && ` Já conferi ${n(d.tentativas)} vez(es); ainda não chegou.`}
                  </p>
                  <button className="btn sm" style={{ marginTop: 10 }} disabled={ocupado}
                    onClick={() => reverificar(d.hostname)}>
                    <RefreshCw size={13} />Já troquei, confere agora
                  </button>
                </div>
              )}

              {d.estado === 'pendente' && !d.nameservers?.length && (
                d.ultimo_erro ? (
                  // não é erro, é o passo que falta: instrução, não alarme vermelho
                  <div style={{ marginTop: 10, borderLeft: '2px solid var(--amber)', paddingLeft: 12 }}>
                    <b style={{ fontSize: 13.5 }}>Falta um passo seu</b>
                    <p style={{ fontSize: 13, margin: '4px 0 8px' }}>{d.ultimo_erro}</p>
                    <button className="btn sm" disabled={ocupado}
                      onClick={() => reverificar(d.hostname)}>
                      <RefreshCw size={13} />Já fiz, confere agora
                    </button>
                  </div>
                ) : (
                  <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
                    <i className="spin" /> Preparando o domínio e buscando os nameservers. A tela
                    atualiza sozinha.
                  </p>
                )
              )}

              <div className="dispmeta" style={{ marginTop: 10, marginBottom: 0 }}>
                <span className="mchip">raiz {d.raiz}</span>
                <span className="mchip">{n(d.urls)} links</span>
                <span className="mchip">{n(d.entregas_7d)} entregas em 7d</span>
                <span className="mchip">{n(d.cliques_7d)} cliques em 7d</span>
                <span className="mchip">usado {quando(d.ultimo_uso)}</span>
                {d.pedido_na_fila && <span className="mchip"><i className="spin" />conferindo</span>}
              </div>
              {/* o pendente já mostrou a instrução acima; aqui só erro de verdade */}
              {d.ultimo_erro && d.estado !== 'verificando' && d.estado !== 'pendente' && (
                <p className="st-falha" style={{ fontSize: 12.5, marginTop: 8 }}>{d.ultimo_erro}</p>
              )}
            </div>
          ))}

          <Ajuda titulo="por que a raiz importa mais que o endereço">
            Quem bloqueia link (WhatsApp, Google, filtros de spam) trabalha no domínio raiz, não no
            endereço completo. Uma listagem em exemplo.com pega junto todos os l.exemplo.com,
            promo.exemplo.com e assim por diante. Por isso o rodízio conta raízes distintas: seis
            endereços do mesmo domínio seriam um alvo só, não seis.
          </Ajuda>
        </>
      )}

      {/* ================= CLIQUES ================= */}
      {secao === 'cliques' && (
        <>
          <div className="toolbar between">
            <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
              {cliques?.frescor.ultimo_evento
                ? `Último acesso registrado ${quando(cliques.frescor.ultimo_evento)}.`
                : 'Nenhum acesso registrado ainda.'}
            </p>
            <div className="row" style={{ gap: 6 }}>
              {[7, 14, 30, 90].map((p) => (
                <button key={p} className={'btn sm' + (dias === p ? '' : ' ghost')}
                  aria-pressed={dias === p} onClick={() => setDias(p)}>{p}d</button>
              ))}
            </div>
          </div>

          {!cliques && <SkeletonCards n={4} />}

          {cliques && (
            <>
              <div className="statcards">
                <div className="statcard">
                  <div className="val">{n(cliques.topo.acessos)}</div>
                  <div className="sub">acessos, tudo que tocou o link</div>
                </div>
                <div className="statcard sc-out">
                  <div className="val">{n(cliques.topo.robos)}</div>
                  <div className="sub">robôs, {pct(cliques.topo.pct_robo_por_hit)} do total</div>
                </div>
                <div className="statcard sc-in">
                  <div className="val">{n(cliques.topo.cliques)}</div>
                  <div className="sub">cliques de gente</div>
                </div>
                <div className="statcard sc-pessoas">
                  <div className="val">{n(cliques.topo.pessoas)}</div>
                  <div className="sub">pessoas, estimativa</div>
                </div>
              </div>

              <Ajuda titulo="por que separo robô de gente">
                Quando você cola um link no grupo, o WhatsApp abre ele sozinho pra montar aquela
                prévia com foto e título, <b>antes de qualquer pessoa tocar na tela</b>. Num disparo
                pra 101 grupos, só o robô já gera mais de cem acessos. Se a gente somasse tudo, o
                painel venderia clique que nunca existiu.<br /><br />
                <b>Cliques de gente</b> é o número pra levar pra reunião. Ele ainda não é "pessoas":
                a mesma pessoa pode abrir duas vezes.<br />
                <b>Pessoas</b> é estimativa mesmo. Sem cookie nem login, a gente junta acessos
                parecidos. Casa com wifi compartilhado conta menos gente do que existe; quem abre no
                app e depois no navegador conta como duas. Serve pra ordem de grandeza, nunca como
                número de leads.
                {cliques.topo.pct_robo_por_cluster != null && (
                  <><br /><br />Medindo por acesso dá {pct(cliques.topo.pct_robo_por_hit)}; medindo
                  por visitante distinto dá {pct(cliques.topo.pct_robo_por_cluster)}. Quando os dois
                  ficam longe, é porque poucos robôs bateram muitas vezes, e aí vale o segundo.</>
                )}
              </Ajuda>

              {cliques.topo.cliques === 0 && cliques.topo.robos > 0 && (
                <div className="card" style={{ marginTop: 12, borderColor: 'var(--red)' }}>
                  <b>Os links foram abertos {n(cliques.topo.robos)} vezes, todas por robô.</b>
                  <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>
                    Ninguém de verdade clicou ainda. Se já houve disparo, esse é o sintoma clássico
                    de link bloqueado dentro do WhatsApp.
                  </p>
                </div>
              )}

              {cliques.por_dominio.length > 0 && (
                <div className="card" style={{ marginTop: 14 }}>
                  <b>Por domínio</b>
                  <div className="scroll" style={{ marginTop: 10 }}>
                    <table className="tabela-min">
                      <thead>
                        <tr>
                          <th>Domínio</th><th>Estado</th>
                          <th className="num">Entregas</th><th className="num">Acessos</th>
                          <th className="num">Cliques</th><th>Último</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cliques.por_dominio.map((d) => {
                          const morto = d.entregas >= 10 && d.cliques === 0
                          return (
                            <tr key={d.dominio} style={morto ? { color: 'var(--red)' } : undefined}>
                              <td>{d.dominio}</td>
                              <td><span className={'badge ' + BADGE[d.estado].cls}>{BADGE[d.estado].txt}</span></td>
                              <td className="num">{n(d.entregas)}</td>
                              <td className="num">{n(d.acessos)}</td>
                              <td className="num">{n(d.cliques)}</td>
                              <td>{quando(d.ultimo_clique)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Ajuda titulo="como ler esta tabela">
                    Este é o alarme de incêndio. Domínio que foi entregue muitas vezes nos disparos
                    e mesmo assim tem clique perto de zero quase sempre já está bloqueado dentro do
                    WhatsApp, mesmo que nenhum grupo tenha caído ainda. Tirar do rodízio nessa hora
                    é mais barato do que perder a comunidade.<br />
                    Entregas conta mensagens enviadas, não cliques, de propósito: se contasse
                    cliques, um domínio bloqueado pareceria "pouco usado" justamente por estar morto.
                  </Ajuda>
                </div>
              )}

              {cliques.por_destino.length > 0 && (
                <div className="card" style={{ marginTop: 14 }}>
                  <b>Por destino: peso configurado contra o que aconteceu</b>
                  <div className="scroll" style={{ marginTop: 10 }}>
                    <table className="tabela-min">
                      <thead>
                        <tr>
                          <th>Link</th><th>Destino</th>
                          <th className="num">Configurado</th><th className="num">Real</th>
                          <th className="num">Margem</th><th className="num">Acessos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cliques.por_destino.map((d, i) => {
                          const fora = d.comparavel && d.pct_real != null && d.pct_configurado != null
                            && d.margem_pp != null
                            && Math.abs(d.pct_real - d.pct_configurado) > d.margem_pp
                          return (
                            <tr key={i}>
                              <td>{d.link}</td>
                              <td>{d.destino}</td>
                              <td className="num">{pct(d.pct_configurado)}</td>
                              <td className="num" style={fora ? { color: 'var(--amber)' } : undefined}>
                                {d.comparavel ? pct(d.pct_real) : '·'}
                              </td>
                              <td className="num">{d.comparavel ? '± ' + pct(d.margem_pp) : '·'}</td>
                              <td className="num">{n(d.acessos)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Ajuda titulo="por que às vezes aparece um ponto no lugar do número">
                    A comparação só começa depois da última vez que você mexeu no peso, e só aparece
                    quando há acesso suficiente pra ela querer dizer alguma coisa (a partir de 30).
                    Antes disso mostro um ponto em vez de um número, porque comparar o peso de agora
                    com cliques que aconteceram sob o peso antigo faria o painel acusar um desvio que
                    não existe.<br /><br />
                    A margem é a variação normal do sorteio para esse volume. Enquanto o real estiver
                    dentro dela, está tudo certo mesmo que os números não batam exatamente. Ela
                    aperta sozinha conforme o volume cresce: com 50/50, são cerca de 5 pontos em 100
                    acessos e menos de 2 em mil.
                  </Ajuda>
                </div>
              )}

              {cliques.topo.acessos === 0 && (
                <Empty Icon={MousePointerClick} title="Nenhum acesso registrado ainda"
                  sub="O redirecionador é um serviço separado do painel. Assim que o primeiro link for aberto, os números aparecem aqui sozinhos." />
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
