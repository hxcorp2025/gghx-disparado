import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { linksDominios, type LinkDominiosPainel } from '../lib/linksDb'
import { Lista } from './links/Lista'
import { Detalhe } from './links/Detalhe'
import { Dominios } from './links/Dominios'
import { Cliques } from './links/Cliques'

type Secao = 'links' | 'dominios' | 'geral'

// =====================================================================
// Aba Links (v2, 15/09/2026): Lista -> Detalhe -> Editar, com o rodizio de
// dominio como acao na linha (so quando ha 2+ raizes). O encurtador em si
// e um Worker na borda da Cloudflare; aqui e o painel.
// PRD: contexto/GESTOR_GRUPOS_HX/PRD_links_v2_2026-09-15.md
// =====================================================================
export function Links() {
  const [secao, setSecao] = useState<Secao>('links')
  const [aberto, setAberto] = useState<string | null>(null)
  const [doms, setDoms] = useState<LinkDominiosPainel | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)

  const carregarDoms = useCallback(async () => {
    setCarregando(true)
    try {
      setDoms(await linksDominios())
      setErro(null)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falhou')
    } finally {
      setCarregando(false)
    }
  }, [])

  useEffect(() => { carregarDoms() }, [carregarDoms])

  // enquanto houver domínio esperando provisionamento, olha de perto;
  // fora isso, só na aba de domínios e devagar. Pausa com a aba escondida,
  // senão uma aba esquecida martela o banco a noite toda.
  const temFila = !!doms?.dominios.some((d) => d.pedido_na_fila || d.estado === 'verificando')
  useEffect(() => {
    if (secao !== 'dominios' && !temFila) return
    const t = setInterval(() => {
      if (!document.hidden) linksDominios().then(setDoms).catch(() => {})
    }, temFila ? 10000 : 60000)
    return () => clearInterval(t)
  }, [temFila, secao])

  if (aberto) {
    return (
      <section>
        <Detalhe id={aberto} doms={doms} onVoltar={() => setAberto(null)} />
      </section>
    )
  }

  const resumo = doms?.resumo
  // a faixa do rodizio some com um dominio so: nao existe rodizio pra mostrar
  const mostraRodizio = !!resumo && resumo.raizes >= 2

  return (
    <section>
      <div className="toolbar between">
        <div>
          <h2>Links</h2>
          <p className="mut" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
            URL curta com QR, cliques de gente por link e as UTMs escondidas atrás dela.
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {([['links', 'Links'], ['dominios', 'Domínios'], ['geral', 'Visão geral']] as const).map(([id, t]) => (
            <button key={id} className={'btn sm' + (secao === id ? '' : ' ghost')}
              aria-pressed={secao === id} onClick={() => setSecao(id)}>{t}</button>
          ))}
        </div>
      </div>

      {mostraRodizio && secao !== 'dominios' && (
        <div className="dispmeta">
          <span className={'badge ' + (resumo.raizes < resumo.minimo ? 'b-agendado' : 'b-concluida')}>
            Rodízio: {resumo.raizes} de {resumo.minimo} domínios
          </span>
          <span className="mchip">{resumo.ativos} ativos</span>
          {resumo.pendentes > 0 && <span className="mchip">{resumo.pendentes} esperando DNS</span>}
          {resumo.banidos > 0 && <span className="mchip">{resumo.banidos} banidos</span>}
        </div>
      )}

      {erro && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--red)' }}>
          <b>Não consegui carregar os domínios</b>
          <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>{erro}</p>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={carregarDoms}>
            <RefreshCw size={13} />Tentar de novo
          </button>
        </div>
      )}

      {secao === 'links' && <Lista doms={doms} onAbrir={setAberto} />}
      {secao === 'dominios' && <Dominios doms={doms} carregando={carregando} recarregar={carregarDoms} />}
      {secao === 'geral' && <Cliques />}
    </section>
  )
}
