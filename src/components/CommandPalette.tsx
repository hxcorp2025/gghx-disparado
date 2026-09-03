import { Command } from 'cmdk'
import { useEffect, useState } from 'react'
import { BarChart3, Users, FolderOpen, Send, Radio, QrCode, LogOut, Wrench, Sparkles, Rocket, Link2 } from 'lucide-react'
import type { ViewId } from '../App'

type Item = { icon: typeof BarChart3; label: string; act: () => void; group: string }

export function CommandPalette({
  onNavigate,
  onLogout,
}: {
  onNavigate: (v: ViewId) => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  const go = (v: ViewId) => {
    onNavigate(v)
    setOpen(false)
  }

  const items: Item[] = [
    { icon: BarChart3, label: 'Estatísticas', act: () => go('estatisticas'), group: 'Navegar' },
    { icon: Users, label: 'Grupos', act: () => go('grupos'), group: 'Navegar' },
    { icon: FolderOpen, label: 'Campanhas', act: () => go('campanhas'), group: 'Navegar' },
    { icon: Send, label: 'Novo disparo', act: () => go('novo'), group: 'Navegar' },
    { icon: Link2, label: 'Links', act: () => go('links'), group: 'Navegar' },
    { icon: Sparkles, label: 'Copy com IA', act: () => go('copyia'), group: 'Navegar' },
    { icon: Rocket, label: 'Disparar cópias', act: () => go('disparoia'), group: 'Navegar' },
    { icon: Radio, label: 'Disparos', act: () => go('disparos'), group: 'Navegar' },
    { icon: Wrench, label: 'Ferramentas', act: () => go('extras'), group: 'Navegar' },
    { icon: QrCode, label: 'Conexão', act: () => go('conexao'), group: 'Navegar' },
    {
      icon: LogOut,
      label: 'Sair',
      act: () => {
        setOpen(false)
        onLogout()
      },
      group: 'Conta',
    },
  ]

  if (!open) return null
  const groups = [...new Set(items.map((i) => i.group))]

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div className="cmdk-box" onClick={(e) => e.stopPropagation()}>
        <Command label="Comandos">
          <Command.Input placeholder="Buscar ação ou navegar..." autoFocus />
          <Command.List>
            <Command.Empty>Nada encontrado.</Command.Empty>
            {groups.map((g) => (
              <Command.Group key={g} heading={g}>
                {items
                  .filter((i) => i.group === g)
                  .map((it) => (
                    <Command.Item key={it.label} value={it.label} onSelect={it.act}>
                      <it.icon size={16} />
                      {it.label}
                    </Command.Item>
                  ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
