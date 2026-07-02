import { useEffect, useState } from 'react'
import { useApp } from '../state'
import { getMovimentosResumo, listAvisos, statsDiario, disparosDiario } from '../lib/db'
import type { Aviso, StatDia, DisparoDia } from '../lib/db'
import { SkeletonCards } from '../components/Skeleton'
import { EntregasChart, DisparosChart } from '../components/Charts'

export function Estatisticas() {
  const { grupos, loadingGrupos } = useApp()
  const [mov, setMov] = useState({ entradas: 0, saidas: 0 })
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const [statsDia, setStatsDia] = useState<StatDia[]>([])
  const [dispDia, setDispDia] = useState<DisparoDia[]>([])
  const dias = 7

  useEffect(() => {
    getMovimentosResumo(dias).then(setMov).catch(() => {})
  }, [dias])
  useEffect(() => {
    listAvisos().then(setAvisos).catch(() => {})
    statsDiario(14).then(setStatsDia).catch(() => {})
    disparosDiario(14).then(setDispDia).catch(() => {})
  }, [])

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
          <div className="lbl">Taxa de leitura</div>
          <div className="val" style={{ color: 'var(--blue)' }}>
            {taxaLeitura}%
          </div>
          <div className="sub">piso · 14 dias</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Entregas por dia</h2>
          <span className="mut" style={{ fontSize: 12 }}>últimos 14 dias</span>
        </div>
        {statsDia.length ? (
          <EntregasChart data={statsDia} />
        ) : (
          <p className="mut">Sem mensagens ainda.</p>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Disparos por dia</h2>
          {dispDia.length ? <DisparosChart data={dispDia} /> : <p className="mut">Sem disparos ainda.</p>}
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
    </section>
  )
}
