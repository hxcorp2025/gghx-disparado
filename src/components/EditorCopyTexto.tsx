import { useState } from 'react'
import { Check } from 'lucide-react'
import { copyEditar } from '../lib/copyDb'
import { toast } from '../lib/toast'

// Editor de variação (PRD_copyia_editar_variacao_2026-08-31): o caminho do meio que o
// Peterson pediu — copy boa com detalhe errado se AJUSTA, não se cancela. Salvar já
// aprova; se a edição quebrar regra da casa (travessão etc.) o banco recusa e nada muda.
export function EditorCopyTexto({
  id,
  textoAtual,
  onSalvo,
  onFechar,
}: {
  id: number
  textoAtual: string
  onSalvo: () => void
  onFechar: () => void
}) {
  const [texto, setTexto] = useState(textoAtual)
  const [salvando, setSalvando] = useState(false)

  const limpo = texto.trim()
  const podeSalvar = !salvando && limpo.length >= 10 && limpo.length <= 1000 && limpo !== textoAtual.trim()

  async function salvar() {
    if (!podeSalvar) return
    setSalvando(true)
    try {
      await copyEditar(id, texto)
      toast('Copy ajustada e aprovada')
      onSalvo()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="field" style={{ margin: '10px 0 0' }}>
      <label htmlFor={`edcopy-${id}`}>
        Ajustar o texto{' '}
        <span className="mut" style={{ fontWeight: 400 }}>
          (salvar já aprova · regras da casa continuam valendo · não muda disparo já armado ou feito)
        </span>
      </label>
      <textarea
        id={`edcopy-${id}`}
        rows={9}
        value={texto}
        autoFocus
        onChange={(e) => setTexto(e.target.value)}
      />
      <div className="row between" style={{ marginTop: 8 }}>
        <span className="mut" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {limpo.length} chars {limpo.length > 1000 ? '· passou de 1000' : ''}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={!podeSalvar} onClick={salvar}>
            <Check size={14} /> {salvando ? 'Salvando…' : 'Salvar e aprovar'}
          </button>
          <button className="btn ghost sm" disabled={salvando} onClick={onFechar}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
