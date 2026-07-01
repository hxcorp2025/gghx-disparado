import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { sb } from './lib/supabase'
import { AppProvider } from './state'
import { Login } from './components/Login'
import { Toast } from './components/Toast'
import { Estatisticas } from './views/Estatisticas'
import { Grupos } from './views/Grupos'
import { Campanhas } from './views/Campanhas'
import { NovoDisparo } from './views/NovoDisparo'
import { Disparos } from './views/Disparos'
import { Conexao } from './views/Conexao'

export type ViewId = 'estatisticas' | 'grupos' | 'campanhas' | 'novo' | 'disparos' | 'conexao'

const TABS: { id: ViewId; label: string }[] = [
  { id: 'estatisticas', label: 'Estatísticas' },
  { id: 'grupos', label: 'Grupos' },
  { id: 'campanhas', label: 'Campanhas' },
  { id: 'novo', label: 'Novo disparo' },
  { id: 'disparos', label: 'Disparos' },
  { id: 'conexao', label: 'Conexão' },
]

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<ViewId>('estatisticas')

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!ready) return null
  if (!session)
    return (
      <>
        <Login onDone={() => {}} />
        <Toast />
      </>
    )

  return (
    <AppProvider>
      <header>
        <div className="logo">
          Gestor de Grupos <b>HX</b>
        </div>
        <div className="row">
          <span className="mut">{session.user.email}</span>
          <button className="btn ghost sm" onClick={() => sb.auth.signOut()}>
            Sair
          </button>
        </div>
      </header>
      <nav>
        {TABS.map((t) => (
          <button key={t.id} className={'tab' + (view === t.id ? ' on' : '')} onClick={() => setView(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {view === 'estatisticas' && <Estatisticas />}
        {view === 'grupos' && <Grupos />}
        {view === 'campanhas' && <Campanhas goTo={setView} />}
        {view === 'novo' && <NovoDisparo goTo={setView} />}
        {view === 'disparos' && <Disparos />}
        {view === 'conexao' && <Conexao />}
      </main>
      <Toast />
    </AppProvider>
  )
}
