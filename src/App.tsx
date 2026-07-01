import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { BarChart3, Users, FolderOpen, Send, Radio, QrCode, LogOut } from 'lucide-react'
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

const TABS: { id: ViewId; label: string; Icon: typeof BarChart3 }[] = [
  { id: 'estatisticas', label: 'Estatísticas', Icon: BarChart3 },
  { id: 'grupos', label: 'Grupos', Icon: Users },
  { id: 'campanhas', label: 'Campanhas', Icon: FolderOpen },
  { id: 'novo', label: 'Novo disparo', Icon: Send },
  { id: 'disparos', label: 'Disparos', Icon: Radio },
  { id: 'conexao', label: 'Conexão', Icon: QrCode },
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

  const current = TABS.find((t) => t.id === view)!

  return (
    <AppProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="dot" />
            <div className="brand-txt">
              Gestor de Grupos <b>HX</b>
            </div>
          </div>
          <nav className="navlist">
            {TABS.map((t) => (
              <button key={t.id} className={'navitem' + (view === t.id ? ' on' : '')} onClick={() => setView(t.id)}>
                <t.Icon />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="side-foot">
            <div className="who">
              <div className="avatar">{(session.user.email || '?')[0].toUpperCase()}</div>
              <span className="who-mail" title={session.user.email}>
                {session.user.email}
              </span>
            </div>
            <button className="iconbtn" title="Sair" onClick={() => sb.auth.signOut()}>
              <LogOut size={17} />
            </button>
          </div>
        </aside>

        <div className="content">
          <div className="topbar">
            <div className="topbar-title">
              <current.Icon size={18} />
              {current.label}
            </div>
          </div>
          <main>
            {view === 'estatisticas' && <Estatisticas />}
            {view === 'grupos' && <Grupos />}
            {view === 'campanhas' && <Campanhas goTo={setView} />}
            {view === 'novo' && <NovoDisparo goTo={setView} />}
            {view === 'disparos' && <Disparos />}
            {view === 'conexao' && <Conexao />}
          </main>
        </div>
      </div>
      <Toast />
    </AppProvider>
  )
}
