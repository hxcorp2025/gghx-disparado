import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { saudeChip } from '../lib/db'
import type { SaudeChip as Saude } from '../lib/db'

function nivel(s: Saude): { cor: string; label: string } {
  const ph = s.limite_hora ? s.enviadas_hora / s.limite_hora : 0
  const pd = s.limite_dia ? s.enviadas_24h / s.limite_dia : 0
  if (s.status === 'disconnected' || ph >= 1 || pd >= 1) return { cor: 'var(--red)', label: 'Crítico' }
  if (ph >= 0.8 || pd >= 0.8) return { cor: 'var(--amber)', label: 'Atenção' }
  return { cor: 'var(--accent)', label: 'Saudável' }
}

function Barra({ n, total, cor }: { n: number; total: number; cor: string }) {
  const pct = total ? Math.min(100, Math.round((n / total) * 100)) : 0
  return (
    <div>
      <div className="row between" style={{ marginBottom: 5 }}>
        <span className="mut" style={{ fontSize: 12 }}>
          {n.toLocaleString('pt-BR')} / {total.toLocaleString('pt-BR')}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: cor }}>{pct}%</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: 'var(--surface2)', overflow: 'hidden' }}>
        <div style={{ width: pct + '%', height: '100%', background: cor, transition: 'width .3s ease' }} />
      </div>
    </div>
  )
}

export function SaudeChipPanel() {
  const [dados, setDados] = useState<Saude[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    saudeChip()
      .then(setDados)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="skel" style={{ height: 150, borderRadius: 'var(--r-card)', marginBottom: 16 }} />
  if (!dados.length) return null

  return (
    <>
      {dados.map((s) => {
        const nv = nivel(s)
        const txEntrega = s.enviadas_24h ? Math.round((s.entregues_24h / s.enviadas_24h) * 100) : 0
        const txLeitura = s.enviadas_24h ? Math.round((s.lidas_24h / s.enviadas_24h) * 100) : 0
        return (
          <div className="card" key={s.conta_id} style={{ marginBottom: 16 }}>
            <div className="row between" style={{ marginBottom: 16 }}>
              <div className="row" style={{ gap: 8 }}>
                <Activity size={17} style={{ color: nv.cor }} />
                <b>Saúde do chip · {s.nome}</b>
              </div>
              <span
                className="badge"
                style={{ background: 'color-mix(in srgb, ' + nv.cor + ' 15%, transparent)', color: nv.cor }}
              >
                ● {nv.label}
              </span>
            </div>

            <div className="grid2" style={{ marginBottom: 4 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: 12 }}>Envios na última hora</label>
                <Barra n={s.enviadas_hora} total={s.limite_hora} cor={nv.cor} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: 12 }}>Envios nas últimas 24h</label>
                <Barra n={s.enviadas_24h} total={s.limite_dia} cor={nv.cor} />
              </div>
            </div>

            <div className="statcards" style={{ marginTop: 16, marginBottom: 0 }}>
              <div className="statcard">
                <div className="lbl">Entrega 24h</div>
                <div className="val" style={{ fontSize: 22, color: 'var(--accent)' }}>{txEntrega}%</div>
                <div className="sub">{s.entregues_24h} de {s.enviadas_24h}</div>
              </div>
              <div className="statcard">
                <div className="lbl">Leitura 24h</div>
                <div className="val" style={{ fontSize: 22, color: 'var(--blue)' }}>{txLeitura}%</div>
                <div className="sub">piso · {s.lidas_24h} lidas</div>
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
