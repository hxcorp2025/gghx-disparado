import { useEffect, useState, lazy, Suspense } from 'react'
import { sendflowPainel } from '../lib/sendflowDb'
import type { SendflowPainel } from '../lib/sendflowDb'
import { SkeletonCards } from '../components/Skeleton'
import { AlertTriangle, Ghost, Wifi, WifiOff } from 'lucide-react'

// code-split: recharts só carrega ao abrir esta aba
const FunilChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.FunilChart })))
const ReceitaChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.ReceitaChart })))
const chartFallback = <div className="skel" style={{ height: 240, borderRadius: 10 }} />

// Sem 90 dias de proposito: nessa janela o saldo por campanha inverte o ranking.
// A janela comeca antes do que a API registra pra campanha antiga, e grupo banido
// leva as pessoas embora sem gerar evento de saida, entao a campanha destruida
// aparece com o melhor saldo da tela. Em 28 dias isso nao acontece.
const PERIODOS = [7, 14, 21, 28]

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString('pt-BR')
const brl = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
const pct = (v: number | null | undefined) => (v == null ? '·' : v.toLocaleString('pt-BR') + '%')

// "o que é" + "como ler" a um clique, nunca em tooltip: métrica nova sem camada
// didática deixa quem lê para trás.
function Ajuda({ children }: { children: React.ReactNode }) {
  return (
    <details className="ajuda">
      <summary>como ler</summary>
      <p>{children}</p>
    </details>
  )
}

export function Estatisticas() {
  const [dias, setDias] = useState(7)
  const [d, setD] = useState<SendflowPainel | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    sendflowPainel(dias)
      .then((r) => vivo && (setD(r), setErro(null)))
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falhou'))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [dias])

  if (carregando && !d) {
    return (
      <section>
        <SkeletonCards n={5} />
        <div className="skel" style={{ height: 260, borderRadius: 'var(--r-card)', marginBottom: 14 }} />
      </section>
    )
  }

  if (erro && !d) {
    return (
      <section>
        <div className="empty">
          <div className="empty-ico">
            <AlertTriangle size={22} />
          </div>
          <div className="empty-title">Não consegui carregar os números</div>
          <div className="empty-sub">
            {erro}. Os dados vêm do coletor do SendFlow no banco. Se isso persistir, o coletor pode
            estar parado.
          </div>
        </div>
      </section>
    )
  }
  if (!d) return null

  // o rotulo segue o periodo que VEIO na resposta, nao o botao: senao, entre o
  // clique e a volta da RPC, a tela promete 90 dias sobre o numero de 7
  const { topo, grupos, receita, frescor, periodo_dias: per } = d
  const chipsPessoais = d.chips.filter((c) => c.tipo.includes('pessoal')).length
  const chipsCaidos = d.chips.filter((c) => !c.situacao.includes('conectado')).length
  // campanha que perde gente no período é o que o agregado esconde
  const sangrando = d.campanhas.filter(
    (c) => c.saidas_periodo > c.entradas_periodo && c.grupos_sumidos_periodo === 0,
  )

  return (
    <section>
      <div className="row between" style={{ marginBottom: 4, alignItems: 'flex-end' }}>
        <h2 style={{ margin: 0 }}>Comunidades</h2>
        <div className="row" style={{ gap: 6 }}>
          {PERIODOS.map((p) => (
            <button
              key={p}
              className={'btn sm ' + (p === dias ? '' : 'ghost')}
              onClick={() => setDias(p)}
              aria-pressed={p === dias}
            >
              {p} dias
            </button>
          ))}
        </div>
      </div>
      <p className="mut" style={{ fontSize: 12.5, margin: '0 0 16px' }}>
        Movimento das comunidades de WhatsApp no SendFlow. Grupos e pessoas são o retrato de{' '}
        {frescor.grupos ?? '·'}; entradas e saídas vão até {frescor.analytics ?? '·'}, sendo o dia de
        hoje parcial (a coleta roda de madrugada).
      </p>

      {erro && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'rgba(255, 77, 77, 0.35)' }}>
          <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
            <AlertTriangle size={17} style={{ color: 'var(--critico)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <b>Não consegui atualizar para {dias} dias</b>
              <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>
                {erro}. O que está na tela abaixo continua sendo o período de {per} dias.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* faixa 1: o funil de entrada, que é o que o painel do SendFlow mostra */}
      <div style={{ opacity: carregando ? 0.55 : 1, transition: 'opacity var(--t)' }} aria-busy={carregando}>
      <div className="statcards">
        <div className="statcard sc-pessoas">
          <div className="lbl">Cliques no convite</div>
          <div className="val">{n(topo.clicks)}</div>
          <div className="sub">últimos {per} dias</div>
        </div>
        <div className="statcard sc-in">
          <div className="lbl">Entraram</div>
          <div className="val" style={{ color: 'var(--ok)' }}>
            {n(topo.entradas)}
          </div>
          <div className="sub">de {n(topo.clicks)} que clicaram</div>
        </div>
        <div className="statcard">
          <div className="lbl">Taxa de entrada</div>
          <div className="val">{pct(topo.pct_entrada)}</div>
          <div className="sub">clicou e entrou de fato</div>
          <Ajuda>
            De cada 100 pessoas que clicam no link do convite, quantas realmente entram num grupo.
            Cai quando o grupo de destino está cheio ou quando o link leva a uma comunidade que
            travou. É o primeiro lugar para olhar quando o tráfego está caro.
          </Ajuda>
        </div>
        <div className="statcard sc-out">
          <div className="lbl">Saíram</div>
          <div className="val" style={{ color: 'var(--critico)' }}>
            {n(topo.saidas)}
          </div>
          <div className="sub">últimos {per} dias</div>
        </div>
        <div className="statcard sc-saldo">
          <div className="lbl">Saldo de pessoas</div>
          <div className="val" style={{ color: topo.saldo >= 0 ? 'var(--ok)' : 'var(--critico)' }}>
            {topo.saldo >= 0 ? '+' : '−'}
            {n(Math.abs(topo.saldo))}
          </div>
          <div className="sub">entraram menos saíram</div>
        </div>
      </div>

      {/* faixa 2: o parque de grupos e o dinheiro */}
      <div className="statcards">
        <div className="statcard">
          <div className="lbl">Grupos vivos</div>
          <div className="val">{n(grupos.total)}</div>
          <div className="sub">
            {n(grupos.cheios)} cheios · {n(grupos.livres)} com vaga
          </div>
        </div>
        <div className="statcard sc-pessoas">
          <div className="lbl">Pessoas nos grupos</div>
          <div className="val">{n(grupos.participantes)}</div>
          <div className="sub">total agora</div>
        </div>
        <div className="statcard sc-in">
          <div className="lbl">Receita das comunidades</div>
          <div className="val" style={{ color: 'var(--ok)' }}>
            {brl(receita.total)}
          </div>
          <div className="sub">
            {n(receita.vendas)} vendas em {per} dias
            {receita.desde && ` · desde ${receita.desde.split('-').reverse().join('/')}`}
          </div>
          <Ajuda>
            Vendas do Sortudão que vieram das comunidades, somadas por dia. Este número não existe no
            painel do SendFlow: ele sai do cruzamento com as vendas aqui no banco. É o que transforma
            "entrou gente" em "entrou dinheiro".
          </Ajuda>
        </div>
        <div className="statcard sc-out">
          <div className="lbl">Grupos que morreram</div>
          <div className="val" style={{ color: grupos.mortos ? 'var(--critico)' : undefined }}>
            {n(grupos.mortos)}
          </div>
          <div className="sub">com data registrada</div>
          <Ajuda>
            Grupo banido ou apagado simplesmente some da lista do SendFlow, sem deixar rastro. Aqui
            ele fica registrado com a data em que sumiu, então dá para amarrar a queda ao disparo que
            veio antes.
          </Ajuda>
        </div>
      </div>

      {/* o que o agregado esconde */}
      {sangrando.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'rgba(245, 165, 36, 0.35)' }}>
          <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
            <AlertTriangle size={17} style={{ color: 'var(--atencao)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <b>
                {sangrando.length === 1 ? 'Uma campanha perde' : `${sangrando.length} campanhas perdem`} mais
                gente do que ganha nestes {per} dias
              </b>
              <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>
                {sangrando
                  .map((c) => `${c.campanha}: ${n(c.entradas_periodo)} entraram e ${n(c.saidas_periodo)} saíram`)
                  .join(' · ')}
                . A taxa de entrada lá em cima é a média de todas as campanhas juntas, então uma que
                cresce esconde uma que sangra.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Movimento por dia</h2>
          <span className="mut" style={{ fontSize: 12 }}>
            últimos {per} dias · hoje sombreado, ainda incompleto
          </span>
        </div>
        {d.serie.length ? (
          <Suspense fallback={chartFallback}>
            <FunilChart data={d.serie} />
          </Suspense>
        ) : (
          <p className="mut">Sem movimento registrado neste período.</p>
        )}
      </div>

      {/* campanha a campanha: a leitura que o painel deles não dá */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Campanha a campanha</h2>
          <span className="mut" style={{ fontSize: 12 }}>entraram, saíram e saldo são da janela</span>
        </div>
        <div className="scroll" style={{ maxHeight: 340 }}>
          <table className="tabela-min">
            <thead>
              <tr>
                <th>Campanha</th>
                <th className="num">Pessoas</th>
                <th className="num">Grupos</th>
                <th className="num">Entraram</th>
                <th className="num">Saíram</th>
                <th className="num">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {d.campanhas.map((c) => {
                const saldo = c.entradas_periodo - c.saidas_periodo
                const perde = saldo < 0
                return (
                  <tr key={c.release_id}>
                    <td>
                      <b>{c.campanha}</b>
                      {c.modo_criacao === 'safe' && (
                        <span className="gtag gtag-com" title="criação de grupo em modo seguro">
                          safe
                        </span>
                      )}
                      {c.grupos_sumidos > 0 && (
                        <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {c.grupos_sumidos} grupo{c.grupos_sumidos === 1 ? '' : 's'} já sumiu
                          {c.grupos_sumidos === 1 ? '' : 'ram'}
                          {c.grupos_sumidos_periodo > 0 && (
                            <>
                              , {c.grupos_sumidos_periodo} neste período
                              <span className="cool info" style={{ marginLeft: 6 }}>
                                saldo incompleto
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="num">{n(c.pessoas_ativas)}</td>
                    <td className="num">{n(c.grupos_vivos)}</td>
                    <td className="num" style={{ color: c.entradas_periodo ? 'var(--ok)' : undefined }}>
                      {n(c.entradas_periodo)}
                    </td>
                    <td className="num" style={{ color: c.saidas_periodo ? 'var(--critico)' : undefined }}>
                      {n(c.saidas_periodo)}
                    </td>
                    {/* estado com FORMA e cor: a seta funciona pra quem nao separa verde de vermelho */}
                    <td className="num" style={{ color: saldo === 0 ? undefined : perde ? 'var(--critico)' : 'var(--ok)' }}>
                      {saldo === 0 ? '·' : (perde ? '↓ ' : '↑ ') + n(Math.abs(saldo))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <Ajuda>
          Pessoas e grupos são o estado de agora; entraram, saíram e saldo são só destes {per} dias.
          O saldo é o que sobrou na janela: entraram menos saíram. Uma campanha com muita gente
          dentro e saldo negativo está devolvendo mais do que capta agora, mesmo que o total
          acumulado ainda pareça bom. Não existe aqui uma taxa de retenção histórica porque a API do
          SendFlow não guarda todas as entradas antigas, e uma taxa com metade da história vira um
          número que engana nos dois sentidos. Quando um grupo é banido, quem estava dentro some sem
          passar por "saíram": por isso a campanha que perdeu grupos no período aparece marcada, e o
          saldo dela parece melhor do que foi.
        </Ajuda>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="row between" style={{ marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>Receita por dia</h2>
            <span className="mut" style={{ fontSize: 12 }}>comunidades</span>
          </div>
          {receita.dias.length ? (
            <Suspense fallback={chartFallback}>
              <ReceitaChart data={receita.dias} />
            </Suspense>
          ) : (
            <p className="mut">Sem venda de comunidade neste período.</p>
          )}
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Chips</h2>
            <span className="mut" style={{ fontSize: 12 }}>{frescor.chips ?? '·'}</span>
          </div>
          {(chipsPessoais > 0 || chipsCaidos > 0) && (
            <p className="mut" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {chipsCaidos > 0 && `${chipsCaidos} fora do ar. `}
              {chipsPessoais > 0 &&
                `${chipsPessoais} ${chipsPessoais === 1 ? 'é número pessoal' : 'são números pessoais'}, o que o manual anti-ban desaconselha.`}
            </p>
          )}
          <div className="scroll" style={{ maxHeight: 220, border: 'none' }}>
            <table>
              <tbody>
                {d.chips.map((c, i) => {
                  const ok = c.situacao.includes('conectado')
                  return (
                    <tr key={c.nome + i}>
                      <td>
                        <span className={'badge b-' + (ok ? 'concluida' : 'erro')}>
                          {ok ? <Wifi size={11} /> : <WifiOff size={11} />}
                          {ok ? 'no ar' : 'caiu'}
                        </span>{' '}
                        {c.nome}
                        {c.tipo.includes('pessoal') && (
                          <span className="cool" style={{ marginLeft: 7 }}>
                            pessoal
                          </span>
                        )}
                        {c.ultimo_motivo_queda && !ok && (
                          <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>
                            {c.ultimo_motivo_queda}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {!d.chips.length && (
                  <tr>
                    <td className="mut">Nenhum chip conectado no SendFlow.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      </div>

      {d.mortos.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>
              <Ghost size={15} style={{ verticalAlign: -2, marginRight: 7, color: 'var(--mut)' }} />
              Grupos que sumiram
            </h2>
            <span className="mut" style={{ fontSize: 12 }}>mais recentes primeiro</span>
          </div>
          <div className="scroll" style={{ maxHeight: 240, border: 'none' }}>
            <table>
              <tbody>
                {d.mortos.map((m) => (
                  <tr key={m.sumiu_em + (m.nome ?? '')}>
                    <td>
                      {m.nome ?? '·'}
                      <span className="mut"> · {m.campanha ?? '·'}</span>
                    </td>
                    <td className="quando">{m.sumiu_em}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Ajuda>
            Quando um grupo é banido ou apagado, ele some da lista do SendFlow e o histórico vai
            junto. O coletor guarda a data do último dia em que o grupo foi visto vivo, que é o que
            permite ligar a morte ao disparo que veio antes dela.
          </Ajuda>
        </div>
      )}
    </section>
  )
}
