import { useState } from 'react'
import { sb } from '../lib/supabase'

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function entrar() {
    setErr('')
    setBusy(true)
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pass })
    setBusy(false)
    if (error) {
      setErr('Falha no login: ' + error.message)
      return
    }
    onDone()
  }

  return (
    <div id="login">
      <div className="box card">
        <div className="logo" style={{ marginBottom: 6 }}>
          <span className="dot" />
          Gestor de Grupos <b>HX</b>
        </div>
        <p className="mut" style={{ margin: '0 0 18px' }}>
          Disparador interno · acesso restrito
        </p>
        <div className="field">
          <label>E-mail</label>
          <input
            type="email"
            autoComplete="username"
            placeholder="voce@hookmidia.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Senha</label>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && entrar()}
          />
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={entrar}>
          {busy ? <span className="spin" /> : 'Entrar'}
        </button>
        <p className="mut" style={{ color: 'var(--red)', margin: '12px 0 0', minHeight: 18 }}>
          {err}
        </p>
      </div>
    </div>
  )
}
