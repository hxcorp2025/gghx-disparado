import type { LucideIcon } from 'lucide-react'

// Empty state: ícone + título + subtexto (sem emoji, jeito ferramenta pro).
export function Empty({ Icon, title, sub }: { Icon: LucideIcon; title: string; sub?: string }) {
  return (
    <div className="empty">
      <div className="empty-ico">
        <Icon size={24} />
      </div>
      <div className="empty-title">{title}</div>
      {sub && <div className="empty-sub">{sub}</div>}
    </div>
  )
}
