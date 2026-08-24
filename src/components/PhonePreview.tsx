import { AtSign } from 'lucide-react'
import { waToHtml } from '../lib/wa'
import type { BlocoUI } from './SequenciaMidia'

// O celular fixo da Mesa de Disparo (estudo UX 24/08): mostra a sequência EXATAMENTE
// como o grupo recebe — bolha por bloco, na ordem, com a copy no lugar certo (bloco
// próprio OU legenda da mídia). É a prévia fiel que o modal antigo não tinha.
export function PhonePreview({
  blocos,
  texto,
  mencao,
}: {
  blocos: BlocoUI[]
  texto: string | null
  mencao: boolean
}) {
  const copyHtml = texto ? waToHtml(texto) : ''

  function bolhaCopy(key: string) {
    return copyHtml ? (
      <div key={key} className="wa-msg" dangerouslySetInnerHTML={{ __html: copyHtml }} />
    ) : (
      <div key={key} className="wa-msg" style={{ color: '#8696a0' }}>
        Escolhe uma copy no cartão 1 pra ver a mensagem aqui…
      </div>
    )
  }

  return (
    <div className="wa-phone">
      <div className="wa-phone-head">
        <span className="gavatar">R</span>
        <span>
          Comunidade VIP
          <span className="gsub">prévia · é assim que o grupo recebe</span>
        </span>
      </div>
      <div className="wa-phone-body">
        {mencao && (
          <span className="wa-tag">
            <AtSign size={10} style={{ verticalAlign: '-1px' }} /> menciona todos os participantes
          </span>
        )}
        {blocos.map((b) => {
          if (b.tipo === 'copy') return bolhaCopy(b.key)
          const m = b.midia
          if (m.tipo === 'imagem')
            return (
              <div key={b.key} className="wa-msg media">
                <img src={m.url} alt={m.nome} />
                {b.legendaCopy && copyHtml && (
                  <div className="cap" dangerouslySetInnerHTML={{ __html: copyHtml }} />
                )}
              </div>
            )
          if (m.tipo === 'video')
            return (
              <div key={b.key} className="wa-msg media">
                <video src={m.url} controls preload="metadata" />
                {b.legendaCopy && copyHtml && (
                  <div className="cap" dangerouslySetInnerHTML={{ __html: copyHtml }} />
                )}
              </div>
            )
          return (
            <div key={b.key} className="wa-msg media">
              <audio src={m.url} controls preload="metadata" />
              <div className="cap" style={{ color: '#8696a0', fontSize: 11.5 }}>
                nota de voz{m.mimetype === 'audio/mpeg' ? ' (mp3 pode chegar como arquivo)' : ''}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
