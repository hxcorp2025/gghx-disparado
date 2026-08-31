import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Send, Users, AtSign, AlertTriangle, Check, Pause, Play, XCircle, Zap, Rocket, Pencil,
} from 'lucide-react'
import type { CopyVariacao } from '../lib/copyDb'
import {
  sendflowGruposVip, sendflowDisparar, sendflowGruposUltimoEnvio,
  sendflowDisparoStatus, sendflowDisparoCancelar, sendflowDisparoAgora,
  sendflowDisparoPausar, sendflowDisparoRetomar,
} from '../lib/sendflowDb'
import type { SendflowGrupoVip, DisparoStatus, LoteStatus } from '../lib/sendflowDb'
import { Modal } from './Modal'
import { PhonePreview } from './PhonePreview'
import { toast } from '../lib/toast'
import { SequenciaMidia, blocosParaRpc, sequenciaValida } from './SequenciaMidia'
import type { BlocoUI } from './SequenciaMidia'
import { EditorCopyTexto } from './EditorCopyTexto'

// Ritmo entre mensagens no chip — valores que o Peterson usa na mao (seguranca anti-ban).
const RITMOS = {
  normal: { label: 'Normal', sub: '80–160s', min: 80, max: 160 },
  urgente: { label: 'Em cima da hora', sub: '50–80s', min: 50, max: 80 },
} as const
type RitmoKey = keyof typeof RITMOS

// Grupo que recebeu disparo ha menos disso vem DESMARCADO com aviso (da pra marcar na mao).
const COOLDOWN_H = 4
// A partida agendada: o disparo entra armado e so vira envio depois desta janela —
// e o unico momento em que "cancelar" desfaz TUDO. O worker roda a cada minuto,
// entao na pratica a partida acontece ate ~1 min depois do zero.
const PARTIDA_S = 60
const LS_VIVO = 'gghx-disparo-vivo'

const STATUS_LOTE: Record<LoteStatus['status'], { label: string; cls: string }> = {
  pending: { label: 'na fila', cls: 'b-agendado' },
  paused: { label: 'pausado', cls: 'b-pausada' },
  sending: { label: 'indo pro motor', cls: 'b-rodando' },
  done: { label: 'no motor do SendFlow', cls: 'b-concluida' },
  error: { label: 'erro', cls: 'b-erro' },
  incerto: { label: 'incerto', cls: 'b-erro' },
  cancelled: { label: 'cancelado', cls: 'b-cancelada' },
}

function vLabel(v: CopyVariacao) {
  return `#${v.fila_id}.${v.idx}${v.origem === 'original' ? ' · original' : v.angulo ? ` · ${v.angulo}` : ''}`
}

function horasDesde(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000
}

function rotuloDesde(iso: string) {
  const h = horasDesde(iso)
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}min`
  return `${Math.floor(h)}h`
}

// Mesa de Disparo (estudo UX 24/08, artifact 4e694a44): 4 cartoes com estado + celular
// fixo com a conversa real + revisao read-only + partida em 60s cancelavel + lotes
// pausaveis enquanto nao viram acao no SendFlow. So ENFILEIRA — o worker envia.
export function DisparoSendflow({
  aprovadas,
  onRecarregar,
}: {
  aprovadas: CopyVariacao[]
  onRecarregar?: () => void
}) {
  const [grupos, setGrupos] = useState<SendflowGrupoVip[]>([])
  const [ultimoEnvio, setUltimoEnvio] = useState<Map<string, string>>(new Map())
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [selGids, setSelGids] = useState<Set<string>>(new Set())
  const [mencao, setMencao] = useState(false)
  const [ritmo, setRitmo] = useState<RitmoKey>('normal')
  const [blocos, setBlocos] = useState<BlocoUI[]>([{ key: 'copy-base', tipo: 'copy' }])
  const [previewVarId, setPreviewVarId] = useState<number | null>(null)
  const [erroGrupos, setErroGrupos] = useState('')

  const [revisando, setRevisando] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [vivoId, setVivoId] = useState<string | null>(null)
  const [st, setSt] = useState<DisparoStatus | null>(null)
  const [agora, setAgora] = useState(Date.now())
  const [confirmaAborto, setConfirmaAborto] = useState(false)
  const [agindo, setAgindo] = useState(false)
  // ajuste de detalhe sem cancelar a copy (PRD_copyia_editar_variacao_2026-08-31)
  const [editandoVar, setEditandoVar] = useState<CopyVariacao | null>(null)

  // cooldown é conveniência: sem ele a mesa segue funcionando
  const carregarCooldown = useCallback(() => {
    sendflowGruposUltimoEnvio()
      .then((rows) => setUltimoEnvio(new Map(rows.map((r) => [r.gid, r.ultimo_em]))))
      .catch(() => {})
  }, [])

  useEffect(() => {
    sendflowGruposVip()
      .then(setGrupos)
      .catch((e) => setErroGrupos(e instanceof Error ? e.message : 'Não consegui carregar os grupos.'))
    carregarCooldown()
    // se um disparo ficou vivo (refresh no meio), volta pro acompanhamento
    const salvo = localStorage.getItem(LS_VIVO)
    if (salvo) {
      sendflowDisparoStatus(salvo)
        .then((s) => {
          const r = s.resumo
          if (r.total > 0 && r.pending + r.paused + r.sending > 0) {
            setVivoId(salvo)
            setSt(s)
          } else localStorage.removeItem(LS_VIVO)
        })
        .catch(() => localStorage.removeItem(LS_VIVO))
    }
  }, [])

  // relogio de 1s (contagem da partida) + poll de 5s do status enquanto ha disparo vivo;
  // disparo encerrado nao muda mais — os timers param sozinhos
  useEffect(() => {
    if (!vivoId) return
    const fim = st && st.resumo.total > 0 && st.resumo.pending + st.resumo.paused + st.resumo.sending === 0
    if (fim) return
    const t1 = setInterval(() => setAgora(Date.now()), 1000)
    const t5 = setInterval(() => {
      sendflowDisparoStatus(vivoId).then(setSt).catch(() => {})
    }, 5000)
    return () => {
      clearInterval(t1)
      clearInterval(t5)
    }
  }, [vivoId, st])

  const releases = useMemo(() => {
    const m = new Map<string, string>()
    grupos.forEach((g) => m.set(g.release_id, g.release_nome))
    return [...m.entries()].map(([id, nome]) => ({ id, nome }))
  }, [grupos])
  const releaseNome = useCallback(
    (id: string) => releases.find((r) => r.id === id)?.nome ?? id.slice(0, 8),
    [releases],
  )

  const emCooldown = useCallback(
    (gid: string) => {
      const u = ultimoEnvio.get(gid)
      return u != null && horasDesde(u) < COOLDOWN_H
    },
    [ultimoEnvio],
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
  const gruposSel = grupos.filter((g) => selGids.has(g.gid))
  const pessoas = gruposSel.reduce((s, g) => s + (g.participantes || 0), 0)
  const erroSequencia = sequenciaValida(blocos)
  const nMidias = blocos.filter((b) => b.tipo === 'midia').length
  const podeRevisar = selecionadas.length > 0 && gruposSel.length > 0 && !erroSequencia
  const porVariacao = Math.ceil(gruposSel.length / Math.max(1, selecionadas.length))
  const previewVar =
    selecionadas.find((v) => v.id === previewVarId) ?? selecionadas[0] ?? null

  function toggleVar(v: CopyVariacao) {
    setSel((s) => {
      const n = new Set(s)
      if (n.has(v.id)) n.delete(v.id)
      else n.add(v.id)
      return n
    })
    setPreviewVarId(v.id)
  }

  function toggleGid(gid: string) {
    setSelGids((s) => {
      const n = new Set(s)
      if (n.has(gid)) n.delete(gid)
      else n.add(gid)
      return n
    })
  }

  // pill de release: marca TODOS os grupos dela; clicar de novo desmarca todos.
  // Cooldown NÃO exclui ninguém (Peterson 31/08: a operação empilha disparos no mesmo
  // dia — excluir do marcar em bloco travava o fluxo). O selo é só informação.
  function toggleRelease(rid: string | null) {
    const alvo = rid === null ? grupos : grupos.filter((g) => g.release_id === rid)
    const todosMarcados = alvo.length > 0 && alvo.every((g) => selGids.has(g.gid))
    setSelGids((s) => {
      const n = new Set(s)
      if (todosMarcados) alvo.forEach((g) => n.delete(g.gid))
      else alvo.forEach((g) => n.add(g.gid))
      return n
    })
  }

  function resetMesa() {
    setSel(new Set())
    setSelGids(new Set())
    setMencao(false)
    setRitmo('normal')
    setBlocos([{ key: 'copy-base', tipo: 'copy' }])
    setPreviewVarId(null)
  }

  async function armar() {
    if (enviando || !podeRevisar) return
    setEnviando(true)
    try {
      const r = await sendflowDisparar(
        gruposSel.map((g) => g.gid),
        selecionadas.map((v) => v.id),
        mencao, RITMOS[ritmo].min, RITMOS[ritmo].max,
        blocosParaRpc(blocos), PARTIDA_S,
      )
      setRevisando(false)
      setVivoId(r.disparo_id)
      localStorage.setItem(LS_VIVO, r.disparo_id)
      const s = await sendflowDisparoStatus(r.disparo_id).catch(() => null)
      if (s) setSt(s)
      const extra = r.ignorados_n ? ` · ${r.ignorados_n} grupos ignorados (sumiram)` : ''
      toast(`Disparo armado: parte em ${PARTIDA_S}s${extra}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setEnviando(false)
    }
  }

  async function acao(fn: () => Promise<unknown>, msg: string) {
    if (agindo || !vivoId) return
    setAgindo(true)
    try {
      await fn()
      const s = await sendflowDisparoStatus(vivoId)
      setSt(s)
      toast(msg)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setAgindo(false)
    }
  }

  // cancelar com o disparo armado: se o worker claimou um lote no mesmo minuto,
  // esse lote JÁ está no motor e vai até o fim — o toast diz a verdade e a tela
  // cai no acompanhamento em vez de fingir que nada saiu. Cancelou tudo mesmo →
  // volta pra mesa (na mesma sessão a configuração continua preenchida).
  async function cancelarArmado() {
    if (agindo || !vivoId) return
    setAgindo(true)
    try {
      const r = await sendflowDisparoCancelar(vivoId)
      if (r.ja_no_motor > 0) {
        toast(`${r.cancelados} lotes cancelados — ${r.ja_no_motor} já estavam no motor e vão até o fim`, true)
        const s = await sendflowDisparoStatus(vivoId).catch(() => null)
        if (s) setSt(s)
      } else {
        toast('Disparo cancelado — nada foi enviado')
        encerrarVivo(false)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setAgindo(false)
    }
  }

  function encerrarVivo(zerarMesa: boolean) {
    setVivoId(null)
    setSt(null)
    setConfirmaAborto(false)
    localStorage.removeItem(LS_VIVO)
    if (zerarMesa) resetMesa() // mencao/ritmo/midia NUNCA vazam pro proximo disparo
    carregarCooldown() // o disparo que acabou de sair conta pro cooldown do proximo
  }

  // sem copy aprovada nao ha o que disparar
  if (aprovadas.length === 0) return null

  // ===================== PAINEL VIVO (armado / andamento / terminou) =====================
  if (vivoId && !st) {
    return (
      <div className="card" style={{ borderColor: 'var(--accent)', maxWidth: 720 }}>
        <p className="mut" style={{ margin: 0 }}>
          <span className="spin" /> Carregando o disparo…
        </p>
      </div>
    )
  }
  if (vivoId && st) {
    const r = st.resumo
    const terminou = r.total > 0 && r.pending + r.paused + r.sending === 0
    const partidaMs = st.partida_em ? new Date(st.partida_em).getTime() : null
    const faltam = partidaMs ? Math.max(0, Math.ceil((partidaMs - agora) / 1000)) : 0
    const armado = !terminou && r.done + r.sending + r.error === 0 && faltam > 0
    const pct = r.grupos_total > 0 ? Math.round((r.grupos_feitos / r.grupos_total) * 100) : 0

    return (
      <div className="card" style={{ borderColor: 'var(--accent)', maxWidth: 720 }}>
        {armado ? (
          <div className="armado">
            <p className="mut" style={{ margin: '0 0 6px', fontSize: 13 }}>
              Disparo armado — parte em
            </p>
            <div className="cd">{faltam}s</div>
            <p className="mut" style={{ fontSize: 12.5, margin: '10px auto 18px', maxWidth: 420 }}>
              {r.total} lotes · <b style={{ color: 'var(--txt)' }}>{r.grupos_total} grupos</b>. Até a
              partida dá pra cancelar tudo; depois que um lote entra no motor do SendFlow, ele vai
              até o fim (o envio entre grupos é paceado, mas não tem volta).
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button
                className="btn"
                disabled={agindo}
                onClick={() => acao(() => sendflowDisparoAgora(vivoId), 'Partida liberada — o motor pega no próximo minuto')}
              >
                <Zap size={15} /> Começar já
              </button>
              <button className="btn ghost red" disabled={agindo} onClick={cancelarArmado}>
                <XCircle size={15} /> Cancelar disparo
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Rocket size={17} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0 }}>{terminou ? 'Disparo encerrado' : 'Disparo em andamento'}</h3>
            </div>
            <p className="mut" style={{ fontSize: 12.5, marginTop: 0 }}>
              {terminou
                ? 'Todos os lotes foram processados. O envio grupo a grupo segue o ritmo do motor do SendFlow.'
                : 'Lote entregue ao motor não tem volta — pausar/cancelar vale só pro que ainda está na fila.'}
            </p>

            <div className="pbar" style={{ margin: '10px 0 6px' }}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <p className="mut" style={{ fontSize: 12, margin: '0 0 12px' }}>
              <b style={{ color: 'var(--txt)' }}>{r.grupos_feitos}</b> de {r.grupos_total} grupos
              entregues ao motor ({pct}%)
            </p>

            <div className="dispcounters">
              {r.pending > 0 && <span className="cnt"><b>{r.pending}</b> na fila</span>}
              {r.paused > 0 && <span className="cnt c-skip"><b>{r.paused}</b> pausados</span>}
              {r.sending > 0 && <span className="cnt c-run"><b>{r.sending}</b> enviando</span>}
              {r.done > 0 && <span className="cnt c-ok"><b>{r.done}</b> no motor</span>}
              {r.error > 0 && <span className="cnt c-err"><b>{r.error}</b> com erro</span>}
              {r.cancelled > 0 && <span className="cnt"><b>{r.cancelled}</b> cancelados</span>}
            </div>

            {st.lotes.map((l) => (
              <div key={l.id} className="listrow" style={{ padding: '10px 14px' }}>
                <span style={{ fontSize: 13 }}>
                  {releaseNome(l.release_id)}
                  {l.braco_ab ? <span className="mut"> · braço {l.braco_ab}</span> : null}
                  <span className="mut"> · {l.n_gids} grupos</span>
                  {l.ultimo_erro && (l.status === 'error' || l.status === 'incerto') && (
                    <span className="st-falha" style={{ fontSize: 11.5 }}> · {l.ultimo_erro}</span>
                  )}
                </span>
                <span className={`badge ${STATUS_LOTE[l.status]?.cls ?? ''}`}>
                  {l.acao?.concluida_em
                    ? 'concluído no SendFlow'
                    : STATUS_LOTE[l.status]?.label ?? l.status}
                </span>
              </div>
            ))}

            <div className="row" style={{ marginTop: 14 }}>
              {terminou ? (
                <button className="btn" onClick={() => encerrarVivo(true)}>
                  <Send size={15} /> Novo disparo
                </button>
              ) : (
                <>
                  {r.pending > 0 && (
                    <button className="btn ghost" disabled={agindo}
                      onClick={() => acao(() => sendflowDisparoPausar(vivoId), 'Lotes da fila pausados')}>
                      <Pause size={15} /> Pausar o que falta
                    </button>
                  )}
                  {r.paused > 0 && (
                    <button className="btn ghost" disabled={agindo}
                      onClick={() => acao(() => sendflowDisparoRetomar(vivoId), 'Lotes retomados')}>
                      <Play size={15} /> Retomar
                    </button>
                  )}
                  {r.pending + r.paused > 0 &&
                    (confirmaAborto ? (
                      <span className="row" style={{ gap: 6 }}>
                        <span className="mut" style={{ fontSize: 12.5 }}>
                          Cancela {r.pending + r.paused} lotes ainda não enviados?
                        </span>
                        <button className="btn sm danger" disabled={agindo}
                          onClick={() => { setConfirmaAborto(false); acao(() => sendflowDisparoCancelar(vivoId), 'Lotes restantes cancelados') }}>
                          Sim, cancelar
                        </button>
                        <button className="btn sm ghost" onClick={() => setConfirmaAborto(false)}>Voltar</button>
                      </span>
                    ) : (
                      <button className="btn ghost red" disabled={agindo} onClick={() => setConfirmaAborto(true)}>
                        <XCircle size={15} /> Cancelar o que falta
                      </button>
                    ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  // ===================== A MESA (4 cartões + celular) =====================
  return (
    <div className="mesa">
      <div className="mesa-main">
        {/* 1 · Mensagem */}
        <div className={'mcard' + (selecionadas.length > 0 ? ' ok' : '')}>
          <div className="mcard-head">
            <span className="mnum">{selecionadas.length > 0 ? <Check size={13} /> : '1'}</span>
            <h4>Mensagem</h4>
            <span className="mstate">
              {selecionadas.length > 0
                ? `${selecionadas.length} escolhida${selecionadas.length > 1 ? 's' : ''}`
                : 'escolhe pelo menos uma'}
            </span>
          </div>
          <p className="mut" style={{ fontSize: 12, margin: '0 0 10px' }}>
            Cada copy escolhida vira um braço do teste: os grupos são divididos entre elas
            (round-robin) pra medir qual segura mais o grupo. Clica pra escolher — a última clicada
            aparece no celular ao lado.
          </p>
          {porPedido.map(({ fid, vs }) => (
            <div key={fid} style={{ marginBottom: 10 }}>
              <span className="mut" style={{ fontSize: 11.5 }}>Pedido #{fid}</span>
              <div className="vgrid" style={{ marginTop: 5 }}>
                {vs.map((v) => (
                  <div key={v.id} role="button" tabIndex={0} aria-pressed={sel.has(v.id)}
                    className={'vcard' + (sel.has(v.id) ? ' on' : '')}
                    onClick={() => toggleVar(v)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVar(v) } }}>
                    <span className="vmeta">
                      <b>{sel.has(v.id) ? '✓ ' : ''}{vLabel(v)}</b>
                      <span className="row" style={{ gap: 6 }}>
                        {v.editado_em && <span title={v.texto_original ?? undefined}>editada</span>}
                        <span>{v.chars} chars</span>
                        <button type="button" className="vedit" title="Ajustar o texto (salvar já aprova)"
                          onClick={(e) => { e.stopPropagation(); setEditandoVar(v) }}>
                          <Pencil size={12} />
                        </button>
                      </span>
                    </span>
                    <span className="vtxt">{v.texto}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* 2 · Sequência (mídia) */}
        <div className={'mcard' + (erroSequencia ? '' : ' ok')}>
          <div className="mcard-head">
            <span className="mnum">{erroSequencia ? '2' : <Check size={13} />}</span>
            <h4>Sequência</h4>
            <span className="mstate">
              {erroSequencia ? 'ajusta a sequência' : nMidias > 0 ? `${nMidias} mídia${nMidias > 1 ? 's' : ''} + copy` : 'só texto'}
            </span>
          </div>
          <SequenciaMidia blocos={blocos} onChange={setBlocos} />
          {erroSequencia && <p className="st-falha" style={{ fontSize: 12, marginBottom: 0 }}>{erroSequencia}</p>}
        </div>

        {/* 3 · Alvo */}
        <div className={'mcard' + (gruposSel.length > 0 ? ' ok' : '')}>
          <div className="mcard-head">
            <span className="mnum">{gruposSel.length > 0 ? <Check size={13} /> : '3'}</span>
            <h4>Alvo</h4>
            <span className="mstate">
              {gruposSel.length > 0 ? (
                <><b style={{ color: 'var(--txt)' }}>{gruposSel.length}</b> grupos · ≈{pessoas.toLocaleString('pt-BR')} pessoas</>
              ) : 'nenhum grupo marcado'}
            </span>
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <button type="button" className="btn sm ghost" onClick={() => toggleRelease(null)}>
              <Users size={13} /> Todas VIP ({grupos.length})
            </button>
            {releases.map((rl) => (
              <button key={rl.id} type="button" className="btn sm ghost" onClick={() => toggleRelease(rl.id)}>
                {rl.nome} ({grupos.filter((g) => g.release_id === rl.id).length})
              </button>
            ))}
            {selGids.size > 0 && (
              <button type="button" className="btn sm ghost" onClick={() => setSelGids(new Set())}>Limpar</button>
            )}
          </div>
          <p className="mut" style={{ fontSize: 11.5, margin: '0 0 8px' }}>
            O selo mostra há quanto tempo o grupo recebeu o último disparo (âmbar = menos de{' '}
            {COOLDOWN_H}h). É só informação — marcar em bloco marca todo mundo.
          </p>
          {erroGrupos && <p className="st-falha" style={{ fontSize: 12 }}>{erroGrupos}</p>}
          {grupos.length > 0 && (
            <div className="galvo">
              {grupos.map((g) => {
                const u = ultimoEnvio.get(g.gid)
                const cool = emCooldown(g.gid)
                return (
                  <label key={g.gid} className="galvo-row">
                    <input type="checkbox" checked={selGids.has(g.gid)} onChange={() => toggleGid(g.gid)} />
                    <span className="gnome">
                      {g.nome}
                      {u && (
                        <span className={'cool' + (cool ? '' : ' info')} style={{ marginLeft: 7 }}>
                          disparo há {rotuloDesde(u)}
                        </span>
                      )}
                    </span>
                    <span className="gpess">{g.participantes || 0} pessoas</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        {/* 4 · Ritmo & opções */}
        <div className="mcard ok">
          <div className="mcard-head">
            <span className="mnum"><Check size={13} /></span>
            <h4>Ritmo e opções</h4>
            <span className="mstate">{RITMOS[ritmo].sub}{mencao ? ' · menção LIGADA' : ''}</span>
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            {(Object.keys(RITMOS) as RitmoKey[]).map((k) => (
              <button key={k} type="button" className={'btn sm ' + (ritmo === k ? '' : 'ghost')} onClick={() => setRitmo(k)}>
                {RITMOS[k].label} <span style={{ fontSize: 11, opacity: 0.75 }}>({RITMOS[k].sub})</span>
              </button>
            ))}
          </div>
          <p className="mut" style={{ fontSize: 12, margin: '0 0 10px' }}>
            Cada número dispara <b>uma variação por vez</b> — nunca dois templates ao mesmo tempo no
            mesmo chip. Números diferentes (VIP 01 e 02) vão em paralelo.
          </p>
          <label className="row" style={{ gap: 8, cursor: 'pointer', margin: 0 }}>
            <input type="checkbox" checked={mencao} onChange={(e) => setMencao(e.target.checked)} />
            <AtSign size={15} /> Mencionar todos os participantes
            <span className="mut" style={{ fontSize: 12 }}>(padrão desligado — menos queda de grupo; volta a desligar a cada disparo)</span>
          </label>
        </div>

        {/* resumo fixo + CTA único */}
        <div className="mesa-foot">
          <span className="fres">
            {selecionadas.length > 0 ? <><b>{selecionadas.length}</b> variaç{selecionadas.length > 1 ? 'ões' : 'ão'}</> : 'sem copy'}
            {nMidias > 0 && <> + <b>{nMidias}</b> mídia{nMidias > 1 ? 's' : ''}</>}
            {' → '}
            {gruposSel.length > 0 ? <><b>{gruposSel.length}</b> grupos · ≈<b>{pessoas.toLocaleString('pt-BR')}</b> pessoas</> : 'sem alvo'}
            {' · '}{RITMOS[ritmo].sub}
            {mencao && <span style={{ color: 'var(--amber)' }}> · menção LIGADA</span>}
          </span>
          <button className="btn" disabled={!podeRevisar} onClick={() => setRevisando(true)}>
            <Send size={15} /> Revisar disparo
          </button>
        </div>
      </div>

      {/* celular fixo */}
      <div className="mesa-aside">
        {selecionadas.length > 1 && (
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            {selecionadas.map((v) => (
              <button key={v.id} type="button"
                className={'btn sm ' + (previewVar?.id === v.id ? '' : 'ghost')}
                onClick={() => setPreviewVarId(v.id)}>
                #{v.fila_id}.{v.idx}
              </button>
            ))}
          </div>
        )}
        <PhonePreview blocos={blocos} texto={previewVar?.texto ?? null} mencao={mencao} />
      </div>

      {/* ajuste de detalhe na copy, direto da mesa */}
      {editandoVar && (
        <Modal
          title="Ajustar copy"
          sub={`${vLabel(editandoVar)} · o disparo armado/enviado não muda; o próximo usa o texto novo`}
          onClose={() => setEditandoVar(null)}
        >
          <EditorCopyTexto
            id={editandoVar.id}
            textoAtual={editandoVar.texto}
            onSalvo={() => { setEditandoVar(null); onRecarregar?.() }}
            onFechar={() => setEditandoVar(null)}
          />
        </Modal>
      )}

      {/* revisão read-only */}
      {revisando && (
        <Modal
          title="Revisão do disparo"
          sub="Confere tudo aqui — depois da partida, lote que entra no motor não volta."
          onClose={() => !enviando && setRevisando(false)}
        >
          <div className="card" style={{ borderColor: 'var(--amber)', marginTop: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
              <b>
                Vai para {gruposSel.length} grupos · ≈{pessoas.toLocaleString('pt-BR')} pessoas — de verdade.
              </b>
            </div>
            <p className="mut" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Cada variação pega ~{porVariacao} grupos, {RITMOS[ritmo].sub} entre mensagens, uma
              variação por número de cada vez. A partida é em {PARTIDA_S}s e dá pra cancelar até lá.
            </p>
            {(() => {
              const nRecentes = gruposSel.filter((g) => emCooldown(g.gid)).length
              return nRecentes > 0 ? (
                <p style={{ fontSize: 12.5, color: 'var(--amber)', margin: '8px 0 0' }}>
                  {nRecentes} dos grupos marcados receberam disparo há menos de {COOLDOWN_H}h
                  (normal quando os disparos empilham no dia — só confere se é essa a intenção).
                </p>
              ) : null
            })()}
          </div>

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

          <div className="dispmeta" style={{ marginTop: 12, marginBottom: 0 }}>
            <span className="mchip">ritmo {RITMOS[ritmo].sub}</span>
            <span className="mchip" style={mencao ? { color: 'var(--amber)', borderColor: 'var(--amber)' } : undefined}>
              menção {mencao ? 'LIGADA' : 'desligada'}
            </span>
            <span className="mchip">{selecionadas.length} braços de teste</span>
          </div>

          {selecionadas.map((v) => (
            <div key={v.id} style={{ marginTop: 12 }}>
              <span className="mut" style={{ fontSize: 12 }}>{vLabel(v)} · ~{porVariacao} grupos</span>
              <div className="vcard on" style={{ marginTop: 4, cursor: 'default' }}>
                <span className="vtxt" style={{ WebkitLineClamp: 6 }}>{v.texto}</span>
              </div>
            </div>
          ))}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" disabled={enviando} onClick={armar}>
              <Send size={15} /> {enviando ? 'Armando…' : `Disparar em ${PARTIDA_S}s`}
            </button>
            <button className="btn ghost" disabled={enviando} onClick={() => setRevisando(false)}>
              Voltar e ajustar
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
