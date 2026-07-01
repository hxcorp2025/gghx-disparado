import { useCallback, useEffect, useRef, useState } from 'react'
import { conexaoCall } from '../lib/db'
import { toast } from '../lib/toast'

type Status = {
  ok?: boolean
  connected?: boolean
  info?: string
  error?: string
  device?: { name?: string; phone?: string }
}

const CONTAS = [{ id: 'HxSend', nome: 'HxSend' }]

export function Conexao() {
  const [conta] = useState(CONTAS[0].id)
  const [status, setStatus] = useState<Status | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const carregar = useCallback(async () => {
    setShowQr(false)
    setStatus(null)
    const s = (await conexaoCall('status')) as Status
    setStatus(s)
  }, [])

  useEffect(() => {
    carregar()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [carregar])

  async function mostrarQr() {
    const j = (await conexaoCall('qr')) as { ok?: boolean; image?: string; error?: string }
    setQr(j && j.ok && j.image ? j.image : null)
    if (!(j && j.ok && j.image)) toast('QR indisponível agora ' + (j?.error ? `(${j.error})` : ''), true)
  }

  async function conectar() {
    if (status?.connected) {
      if (!confirm('Desconectar o número atual pra conectar outro?')) return
      await conexaoCall('disconnect')
    }
    setShowQr(true)
    setQr(null)
    await mostrarQr()
    let ticks = 0
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      ticks++
      const s = (await conexaoCall('status')) as Status
      if (s?.connected) {
        if (pollRef.current) clearInterval(pollRef.current)
        setShowQr(false)
        setStatus(s)
        toast('Número conectado! 🎉')
      } else if (ticks % 4 === 0) {
        await mostrarQr()
      }
    }, 5000)
  }

  async function desconectar() {
    if (!confirm('Desconectar o número atual?')) return
    await conexaoCall('disconnect')
    toast('Desconectado')
    carregar()
  }

  const dev = status?.device || {}

  return (
    <section>
      <h2>Conexão do número (chip)</h2>
      <p className="mut" style={{ marginTop: 0 }}>
        Conecte um número novo (se o atual cair/for banido) ou desconecte o atual.
      </p>

      <div className="field" style={{ maxWidth: 320 }}>
        <label>Conta</label>
        <select value={conta} disabled>
          {CONTAS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
        <p className="mut" style={{ marginBottom: 0 }}>
          Criar novas contas/números entra na Fase 3 (Partner API).
        </p>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 16 }}>
          <div>
            {status == null ? (
              <span className="mut">
                <span className="spin" /> verificando...
              </span>
            ) : status.connected ? (
              <span>
                <span className="badge b-concluida">🟢 Conectado</span>{' '}
                {dev.name && (
                  <>
                    · <b>{dev.name}</b>
                  </>
                )}{' '}
                {dev.phone && <>· {dev.phone}</>}
              </span>
            ) : (
              <span>
                <span className="badge b-erro">🔴 Desconectado</span>{' '}
                <span className="mut">{status.info || status.error || ''}</span>
              </span>
            )}
          </div>
          <button className="btn ghost sm" onClick={carregar}>
            Atualizar
          </button>
        </div>

        <div className="row">
          <button className="btn" onClick={conectar}>
            {status?.connected ? 'Trocar número' : 'Conectar número'}
          </button>
          {status?.connected && (
            <button className="btn ghost" onClick={desconectar}>
              Desconectar
            </button>
          )}
        </div>

        {showQr && (
          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <p className="mut">
              No WhatsApp do chip: <b>Aparelhos conectados → Conectar um aparelho</b> → escaneie:
            </p>
            {qr ? (
              <img
                src={qr}
                alt="QR"
                style={{ width: 250, height: 250, borderRadius: 10, background: '#fff', padding: 8 }}
              />
            ) : (
              <span className="mut">
                <span className="spin" /> gerando QR...
              </span>
            )}
            <p className="mut" style={{ marginTop: 10 }}>
              O QR renova sozinho. Quando conectar, a tela atualiza.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
