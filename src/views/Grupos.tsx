import { useMemo, useState } from 'react'
import { Users } from 'lucide-react'
import { useApp } from '../state'
import { syncGrupos, createCampanha } from '../lib/db'
import { toast } from '../lib/toast'
import { SkeletonList, SkeletonCards } from '../components/Skeleton'
import { Empty } from '../components/Empty'
import type { Grupo } from '../lib/types'

type Filtro = 'avisos' | 'todos'

export function Grupos() {
  const { grupos, loadingGrupos, reloadGrupos, selected, toggle, setSelected } = useApp()
  const [q, setQ] = useState('')
  const [filtro, setFiltro] = useState<Filtro>('avisos')
  const [syncing, setSyncing] = useState(false)

  const visiveis = useMemo(() => {
    const ql = q.toLowerCase()
    return grupos.filter(
      (g) =>
        (!ql || (g.subject || '').toLowerCase().includes(ql)) &&
        (filtro !== 'avisos' || g.is_announcement === true),
    )
  }, [grupos, q, filtro])

  const base = filtro === 'avisos' ? grupos.filter((g) => g.is_announcement === true) : grupos
  const pessoas = base.reduce((n, g) => n + (g.participantes || 0), 0)
  const lidos = base.filter((g) => g.participantes != null).length
  const parcial = lidos < base.length

  async function doSync() {
    setSyncing(true)
    try {
      const j = await syncGrupos()
      toast('Sincronizado: ' + (j.grupos != null ? j.grupos : '?') + ' grupos')
      await reloadGrupos()
    } catch {
      toast('Erro ao sincronizar', true)
    } finally {
      setSyncing(false)
    }
  }

  function selAll(check: boolean) {
    const n = new Set(selected)
    visiveis.forEach((g) => (check ? n.add(g.group_id) : n.delete(g.group_id)))
    setSelected(n)
  }

  async function salvarComoCampanha() {
    if (!selected.size) return toast('Selecione grupos primeiro', true)
    const nome = prompt('Nome da campanha (ex: VIPs ativos):')
    if (!nome) return
    try {
      await createCampanha(nome, [...selected])
      toast(`Campanha "${nome}" salva (${selected.size} grupos)`)
    } catch (e) {
      toast('Erro: ' + (e as Error).message, true)
    }
  }

  function tag(g: Grupo) {
    if (g.is_announcement == null) return null
    return g.is_announcement || g.community_id ? (
      <span className="gtag gtag-com">Comunidade</span>
    ) : (
      <span className="gtag gtag-grp">Grupo</span>
    )
  }

  if (loadingGrupos && !grupos.length) {
    return (
      <section>
        <SkeletonCards n={2} />
        <SkeletonList rows={7} />
      </section>
    )
  }

  return (
    <section>
      <div className="statcards">
        <div className="statcard">
          <div className="lbl">{filtro === 'avisos' ? 'Grupos de avisos' : 'Grupos ativos'}</div>
          <div className="val">{base.length}</div>
          <div className="sub">{filtro === 'avisos' ? 'comunidades' : 'deste número'}</div>
        </div>
        <div className="statcard sc-pessoas">
          <div className="lbl">Total de pessoas</div>
          <div className="val">
            {pessoas.toLocaleString('pt-BR')}
            {parcial && <span style={{ fontSize: 13, color: 'var(--amber)' }}> +</span>}
          </div>
          <div className="sub">
            {lidos}/{base.length} grupos lidos{parcial ? ' (enchendo…)' : ''}
          </div>
        </div>
      </div>

      <div className="toolbar between">
        <div className="row">
          <input className="search" placeholder="Buscar grupo..." value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ width: 'auto' }} value={filtro} onChange={(e) => setFiltro(e.target.value as Filtro)}>
            <option value="avisos">Só grupos de avisos</option>
            <option value="todos">Todos os grupos</option>
          </select>
          <span className="count-pill">
            <b>{selected.size}</b> selecionados
          </span>
        </div>
        <div className="row">
          <button className="btn ghost sm" disabled={syncing} onClick={doSync}>
            {syncing ? <span className="spin" /> : 'Sincronizar grupos'}
          </button>
          <button className="btn ghost sm" onClick={salvarComoCampanha}>
            Salvar como campanha
          </button>
        </div>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 42 }}>
                <input
                  type="checkbox"
                  title="Marca/desmarca os grupos visíveis"
                  checked={visiveis.length > 0 && visiveis.every((g) => selected.has(g.group_id))}
                  onChange={(e) => selAll(e.target.checked)}
                />
              </th>
              <th>Grupo</th>
              <th style={{ width: 120 }}>Participantes</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((g) => (
              <tr key={g.group_id}>
                <td>
                  <input type="checkbox" checked={selected.has(g.group_id)} onChange={() => toggle(g.group_id)} />
                </td>
                <td>
                  {g.subject || '(sem nome)'}
                  {tag(g)}
                  <div className="gid">{g.group_id}</div>
                </td>
                <td>{g.participantes != null ? g.participantes : '·'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visiveis.length && (
        <Empty
          Icon={Users}
          title={filtro === 'avisos' ? 'Nenhum grupo de avisos ainda' : 'Nenhum grupo ainda'}
          sub={
            filtro === 'avisos'
              ? 'Clique em "Sincronizar grupos" para importar, ou troque para "Todos os grupos".'
              : 'Clique em "Sincronizar grupos" para importar os grupos do número conectado.'
          }
        />
      )}
    </section>
  )
}
