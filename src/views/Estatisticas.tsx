import { useEffect, useState, lazy, Suspense } from 'react'
import { useApp } from '../state'
import { getMovimentosResumo, listAvisos, statsDiario, disparosDiario, disparosPorCampanha } from '../lib/db'
import type { Aviso, StatDia, DisparoDia, DispPorCampanha } from '../lib/db'
import { SkeletonCards } from '../components/Skeleton'
import { Modal } from '../components/Modal'
import { Megaphone } from 'lucide-react'

// code-split: recharts só carrega ao abrir esta aba
const EntregasChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.EntregasChart })))
const DisparosChart = lazy(() => import('../components/Charts').then((m) => ({ default: m.DisparosChart })))
const chartFallback = <div className="skel" style={{ height: 230, borderRadius: 10 }} />

export function Estatisticas() {
  const { grupos, loadingGrupos } = useApp()
  const [mov, setMov] = useState({ entradas: 0, saidas: 0 })
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const [statsDia, setStatsDia] = useState<StatDia[]>([])
  const [dispDia, setDispDia] = useState<DisparoDia[]>([])
  const [porCamp, setPorCamp] = useState<DispPorCampanha[]>([])
  const [showCamp, setShowCamp] = useState(false)
  const dias = 7

  useEffect(() => {
    getMovimentosResumo(dias).then(setMov).catch(() => {})
  }, [dias])
  useEffect(() => {
    listAvisos().then(setAvisos).catch(() => {})
    statsDiario(14).then(setStatsDia).catch(() => {})
    disparosDiario(14).then(setDispDia).catch(() => {})
    disparosPorCampanha().then(setPorCamp).catch(() => {})
  }, [])

  const campanhasComDisparo = porCamp.filter((c) => c.lista_id != null).length
  const totalDisparos = porCamp.reduce((n, c) => n + c.disparos, 0)

  const gruposAtivos = grupos.length
  const avisosCount = grupos.filter((g) => g.is_announcement === true).length
  const pessoas = grupos.reduce((n, g) => n + (g.participantes || 0), 0)

  // taxa de leitura agregada (piso) dos últimos 14d
  const tot = statsDia.reduce(
    (a, s) => ({ e: a.e + s.enviadas, d: a.d + s.entregues, l: a.l + s.lidas }),
    { e: 0, d: 0, l: 0 },
  )
  const taxaLeitura = tot.e ? Math.round((tot.l / tot.e) * 100) : 0

  if (loadingGrupos && !grupos.length) {
    return (
      <section>
        <SkeletonCards n={5} />
        <div className="skel" style={{ height: 260, borderRadius: 'var(--r-card)', marginBottom: 14 }} />
        <div className="grid2">
          <div className="skel" style={{ height: 260, borderRadius: 'var(--r-card)' }} />
          <div className="skel" style={{ height: 260, borderRadius: 'var(--r-card)' }} />
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2 style={{ marginBottom: 14 }}>Visão geral</h2>

      <div className="statcards" style={{ marginTop: 12 }}>
        <div className="statcard">
          <div className="lbl">Grupos ativos</div>
          <div className="val">{gruposAtivos}</div>
          <div className="sub">{avisosCount} de avisos</div>
        </div>
        <div className="statcard sc-pessoas">
          <div className="lbl">Total de pessoas</div>
          <div className="val">{pessoas.toLocaleString('pt-BR')}</div>
          <div className="sub">nos grupos lidos</div>
        </div>
        <div className="statcard sc-in">
          <div className="lbl">Entraram</div>
          <div className="val" style={{ color: 'var(--accent)' }}>
            +{mov.entradas}
          </div>
          <div className="sub">últimos {dias} dias</div>
        </div>
        <div className="statcard sc-out">
          <div className="lbl">Saíram</div>
          <div className="val" style={{ color: 'var(--red)' }}>
            −{mov.saidas}
          </div>
          <div className="sub">últimos {dias} dias</div>
        </div>
        <div className="statcard sc-saldo">
          <div className="lbl">Crescimento</div>
          <div className="val" style={{ color: mov.entradas - mov.saidas >= 0 ? 'var(--accent)' : 'var(--red)' }}>
            {mov.entradas - mov.saidas >= 0 ? '+' : ''}
            {mov.entradas - mov.saidas}
          </div>
          <div className="sub">saldo · {dias} dias</div>
        </div>
        <div className="statcard">
          <div className="lbl">Taxa de leitura</div>
          <div className="val" style={{ color: 'var(--blue)' }}>
            {taxaLeitura}%
          </div>
          <div className="sub">piso · 14 dias</div>
        </div>
        <div
          className="statcard clickable"
          onClick={() => setShowCamp(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShowCamp(true)}
        >
          <div className="lbl">
            <Megaphone size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
            Disparos por campanha
          </div>
          <div className="val">{totalDisparos}</div>
          <div className="sub" style={{ color: 'var(--accent)' }}>
            {campanhasComDisparo} campanha{campanhasComDisparo === 1 ? '' : 's'} · ver detalhe
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Entregas por dia</h2>
          <span className="mut" style={{ fontSize: 12 }}>últimos 14 dias</span>
        </div>
        {statsDia.length ? (
          <Suspense fallback={chartFallback}>
            <EntregasChart data={statsDia} />
          </Suspense>
        ) : (
          <p className="mut">Sem mensagens ainda.</p>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Disparos por dia</h2>
          {dispDia.length ? (
            <Suspense fallback={chartFallback}>
              <DisparosChart data={dispDia} />
            </Suspense>
          ) : (
            <p className="mut">Sem disparos ainda.</p>
          )}
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>Avisos (chip / conexão)</h2>
            <span className="mut" style={{ fontSize: 12 }}>saúde</span>
          </div>
          {!avisos.length && <p className="mut">Sem avisos recentes.</p>}
          <div className="scroll" style={{ maxHeight: 200, border: 'none' }}>
            <table>
              <tbody>
                {avisos.map((a) => {
                  const desconectou = a.evento === 'disconnected'
                  const ban = a.evento === 'ban_suspeito' || a.evento === 'limite_atingido'
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className={'badge b-' + (desconectou || ban ? 'erro' : 'concluida')}>
                          {ban ? '⚠ ' + a.evento : desconectou ? '🔴 caiu' : '🟢 conectou'}
                        </span>{' '}
                        {a.instancia || 'HxSend'}
                        {a.motivo ? <span className="mut"> · {a.motivo}</span> : null}
                      </td>
                      <td className="mut" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {a.received_at ? new Date(a.received_at).toLocaleString('pt-BR') : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showCamp && (
        <Modal
          title="Disparos por campanha"
          sub="Agregado de todos os disparos, agrupados pela campanha (lista) de origem."
          onClose={() => setShowCamp(false)}
        >
          {!porCamp.length ? (
            <p className="mut">Nenhum disparo ainda.</p>
          ) : (
            <div className="scroll" style={{ border: 'none', maxHeight: '60vh' }}>
              <table>
                <thead>
                  <tr>
                    <th>Campanha</th>
                    <th style={{ width: 70, textAlign: 'right' }}>Disp.</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Enviadas</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Entregues</th>
                    <th style={{ width: 70, textAlign: 'right' }}>Lidas</th>
                    <th style={{ width: 120 }}>Último</th>
                  </tr>
                </thead>
                <tbody>
                  {porCamp.map((c, i) => {
                    const semCamp = c.lista_id == null
                    return (
                      <tr key={c.lista_id ?? `x${i}`}>
                        <td className={semCamp ? 'mut' : ''} style={{ fontWeight: semCamp ? 400 : 600 }}>
                          {c.campanha}
                        </td>
                        <td style={{ textAlign: 'right' }}>{c.disparos}</td>
                        <td style={{ textAlign: 'right' }}>{c.enviadas.toLocaleString('pt-BR')}</td>
                        <td style={{ textAlign: 'right', color: 'var(--accent)' }}>
                          {c.entregues.toLocaleString('pt-BR')}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--blue)' }}>
                          {c.lidas.toLocaleString('pt-BR')}
                        </td>
                        <td className="mut" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                          {c.ultimo ? new Date(c.ultimo).toLocaleDateString('pt-BR') : '·'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mut" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            "(sem campanha)" = disparos feitos por seleção manual de grupos ou de listas antigas que já
            mudaram. Novos disparos a partir de uma campanha já entram agrupados aqui.
          </p>
        </Modal>
      )}
    </section>
  )
}
