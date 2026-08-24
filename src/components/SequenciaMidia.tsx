import { useEffect, useRef, useState } from 'react'
import { Paperclip, Upload, ArrowUp, ArrowDown, X, Trash2, Mic, Film, Image as ImgIcon, FileText } from 'lucide-react'
import { listMidias, uploadMidia, desativarMidia, tamanhoLegivel, LIMITES } from '../lib/midiaDb'
import type { Midia } from '../lib/midiaDb'
import { toast } from '../lib/toast'

// Sequência do disparo (PRD_send_upload_midia_2026-08-24): o disparo vira uma lista
// ordenada de blocos — mídias da biblioteca + a copy da variação. A copy mora em
// EXATAMENTE um lugar: bloco próprio OU legenda de uma mídia (imagem/vídeo).
export type BlocoUI =
  | { key: string; tipo: 'copy' }
  | { key: string; tipo: 'midia'; midia: Midia; legendaCopy: boolean }

export function blocosParaRpc(blocos: BlocoUI[]) {
  // sequência só-copy = disparo de texto puro (fluxo original)
  if (blocos.length === 1 && blocos[0].tipo === 'copy') return null
  return blocos.map((b) =>
    b.tipo === 'copy'
      ? { tipo: 'copy' as const }
      : { tipo: 'midia' as const, midia_id: b.midia.id, legenda_copy: b.legendaCopy },
  )
}

export function sequenciaValida(blocos: BlocoUI[]): string | null {
  if (blocos.length > 6) return 'Máximo de 6 blocos por disparo (anti-flood do grupo) — tira um antes de disparar.'
  const slots =
    blocos.filter((b) => b.tipo === 'copy').length +
    blocos.filter((b) => b.tipo === 'midia' && b.legendaCopy).length
  if (slots === 0) return 'A copy precisa entrar em algum lugar: bloco de copy ou legenda de uma mídia.'
  if (slots > 1) return 'A copy só pode entrar em UM lugar (um bloco de copy OU uma legenda).'
  return null
}

function MidiaPreview({ m, mini }: { m: Midia; mini?: boolean }) {
  const w = mini ? 120 : 200
  if (m.tipo === 'imagem') return <img src={m.url} alt={m.nome} style={{ maxWidth: w, maxHeight: w, borderRadius: 8, display: 'block' }} />
  if (m.tipo === 'video') return <video src={m.url} controls preload="metadata" style={{ maxWidth: w * 1.4, maxHeight: w * 1.4, borderRadius: 8, display: 'block' }} />
  return <audio src={m.url} controls preload="metadata" style={{ width: mini ? 180 : 260, display: 'block' }} />
}

const ICONE = { imagem: ImgIcon, video: Film, audio: Mic } as const

export function SequenciaMidia({ blocos, onChange }: { blocos: BlocoUI[]; onChange: (b: BlocoUI[]) => void }) {
  const [biblioteca, setBiblioteca] = useState<Midia[]>([])
  const [abrindo, setAbrindo] = useState(false)
  const [subindo, setSubindo] = useState(false)
  const [erro, setErro] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const carregar = () => listMidias().then(setBiblioteca).catch((e) => setErro(e instanceof Error ? e.message : 'falhou'))
  useEffect(() => { carregar() }, [])

  function mover(i: number, delta: -1 | 1) {
    const j = i + delta
    if (j < 0 || j >= blocos.length) return
    const n = [...blocos]
    ;[n[i], n[j]] = [n[j], n[i]]
    onChange(n)
  }

  function remover(i: number) {
    const b = blocos[i]
    let n = blocos.filter((_, k) => k !== i)
    // tirar a mídia que carregava a copy (ou o bloco copy) não pode deixar a copy sem lugar
    const temSlot = n.some((x) => x.tipo === 'copy' || (x.tipo === 'midia' && x.legendaCopy))
    if (!temSlot) n = [...n, { key: crypto.randomUUID(), tipo: 'copy' }]
    if (b.tipo === 'copy' && n.length === 0) n = [{ key: crypto.randomUUID(), tipo: 'copy' }]
    onChange(n)
  }

  const MAX_BLOCOS = 6 // anti-flood: o banco recusa acima disso também

  function adicionarMidia(m: Midia) {
    if (blocos.length >= MAX_BLOCOS) {
      toast(`Máximo de ${MAX_BLOCOS} blocos por disparo (anti-flood do grupo).`, true)
      return
    }
    onChange([...blocos, { key: crypto.randomUUID(), tipo: 'midia', midia: m, legendaCopy: false }])
    setAbrindo(false)
  }

  function toggleLegendaCopy(i: number) {
    const alvo = blocos[i]
    if (alvo.tipo !== 'midia' || alvo.midia.tipo === 'audio') return
    const ligar = !alvo.legendaCopy
    let n: BlocoUI[] = blocos.map((b, k) =>
      b.tipo === 'midia' ? { ...b, legendaCopy: k === i ? ligar : false } : b,
    )
    if (ligar) n = n.filter((b) => b.tipo !== 'copy')
    else if (!n.some((b) => b.tipo === 'copy')) n = [...n, { key: crypto.randomUUID(), tipo: 'copy' }]
    onChange(n)
  }

  async function subir(f: File) {
    setSubindo(true)
    setErro('')
    try {
      const m = await uploadMidia(f, f.name.replace(/\.[^.]+$/, ''))
      toast(`Mídia "${m.nome}" na biblioteca`)
      carregar()
      adicionarMidia(m)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'upload falhou')
    } finally {
      setSubindo(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function tirarDaBiblioteca(m: Midia) {
    if (blocos.some((b) => b.tipo === 'midia' && b.midia.id === m.id)) {
      toast('Essa mídia está na sequência atual — tira dela primeiro.', true)
      return
    }
    try {
      await desativarMidia(m.id)
      toast(`"${m.nome}" saiu da biblioteca (nada é apagado do histórico)`)
      carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'falhou', true)
    }
  }

  return (
    <div className="field">
      <label><Paperclip size={13} /> Sequência do disparo</label>
      <p className="mut" style={{ fontSize: 12, marginTop: 0 }}>
        O grupo recebe os blocos NESTA ordem. A copy aprovada entra no bloco 📝 — ou vira a
        legenda de uma imagem/vídeo (aí some o bloco de texto). Áudio ogg sai como voice note;
        mp3 pode chegar como arquivo comum.
      </p>

      {blocos.map((b, i) => (
        <div key={b.key} className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 6 }}>
          <span className="mut" style={{ fontSize: 12, minWidth: 16, marginTop: 4 }}>{i + 1}º</span>
          {b.tipo === 'copy' ? (
            <div className="row" style={{ gap: 8, flex: 1 }}>
              <FileText size={15} />
              <span style={{ fontSize: 13 }}>Copy da variação <span className="mut">(o texto aprovado, rotaciona por grupo)</span></span>
            </div>
          ) : (
            <div style={{ flex: 1 }}>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                {(() => { const I = ICONE[b.midia.tipo]; return <I size={15} /> })()}
                <b style={{ fontSize: 13 }}>{b.midia.nome}</b>
                <span className="mut" style={{ fontSize: 11 }}>{tamanhoLegivel(b.midia.tamanho_bytes)}</span>
              </div>
              <MidiaPreview m={b.midia} mini />
              {b.midia.tipo !== 'audio' && (
                <label className="row" style={{ gap: 6, cursor: 'pointer', marginTop: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={b.legendaCopy} onChange={() => toggleLegendaCopy(i)} />
                  usar a copy como legenda desta mídia
                </label>
              )}
            </div>
          )}
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => mover(i, -1)} aria-label="subir"><ArrowUp size={13} /></button>
            <button type="button" className="btn sm ghost" disabled={i === blocos.length - 1} onClick={() => mover(i, 1)} aria-label="descer"><ArrowDown size={13} /></button>
            {!(b.tipo === 'copy' && blocos.length === 1) && (
              <button type="button" className="btn sm ghost" onClick={() => remover(i)} aria-label="remover"><X size={13} /></button>
            )}
          </div>
        </div>
      ))}

      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <button type="button" className="btn sm ghost" onClick={() => setAbrindo((v) => !v)}>
          <Paperclip size={13} /> {abrindo ? 'Fechar biblioteca' : 'Adicionar mídia'}
        </button>
        <button type="button" className="btn sm ghost" disabled={subindo} onClick={() => fileRef.current?.click()}>
          <Upload size={13} /> {subindo ? 'Subindo…' : 'Enviar arquivo novo'}
        </button>
        <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,video/mp4,audio/ogg,audio/mpeg"
          onChange={(e) => e.target.files?.[0] && subir(e.target.files[0])} />
      </div>
      <p className="mut" style={{ fontSize: 11, margin: '4px 0 0' }}>
        {LIMITES.imagem.rotulo} · {LIMITES.video.rotulo} · {LIMITES.audio.rotulo}
      </p>
      {erro && <p className="st-falha" style={{ fontSize: 12 }}>{erro}</p>}

      {abrindo && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          {biblioteca.length === 0 && <p className="mut" style={{ fontSize: 12 }}>Biblioteca vazia — sobe o primeiro arquivo.</p>}
          {biblioteca.map((m) => (
            <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <b style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.nome}</b>
                <button type="button" className="btn sm ghost" title="Tirar da biblioteca" onClick={() => tirarDaBiblioteca(m)}><Trash2 size={12} /></button>
              </div>
              <MidiaPreview m={m} mini />
              <button type="button" className="btn sm" style={{ marginTop: 6, width: '100%' }} onClick={() => adicionarMidia(m)}>
                Adicionar à sequência
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
