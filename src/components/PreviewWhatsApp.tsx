import { waToHtml } from '../lib/wa'

// Renderiza como a mensagem aparece no WhatsApp (formatação + links).
export function PreviewWhatsApp({ texto, mediaTipo }: { texto: string; mediaTipo?: string }) {
  const html = waToHtml(texto)
  return (
    <div className="wa-preview">
      <div className="wa-bubble">
        {mediaTipo && mediaTipo !== 'texto' && (
          <div
            className="mut"
            style={{ fontSize: 12, marginBottom: 6, color: '#8696a0' }}
          >
            [{mediaTipo === 'audio' ? 'áudio (nota de voz)' : mediaTipo}]
          </div>
        )}
        {html ? (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span style={{ color: '#8696a0' }}>Pré-visualização da mensagem aparece aqui…</span>
        )}
      </div>
    </div>
  )
}
