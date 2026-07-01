import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../state'
import { getMovimentosResumo, listAvisos, listDisparos } from '../lib/db'
import type { Aviso } from '../lib/db'
import type { Disparo } from '../lib/types'

export function Estatisticas() {
  const { grupos } = useApp()
  const [mov, setMov] = useState({ entradas: 0, saidas: 0 })
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const [disparos, setDisparos] = useState<Disparo[]>([])
  const [dias, setDias] = useState(7)

  useEffect(() => {
    getMovimentosResumo(dias).then(setMov).catch(() => {})
  }, [dias])
  useEffect(() => {
    listAvisos().then(setAvisos).catch(() => {})
    listDisparos(200).then(setDisparos).catch(() => {})
  }, [])

  const gruposAtivos = grupos.length
  const avisosCount = grupos.filter((g) => g.is_announcement === true).length
  const pessoas = grupos.reduce((n, g) => n + (g.participantes || 0), 0)
  const saldo = mov.entradas - mov.saidas

  // disparos por dia (BR), ordenado do mais recente pro mais antigo
  const porDia = useMemo(() => {
    const m: Record<string, { n: number; ts: number }> = {}
    disparos.forEach((d) => {
      if (!d.criado_em) return
      const date = new Date(d.criado_em)
      const dia = date.toLocaleDateString('pt-BR')
      if (!m[dia]) m[dia] = { n: 0, ts: date.getTime() }
      m[dia].n++
      m[dia].ts = Math.max(m[dia].ts, date.getTime())
    })
    return Object.entries(m)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 14)
      .map(([dia, v]) => [dia, v.n] as [string, number])
  }, [disparos])

  return (
    <section>
      <h2>Estatísticas</h2>

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
          <div className="lbl">Saldo</div>
          <div className="val" style={{ color: saldo >= 0 ? 'var(--accent)' : 'var(--red)' }}>
            {saldo >= 0 ? '+' : ''}
            {saldo}
          </div>
          <div className="sub">{dias} dias</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <span className="mut">Período do saldo:</span>
        <select style={{ width: 'auto' }} value={dias} onChange={(e) => setDias(+e.target.value)}>
          <option value={1}>24h</option>
          <option value={7}>7 dias</option>
          <option value={30}>30 dias</option>
        </select>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Disparos por dia</h2>
          {!porDia.length && <p className="mut">Sem disparos ainda.</p>}
          <table>
            <tbody>
              {porDia.map(([dia, n]) => (
                <tr key={dia}>
                  <td>{dia}</td>
                  <td style={{ textAlign: 'right' }}>
                    <b>{n}</b> disparo(s)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Avisos (chip / conexão)</h2>
          {!avisos.length && <p className="mut">Sem avisos recentes.</p>}
          <div className="scroll" style={{ maxHeight: '40vh', border: 'none' }}>
            <table>
              <tbody>
                {avisos.map((a) => {
                  const desconectou = a.evento === 'disconnected'
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className={'badge b-' + (desconectou ? 'erro' : 'concluida')}>
                          {desconectou ? '🔴 caiu' : '🟢 conectou'}
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
