import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { listGrupos } from './lib/db'
import { toast } from './lib/toast'
import type { Grupo } from './lib/types'

type AppState = {
  grupos: Grupo[]
  loadingGrupos: boolean
  reloadGrupos: () => Promise<void>
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  toggle: (id: string) => void
  clearSel: () => void
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [grupos, setGrupos] = useState<Grupo[]>([])
  const [loadingGrupos, setLoading] = useState(false)
  const [selected, setSelectedState] = useState<Set<string>>(new Set())

  const reloadGrupos = useCallback(async () => {
    setLoading(true)
    try {
      setGrupos(await listGrupos())
    } catch (e) {
      toast('Erro ao carregar grupos: ' + (e as Error).message, true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reloadGrupos()
  }, [reloadGrupos])

  const setSelected = useCallback((s: Set<string>) => setSelectedState(new Set(s)), [])
  const toggle = useCallback((id: string) => {
    setSelectedState((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }, [])
  const clearSel = useCallback(() => setSelectedState(new Set()), [])

  const value = useMemo(
    () => ({ grupos, loadingGrupos, reloadGrupos, selected, setSelected, toggle, clearSel }),
    [grupos, loadingGrupos, reloadGrupos, selected, setSelected, toggle, clearSel],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApp fora do AppProvider')
  return c
}
