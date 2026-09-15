import { useEffect, useState } from 'react'
import { Copy, Download, QrCode } from 'lucide-react'
import QRCode from 'qrcode'
import type { DominioEstado, LinkEstado } from '../../lib/linksDb'
import { toast } from '../../lib/toast'

// helpers compartilhados pela aba Links (lista, detalhe, editor, dominios)

export const n = (x: number | null | undefined) => (x ?? 0).toLocaleString('pt-BR')
export const pct = (x: number | null | undefined) => (x == null ? '·' : x.toFixed(1).replace('.', ',') + '%')

export function quando(iso: string | null | undefined): string {
  if (!iso) return 'nunca'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  return `há ${Math.floor(s / 86400)} d`
}

/** dd/mm hh:mm em horario de Brasilia, independente do fuso do aparelho */
export function dataBR(iso: string | null | undefined, comHora = true): string {
  if (!iso) return '·'
  const d = new Date(iso)
  const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
  if (!comHora) return dia
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
  return `${dia} ${hora}`
}

export function Ajuda({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  // <p> e nao <div>: o CSS estiliza `.ajuda p`, entao com div o bloco
  // renderiza sem cor apagada, sem a barra lateral e colado no summary
  return (
    <details className="ajuda">
      <summary>{titulo}</summary>
      <p>{children}</p>
    </details>
  )
}

/**
 * Copiar de um jeito que funcione no navegador in-app, que e onde o Peterson
 * opera. `navigator.clipboard` e undefined fora de contexto seguro e lanca
 * TypeError sincrono; sem o fallback, a tela dizia "Copiado" sobre uma area
 * de transferencia vazia.
 */
export async function copiarTexto(texto: string, campo?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto)
      return true
    }
  } catch { /* cai no fallback */ }
  if (campo) {
    try {
      campo.value = texto
      campo.removeAttribute('aria-hidden')
      campo.focus()
      campo.select()
      campo.setSelectionRange(0, 99999)
      return document.execCommand('copy')
    } catch { /* nem isso */ }
  }
  return false
}

export async function copiarComToast(texto: string, oQue = 'Link') {
  const ok = await copiarTexto(texto)
  toast(ok ? `${oQue} copiado` : 'Não consegui copiar. Toque e segure no endereço.', !ok)
  return ok
}

export const BADGE: Record<DominioEstado, { txt: string; cls: string }> = {
  pendente:    { txt: 'preparando',            cls: 'b-rascunho' },
  // o nome diz de quem é a vez: o sistema já fez a parte dele
  verificando: { txt: 'esperando você apontar', cls: 'b-agendado' },
  ativo:       { txt: 'ativo',               cls: 'b-concluida' },
  pausado:     { txt: 'fora do rodízio',     cls: 'b-rascunho' },
  suspeito:    { txt: 'suspeito',            cls: 'b-agendado' },
  banido:      { txt: 'banido',              cls: 'b-erro' },
  removido:    { txt: 'removido',            cls: 'b-rascunho' },
}

export const ESTADO_LINK: Record<LinkEstado, { txt: string; cls: string }> = {
  ativo:     { txt: 'no ar',     cls: 'b-concluida' },
  pausado:   { txt: 'pausado',   cls: 'b-erro' },
  congelado: { txt: 'congelado', cls: 'b-rodando' },
  expirado:  { txt: 'expirado',  cls: 'b-agendado' },
}

/** sete dias de cliques em 44x18px: o formato de uma linha da lista */
export function Sparkline({ pontos, largura = 64, altura = 20 }: { pontos: number[]; largura?: number; altura?: number }) {
  const ps = pontos?.length ? pontos : [0, 0, 0, 0, 0, 0, 0]
  const max = Math.max(1, ...ps)
  const passo = ps.length > 1 ? largura / (ps.length - 1) : largura
  const y = (v: number) => altura - 2 - (v / max) * (altura - 4)
  const linha = ps.map((v, i) => `${(i * passo).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `0,${altura} ${linha} ${((ps.length - 1) * passo).toFixed(1)},${altura}`
  const ult = ps[ps.length - 1]
  return (
    <svg className="spark" width={largura} height={altura} viewBox={`0 0 ${largura} ${altura}`} aria-hidden="true">
      <polygon points={area} className="spark-area" />
      <polyline points={linha} className="spark-line" fill="none" />
      <circle cx={((ps.length - 1) * passo).toFixed(1)} cy={y(ult).toFixed(1)} r="2" className="spark-dot" />
    </svg>
  )
}

/**
 * QR gerado no navegador (biblioteca `qrcode`, sem request externo). Escuro
 * sobre branco de proposito: e o unico contraste que todo leitor de QR le,
 * inclusive impresso.
 */
export function QrBox({ url, nome }: { url: string; nome: string }) {
  const [png, setPng] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  useEffect(() => {
    let vivo = true
    QRCode.toDataURL(url, { margin: 1, width: 256, errorCorrectionLevel: 'M', color: { dark: '#08090b', light: '#ffffff' } })
      .then((d) => { if (vivo) setPng(d) })
      .catch((e) => { if (vivo) setErro(e instanceof Error ? e.message : 'Não consegui gerar o QR.') })
    return () => { vivo = false }
  }, [url])

  const baixar = async (tipo: 'png' | 'svg') => {
    const base = nome.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'link'
    let href: string
    if (tipo === 'png') {
      if (!png) return
      href = png
    } else {
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#08090b', light: '#ffffff' } })
      href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    }
    const a = document.createElement('a')
    a.href = href
    a.download = `qr-${base}.${tipo}`
    a.click()
    if (tipo === 'svg') setTimeout(() => URL.revokeObjectURL(href), 1000)
  }

  return (
    <div className="qrbox">
      {png ? <img src={png} alt={`QR do link ${url}`} width={160} height={160} /> : <div className="skel" style={{ width: 160, height: 160 }} />}
      <div className="qr-acoes">
        <span className="mut" style={{ fontSize: 12 }}>Aponta a câmera: abre {url.replace(/^https?:\/\//, '')}</span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn ghost sm" onClick={() => baixar('png')} disabled={!png}><Download size={13} />PNG</button>
          <button className="btn ghost sm" onClick={() => baixar('svg')}><Download size={13} />SVG</button>
        </div>
        {erro && <span className="st-falha" style={{ fontSize: 12 }}>{erro}</span>}
      </div>
    </div>
  )
}

/** a URL curta com copiar e QR: aparece na lista e no topo do detalhe */
export function UrlCurta({ url, nome, hero = false }: { url: string | null; nome: string; hero?: boolean }) {
  const [qr, setQr] = useState(false)
  if (!url) return <span className="mut" style={{ fontSize: 12.5 }}>sem URL ativa (nenhum domínio no ar)</span>
  return (
    <div>
      <div className={'urlbox' + (hero ? ' hero' : '')}>
        <code>{url.replace(/^https:\/\//, '')}</code>
        <button className="btn ghost sm" onClick={() => copiarComToast(url)} title="Copiar">
          <Copy size={13} />{hero && 'Copiar'}
        </button>
        <button className={'btn ghost sm' + (qr ? ' on' : '')} onClick={() => setQr(!qr)} title="QR code" aria-pressed={qr}>
          <QrCode size={13} />{hero && 'QR'}
        </button>
      </div>
      {qr && <QrBox url={url} nome={nome} />}
    </div>
  )
}

/** lista horizontal de barras: a forma de ler uma dimensao sem pizza */
export function Barras({ itens, total, vazio = 'Nada ainda.' }: {
  itens: { k: string; n: number; pct: number | null }[]; total: number; vazio?: string
}) {
  if (!itens.length || total === 0) return <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>{vazio}</p>
  const max = Math.max(1, ...itens.map((i) => i.n))
  return (
    <div className="barlist">
      {itens.map((i) => (
        <div className="bar" key={i.k}>
          <span className="bar-k" title={i.k}>{i.k}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(100 * i.n) / max}%` }} /></span>
          <span className="bar-n">{n(i.n)}</span>
          <span className="bar-pct">{pct(i.pct)}</span>
        </div>
      ))}
    </div>
  )
}
