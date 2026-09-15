import { useEffect, useState } from 'react'
import { MousePointerClick } from 'lucide-react'
import { linksCliques, type LinkCliques } from '../../lib/linksDb'
import { Empty } from '../../components/Empty'
import { SkeletonCards } from '../../components/Skeleton'
import { n, pct, quando, Ajuda, BADGE } from './comum'

// =====================================================================
// Visao geral: todos os links juntos, por dominio (o alarme de bloqueio do
// rodizio) e por destino. O detalhe de UM link mora em Detalhe.tsx.
// =====================================================================
export function Cliques() {
  const [cliques, setCliques] = useState<LinkCliques | null>(null)
  const [dias, setDias] = useState(7)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    setCliques(null)
    linksCliques(dias)
      .then((c) => { if (vivo) { setCliques(c); setErro(null) } })
      .catch((e) => { if (vivo) setErro(e instanceof Error ? e.message : 'Falhou') })
    return () => { vivo = false }
  }, [dias])

  return (
    <>
      <div className="toolbar between">
        <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
          {cliques?.frescor.ultimo_evento
            ? `Último acesso registrado ${quando(cliques.frescor.ultimo_evento)}.`
            : 'Todos os links, somados.'}
        </p>
        <div className="row" style={{ gap: 6 }}>
          {[7, 14, 30, 90].map((p) => (
            <button key={p} className={'btn sm' + (dias === p ? '' : ' ghost')}
              aria-pressed={dias === p} onClick={() => setDias(p)}>{p}d</button>
          ))}
        </div>
      </div>

      {erro && <p className="st-falha" role="alert" style={{ fontSize: 13 }}>{erro}</p>}
      {!cliques && !erro && <SkeletonCards n={4} />}

      {cliques && (
        <>
          <div className="statcards">
            <div className="statcard">
              <div className="lbl">Acessos</div>
              <div className="val">{n(cliques.topo.acessos)}</div>
              <div className="sub">tudo que tocou os links</div>
            </div>
            <div className="statcard sc-out">
              <div className="lbl">Robôs</div>
              <div className="val">{n(cliques.topo.robos)}</div>
              <div className="sub">{pct(cliques.topo.pct_robo_por_hit)} do total</div>
            </div>
            <div className="statcard sc-in">
              <div className="lbl">Cliques de gente</div>
              <div className="val">{n(cliques.topo.cliques)}</div>
              <div className="sub">o número pra levar pra reunião</div>
            </div>
            <div className="statcard sc-pessoas">
              <div className="lbl">IPs distintos</div>
              <div className="val">{n(cliques.topo.pessoas)}</div>
              <div className="sub">piso de pessoas, não contagem</div>
            </div>
          </div>

          <Ajuda titulo="por que separo robô de gente">
            Quando você cola um link no grupo, o WhatsApp abre ele sozinho pra montar aquela
            prévia com foto e título, <b>antes de qualquer pessoa tocar na tela</b>. Num disparo
            pra 101 grupos, só o robô já gera mais de cem acessos. Se a gente somasse tudo, o
            painel venderia clique que nunca existiu.<br /><br />
            <b>Cliques de gente</b> é o número pra levar pra reunião. Ele ainda não é "pessoas":
            a mesma pessoa pode abrir duas vezes.<br />
            <b>IPs distintos</b> é piso, não contagem: operadora de celular junta muita gente num
            IP só e troca o IP da mesma pessoa várias vezes ao dia. Pessoas de verdade, por cookie,
            aparecem no detalhe de cada link.
            {cliques.topo.pct_robo_por_cluster != null && (
              <><br /><br />Medindo por acesso dá {pct(cliques.topo.pct_robo_por_hit)}; medindo
              por IP distinto dá {pct(cliques.topo.pct_robo_por_cluster)}. Quando os dois
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
                      <th className="num">Cliques</th><th className="num">Perdidos</th><th>Último</th>
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
                          <td className="num" style={d.perdidos > 0 ? { color: 'var(--amber)' } : undefined}>{n(d.perdidos)}</td>
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
                <b>Perdidos</b> são acessos a um endereço que não existe nesse domínio (link
                antigo ainda colado em algum lugar): a pessoa cai na página do domínio, não no
                destino. Quando passa de 20 em duas horas, chega um aviso no WhatsApp do Matheus.<br />
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
  )
}
