import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listDisparos,
  getDisparoItens,
  getDisparoMetrics,
  setDisparoStatus,
  retomarDisparo,
  reenviarItens,
  chamarMotor,
} from '../lib/db'
import type { DisparoMetrics } from '../lib/db'
import { Radio } from 'lucide-react'
import { toast } from '../lib/toast'
import { SkeletonList } from '../components/Skeleton'
import { Empty } from '../components/Empty'
import type { Disparo, DisparoItem } from '../lib/types'

function dur(ini: string | null, fim: string | null): string {
  if (!ini) return '·'
  const a = new Date(ini).getTime()
  const b = (fim ? new Date(fim) : new Date()).getTime()
  const s = Math.max(0, Math.round((b - a) / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}min ${s % 60}s` : `${s}s`
}

export function Disparos() {
  const [lista, setLista] = useState<Disparo[]>([])
  const [loading, setLoading] = useState(true)
  const [abertoId, setAbertoId] = useState<number | null>(null)
  const [itens, setItens] = useState<DisparoItem[]>([])
  const [metrics, setMetrics] = useState<DisparoMetrics | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abrirSeq = useRef(0)

  const reload = useCallback(async () => {
    try {
      const d = await listDisparos()
      setLista(d)
      if (pollRef.current) clearTimeout(pollRef.current)
      if (d.some((c) => c.status === 'rodando')) pollRef.current = setTimeout(reload, 5000)
    } catch (e) {
      toast('Erro: ' + (e as Error).message, true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [reload])

  async function abrir(id: number) {
    const seq = ++abrirSeq.current
    setAbertoId(id)
    setMetrics(null)
    setItens([])
    const its = await getDisparoItens(id)
    if (seq !== abrirSeq.current) return // chegou resposta de um clique antigo → ignora
    setItens(its)
    getDisparoMetrics(id)
      .then((m) => seq === abrirSeq.current && setMetrics(m))
      .catch(() => {})
  }

  async function pausar(id: number) {
    await setDisparoStatus(id, 'pausada')
    toast('Disparo pausado (o motor para no próximo grupo).')
    reload()
  }
  async function despausar(id: number) {
    const r = await retomarDisparo(id).catch(() => null)
    toast(r && r.ok ? 'Retomado' : 'Falha ao retomar', !(r && r.ok))
    setTimeout(reload, 3000)
  }
  async function cancelar(id: number) {
    if (!confirm('Cancelar este disparo? Os grupos ainda não enviados NÃO recebem.')) return
    await setDisparoStatus(id, 'cancelada')
    toast('Disparo cancelado')
    reload()
  }
  async function retomarDraft(id: number) {
    const r = await chamarMotor(id).catch(() => null)
    toast(r && r.ok ? 'Iniciado' : 'Falha', !(r && r.ok))
    setTimeout(reload, 3000)
  }
  async function reenviar(id: number, de: 'falha' | 'pulado') {
    const msg =
      de === 'pulado'
        ? 'Reenviar nos grupos PULADOS? Eles foram pulados por estarem sem lista lida (menção fantasma). Se ainda estiverem sem lista, o motor pula de novo (não força @all).'
        : 'Reenviar só nos grupos que FALHARAM? Vai tentar de novo o envio neles.'
    if (!confirm(msg)) return
    const r = await reenviarItens(id, de).catch(() => null)
    toast(r && r.ok ? `Reenvio dos ${de} iniciado` : 'Falha', !(r && r.ok))
    setTimeout(() => {
      reload()
      abrir(id)
    }, 3000)
  }

  const falhas = itens.filter((i) => i.status === 'falha').length
  const pulados = itens.filter((i) => i.status === 'pulado').length

  return (
    <section>
      <div className="toolbar between">
        <h2 style={{ margin: 0 }}>Disparos</h2>
        <button className="btn ghost sm" onClick={reload}>
          Atualizar
        </button>
      </div>

      {loading && <SkeletonList rows={5} height={62} />}
      {!loading && !lista.length && (
        <Empty Icon={Radio} title="Nenhum disparo ainda" sub="Crie um disparo na aba Novo disparo. Ele aparece aqui com o acompanhamento em tempo real." />
      )}

      {lista.map((c) => {
        const rodando = c.status === 'rodando'
        const pausada = c.status === 'pausada'
        return (
          <div className="listrow" key={c.id}>
            <div>
              <b>
                #{c.id} {c.nome || '(sem nome)'}
              </b>{' '}
              <span className={'badge b-' + c.status}>{c.status}</span>
              <div className="mut">
                {c.status === 'agendado' && c.scheduled_at ? (
                  <>📅 agendado para {new Date(c.scheduled_at).toLocaleString('pt-BR')} · {c.total || 0} grupos</>
                ) : (
                  <>
                    {c.enviados || 0}/{c.total || 0} enviados
                    {c.falhas ? ` · ${c.falhas} falhas` : ''} ·{' '}
                    {c.criado_em ? new Date(c.criado_em).toLocaleString('pt-BR') : ''} ·{' '}
                    {dur(c.iniciado_em, c.concluido_em)}
                  </>
                )}
              </div>
            </div>
            <div className="row">
              {rodando && (
                <button className="btn ghost sm" onClick={() => pausar(c.id)}>
                  Pausar
                </button>
              )}
              {pausada && (
                <button className="btn sm" onClick={() => despausar(c.id)}>
                  Despausar
                </button>
              )}
              {(c.status === 'rascunho' || c.status === 'erro') && (
                <button className="btn sm" onClick={() => retomarDraft(c.id)}>
                  Iniciar
                </button>
              )}
              {c.status !== 'concluida' && c.status !== 'cancelada' && (
                <button className="btn ghost sm" onClick={() => cancelar(c.id)}>
                  Cancelar
                </button>
              )}
              <button className="btn ghost sm" onClick={() => abrir(c.id)}>
                Ver grupos
              </button>
            </div>
          </div>
        )
      })}

      {abertoId != null && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <h2 style={{ margin: 0 }}>Disparo #{abertoId} · grupos</h2>
            <div className="row" style={{ gap: 6 }}>
              {falhas > 0 && (
                <button className="btn sm" onClick={() => reenviar(abertoId, 'falha')}>
                  Reenviar falhas ({falhas})
                </button>
              )}
              {pulados > 0 && (
                <button className="btn sm" onClick={() => reenviar(abertoId, 'pulado')}>
                  Reenviar pulados ({pulados})
                </button>
              )}
            </div>
          </div>

          {metrics && (
            <div className="statcards" style={{ marginBottom: 14 }}>
              <div className="statcard">
                <div className="lbl">Enviadas</div>
                <div className="val">{metrics.enviadas}</div>
                <div className="sub">mensagens no grupo</div>
              </div>
              <div className="statcard sc-in">
                <div className="lbl">Entregues</div>
                <div className="val" style={{ color: 'var(--accent)' }}>
                  {metrics.entregues}
                </div>
                <div className="sub">
                  {metrics.enviadas ? Math.round((metrics.entregues / metrics.enviadas) * 100) : 0}%
                </div>
              </div>
              <div className="statcard sc-pessoas">
                <div className="lbl">Lidas</div>
                <div className="val" style={{ color: 'var(--blue)' }}>
                  {metrics.lidas}
                </div>
                <div className="sub">
                  piso ·{' '}
                  {metrics.enviadas ? Math.round((metrics.lidas / metrics.enviadas) * 100) : 0}%
                </div>
              </div>
            </div>
          )}
          {metrics && (
            <p className="mut" style={{ marginTop: 0, fontSize: 12 }}>
              Em grupo, "entregue/lido" é agregado (o WhatsApp não dá leitura por pessoa) e "lido" é um
              piso. Quem desliga o tique azul lê e não conta.
            </p>
          )}

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Grupo</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 170 }}>Enviado / motivo</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((it) => (
                  <tr key={it.id}>
                    <td>{it.subject || it.group_id}</td>
                    <td className={'st-' + it.status}>{it.status}</td>
                    <td className="mut">
                      {it.enviado_em
                        ? new Date(it.enviado_em).toLocaleTimeString('pt-BR')
                        : it.erro
                          ? it.erro.slice(0, 40)
                          : '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
