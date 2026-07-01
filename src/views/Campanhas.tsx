import { useEffect, useState } from 'react'
import type { ViewId } from '../App'
import { useApp } from '../state'
import { listCampanhas, deleteCampanha, updateCampanha } from '../lib/db'
import { toast } from '../lib/toast'
import type { Campanha } from '../lib/types'

export function Campanhas({ goTo }: { goTo: (v: ViewId) => void }) {
  const { grupos, setSelected } = useApp()
  const [lista, setLista] = useState<Campanha[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | null>(null)
  const [editIds, setEditIds] = useState<string[]>([])

  async function reload() {
    setLoading(true)
    try {
      setLista(await listCampanhas())
    } catch (e) {
      toast('Erro: ' + (e as Error).message, true)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    reload()
  }, [])

  const nomeGrupo = (gid: string) => grupos.find((g) => g.group_id === gid)?.subject || gid

  function carregar(c: Campanha) {
    setSelected(new Set(c.group_ids))
    toast(`${c.group_ids.length} grupos carregados de "${c.nome}"`)
    goTo('grupos')
  }

  async function excluir(id: number) {
    if (!confirm('Excluir esta campanha?')) return
    await deleteCampanha(id)
    reload()
  }

  function abrirEdicao(c: Campanha) {
    setEditId(c.id)
    setEditIds([...c.group_ids])
  }

  async function salvarEdicao() {
    if (editId == null) return
    try {
      await updateCampanha(editId, editIds)
      toast('Campanha atualizada')
      setEditId(null)
      reload()
    } catch (e) {
      toast('Erro: ' + (e as Error).message, true)
    }
  }

  return (
    <section>
      <div className="toolbar between">
        <div>
          <h2 style={{ margin: 0 }}>Campanhas</h2>
          <p className="mut" style={{ margin: '4px 0 0' }}>
            Listas de grupos reutilizáveis. Crie na aba Grupos ("Salvar como campanha"); use no Novo disparo.
          </p>
        </div>
        <button className="btn ghost sm" onClick={reload}>
          Atualizar
        </button>
      </div>

      {loading && <p className="mut">Carregando...</p>}
      {!loading && !lista.length && <p className="mut">Nenhuma campanha salva ainda.</p>}

      {lista.map((c) => (
        <div key={c.id}>
          <div className="listrow">
            <div>
              <b>{c.nome}</b>
              <div className="mut">{c.group_ids.length} grupos</div>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => carregar(c)}>
                Carregar
              </button>
              <button className="btn ghost sm" onClick={() => abrirEdicao(c)}>
                Editar
              </button>
              <button className="btn ghost sm" onClick={() => excluir(c.id)}>
                Excluir
              </button>
            </div>
          </div>

          {editId === c.id && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <b>Editando "{c.nome}" · {editIds.length} grupos</b>
                <div className="row">
                  <button className="btn sm" onClick={salvarEdicao}>
                    Salvar
                  </button>
                  <button className="btn ghost sm" onClick={() => setEditId(null)}>
                    Cancelar
                  </button>
                </div>
              </div>
              <div className="scroll" style={{ maxHeight: '40vh' }}>
                <table>
                  <tbody>
                    {editIds.map((gid) => (
                      <tr key={gid}>
                        <td>{nomeGrupo(gid)}</td>
                        <td style={{ width: 90, textAlign: 'right' }}>
                          <button
                            className="btn ghost sm"
                            onClick={() => setEditIds(editIds.filter((x) => x !== gid))}
                          >
                            Remover
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!editIds.length && <p className="mut">Sem grupos. Salvar assim vai deixar a campanha vazia.</p>}
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
