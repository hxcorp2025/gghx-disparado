import { useEffect, useMemo, useState } from 'react'
import { Send, Users, AtSign, AlertTriangle } from 'lucide-react'
import type { CopyVariacao } from '../lib/copyDb'
import { sendflowGruposVip, sendflowDisparar } from '../lib/sendflowDb'
import type { SendflowGrupoVip } from '../lib/sendflowDb'
import { Modal } from './Modal'
import { PreviewWhatsApp } from './PreviewWhatsApp'
import { toast } from '../lib/toast'
import { SequenciaMidia, blocosParaRpc, sequenciaValida } from './SequenciaMidia'
import type { BlocoUI } from './SequenciaMidia'

// Ritmo entre mensagens no chip — valores que o Peterson usa na mao (seguranca anti-ban).
const RITMOS = {
  normal: { label: 'Normal', sub: '80–160s', min: 80, max: 160 },
  urgente: { label: 'Em cima da hora', sub: '50–80s', min: 50, max: 80 },
} as const
type RitmoKey = keyof typeof RITMOS

// F4 — painel de disparo via SendFlow, dentro da aba Copy com IA.
// So ENFILEIRA (a RPC sendflow_disparar). O worker no banco faz o envio.
// Cada variacao aprovada vai pra um lote de grupos (round-robin) -> A/B de sobrevivencia.
export function DisparoSendflow({ aprovadas }: { aprovadas: CopyVariacao[] }) {
  const [grupos, setGrupos] = useState<SendflowGrupoVip[]>([])
  const [releaseFiltro, setReleaseFiltro] = useState<string>('todas')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [mencao, setMencao] = useState(false)
  const [ritmo, setRitmo] = useState<RitmoKey>('normal')
  const [confirmando, setConfirmando] = useState(false)
  const [disparando, setDisparando] = useState(false)
  const [erroGrupos, setErroGrupos] = useState('')
  const [blocos, setBlocos] = useState<BlocoUI[]>([{ key: 'copy-base', tipo: 'copy' }])

  useEffect(() => {
    sendflowGruposVip()
      .then(setGrupos)
      .catch((e) => setErroGrupos(e instanceof Error ? e.message : 'Não consegui carregar os grupos.'))
  }, [])

  const releases = useMemo(() => {
    const m = new Map<string, string>()
    grupos.forEach((g) => m.set(g.release_id, g.release_nome))
    return [...m.entries()].map(([id, nome]) => ({ id, nome }))
  }, [grupos])

  const gruposAlvo = useMemo(
    () => (releaseFiltro === 'todas' ? grupos : grupos.filter((g) => g.release_id === releaseFiltro)),
    [grupos, releaseFiltro],
  )

  // agrupa as aprovadas por PEDIDO (fila_id); dentro do pedido, a original (idx 0) vem primeiro
  const porPedido = useMemo(() => {
    const m = new Map<number, CopyVariacao[]>()
    aprovadas.forEach((v) => {
      const arr = m.get(v.fila_id) ?? []
      arr.push(v)
      m.set(v.fila_id, arr)
    })
    return [...m.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([fid, vs]) => ({ fid, vs: [...vs].sort((x, y) => x.idx - y.idx) }))
  }, [aprovadas])

  const selecionadas = aprovadas.filter((v) => sel.has(v.id))
  const erroSequencia = sequenciaValida(blocos)
  const nMidias = blocos.filter((b) => b.tipo === 'midia').length
  const podeDisparar = selecionadas.length > 0 && gruposAlvo.length > 0 && !erroSequencia
  const porVariacao = Math.ceil(gruposAlvo.length / Math.max(1, selecionadas.length))

  function toggle(id: number) {
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  async function confirmar() {
    if (disparando || !podeDisparar) return
    setDisparando(true)
    try {
      const r = await sendflowDisparar(
        // manda a selecao DERIVADA (aprovada + visivel), nao o Set cru: se o polling
        // reprova uma variacao selecionada, [...sel] mandaria um id que a tela nem mostra.
        gruposAlvo.map((g) => g.gid), selecionadas.map((v) => v.id), mencao, RITMOS[ritmo].min, RITMOS[ritmo].max,
        blocosParaRpc(blocos),
      )
      const extra = r.ignorados_n ? ` · ${r.ignorados_n} ignorados` : ''
      toast(`Disparo enfileirado: ${r.grupos} grupos em ${r.lotes} lotes${extra}`)
      setConfirmando(false)
      setSel(new Set())
      // zera a sequência: mídia armada de um disparo NUNCA vaza pro próximo sem querer
      setBlocos([{ key: 'copy-base', tipo: 'copy' }])
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setDisparando(false)
    }
  }

  // sem copy aprovada nao ha o que disparar
  if (aprovadas.length === 0) return null

  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div className="row" style={{ gap: 8, marginBottom: 4 }}>
        <Send size={17} style={{ color: 'var(--accent)' }} />
        <h3 style={{ margin: 0 }}>Disparar via SendFlow</h3>
      </div>
      <p className="mut" style={{ fontSize: 12.5, marginTop: 0 }}>
        Escolhe as variações aprovadas e os grupos. Cada variação vai pra um lote diferente de grupos
        (round-robin) — é assim que a gente mede qual copy segura mais o grupo. Nada dispara sem você
        confirmar aqui.
      </p>

      <div className="field">
        <label>Cópias aprovadas ({selecionadas.length} escolhidas)</label>
        {porPedido.map(({ fid, vs }) => (
          <div key={fid} style={{ marginBottom: 10 }}>
            <span className="mut" style={{ fontSize: 12 }}>Pedido #{fid}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {vs.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={'btn sm ' + (sel.has(v.id) ? '' : 'ghost')}
                  onClick={() => toggle(v.id)}
                  title={v.texto}
                >
                  {sel.has(v.id) ? '✓ ' : ''}#{v.fila_id}.{v.idx}
                  {v.origem === 'original' ? ' · original' : v.angulo ? ` · ${v.angulo}` : ''}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="field">
        <label>Grupos alvo</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            className={'btn sm ' + (releaseFiltro === 'todas' ? '' : 'ghost')}
            onClick={() => setReleaseFiltro('todas')}
          >
            Todas VIP ({grupos.length})
          </button>
          {releases.map((r) => (
            <button
              key={r.id}
              type="button"
              className={'btn sm ' + (releaseFiltro === r.id ? '' : 'ghost')}
              onClick={() => setReleaseFiltro(r.id)}
            >
              {r.nome} ({grupos.filter((g) => g.release_id === r.id).length})
            </button>
          ))}
        </div>
        {erroGrupos && <p className="st-falha" style={{ fontSize: 12 }}>{erroGrupos}</p>}
      </div>

      <div className="field">
        <label>Ritmo entre mensagens (segurança do chip)</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {(Object.keys(RITMOS) as RitmoKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={'btn sm ' + (ritmo === k ? '' : 'ghost')}
              onClick={() => setRitmo(k)}
            >
              {RITMOS[k].label} <span className="mut" style={{ fontSize: 11 }}>({RITMOS[k].sub})</span>
            </button>
          ))}
        </div>
        <p className="mut" style={{ fontSize: 12, marginBottom: 0 }}>
          Cada número dispara <b>uma variação por vez</b> — nunca dois templates ao mesmo tempo no
          mesmo chip. Números diferentes (VIP 01 e 02) vão em paralelo.
        </p>
      </div>

      <SequenciaMidia blocos={blocos} onChange={setBlocos} />
      {erroSequencia && <p className="st-falha" style={{ fontSize: 12 }}>{erroSequencia}</p>}

      <label className="row" style={{ gap: 8, cursor: 'pointer', margin: '4px 0 12px' }}>
        <input type="checkbox" checked={mencao} onChange={(e) => setMencao(e.target.checked)} />
        <AtSign size={15} /> Mencionar todos os participantes
        <span className="mut" style={{ fontSize: 12 }}>(padrão desligado — menos queda de grupo)</span>
      </label>

      <div className="row between">
        <span className="mut" style={{ fontSize: 13 }}>
          <Users size={13} /> {selecionadas.length} variações{nMidias > 0 ? ` + ${nMidias} mídia${nMidias > 1 ? 's' : ''}` : ''} → <b>{gruposAlvo.length}</b> grupos
        </span>
        <button className="btn" disabled={!podeDisparar} onClick={() => setConfirmando(true)}>
          <Send size={15} /> Preparar disparo
        </button>
      </div>

      {confirmando && (
        <Modal
          title="Confirmar disparo"
          sub={`${selecionadas.length} variações${nMidias > 0 ? ` + ${nMidias} mídia(s) em sequência` : ''} → ${gruposAlvo.length} grupos · menção ${mencao ? 'LIGADA' : 'desligada'} · ritmo ${RITMOS[ritmo].sub}`}
          onClose={() => !disparando && setConfirmando(false)}
        >
          <div className="card" style={{ borderColor: 'var(--amber)', marginTop: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
              <b>Isso enfileira um disparo REAL nos grupos do Rox.</b>
            </div>
            <p className="mut" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Cada variação vai pra ~{porVariacao} grupos, {RITMOS[ritmo].sub} entre mensagens, uma
              variação por número de cada vez. O envio sai pelo motor do SendFlow conforme o worker
              processa a fila.
            </p>
          </div>
          {nMidias > 0 && (
            <div style={{ marginTop: 12 }}>
              <span className="mut" style={{ fontSize: 12 }}>Ordem no grupo:</span>
              <ol style={{ margin: '4px 0 0 18px', fontSize: 12.5 }}>
                {blocos.map((b) => (
                  <li key={b.key}>
                    {b.tipo === 'copy'
                      ? 'Copy da variação (texto)'
                      : `${b.midia.tipo} · ${b.midia.nome}${b.legendaCopy ? ' (copy na legenda)' : ''}`}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {selecionadas.map((v) => (
            <div key={v.id} style={{ marginTop: 12 }}>
              <span className="mut" style={{ fontSize: 12 }}>
                #{v.fila_id}.{v.idx}
                {v.origem === 'original' ? ' · original' : v.angulo ? ` · ${v.angulo}` : ''}
              </span>
              <PreviewWhatsApp texto={v.texto} />
            </div>
          ))}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" disabled={disparando} onClick={confirmar}>
              <Send size={15} /> {disparando ? 'Enfileirando…' : 'Confirmar e enfileirar'}
            </button>
            <button className="btn ghost" disabled={disparando} onClick={() => setConfirmando(false)}>
              Cancelar
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
