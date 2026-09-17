import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Send, Users, AtSign, AlertTriangle, Check, Pause, Play, XCircle, Zap, Rocket, Pencil, RefreshCw, Archive,
  CalendarClock, Eye,
} from 'lucide-react'
import type { CopyVariacao } from '../lib/copyDb'
import {
  sendflowGruposVip, sendflowDisparar, sendflowGruposUltimoEnvio,
  sendflowDisparoStatus, sendflowDisparoCancelar, sendflowDisparoAgora,
  sendflowDisparoPausar, sendflowDisparoRetomar, sendflowAtualizarGrupos,
  sendflowDisparosListar, sendflowDisparoReagendar,
} from '../lib/sendflowDb'
import type { SendflowGrupoVip, DisparoStatus, LoteStatus, DisparoResumo } from '../lib/sendflowDb'
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

// ===== Agendar com dia e hora (PRD 17/09, pedido do Peterson) =====
// A janela e a mesma do banco: ele recusa fora disso, a tela avisa antes pra ninguem
// tomar erro depois de revisar tudo.
const AGENDA_MIN_MIN = 5
const AGENDA_MAX_DIAS = 7
// A tela e SEMPRE mais rigida que o banco, nunca o contrario: o now() do banco acontece
// depois do nosso (latencia), entao sem folga existe uma faixa que a tela aceita e o banco
// recusa — e o operador so descobre depois de revisar tudo.
const AGENDA_FOLGA_MS = 60_000
// Brasilia e UTC-3: getTimezoneOffset() devolve 180. Relogio atrasado o banco pega (vira
// passado), mas FUSO errado passa limpo e o disparo sai horas fora.
const FUSO_BR_OFFSET = 180
// Fora disso a tela mostra aviso ambar, mas NAO bloqueia: quem decide a hora e o operador.
const HORA_BOA_DE = 8
const HORA_BOA_ATE = 22
// Dois disparos marcados perto um do outro disputam o mesmo chip: o segundo so sai
// quando o primeiro terminar de entregar. Avisar na hora de marcar evita a surpresa.
const PERTO_MIN = 30

// <input type="datetime-local"> fala no fuso do computador; o banco guarda timestamptz.
// Estas duas funcoes sao a ponte, e sao a unica conversao de fuso da tela.
function paraInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
function doInput(v: string): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
// cedo demais pro banco aceitar (com a folga). paraInput corta os segundos, entao o "min"
// do campo sobe pro minuto seguinte: nada de oferecer um minuto que a validacao recusa.
function cedoDemais(t: number) {
  return t < Date.now() + AGENDA_MIN_MIN * 60_000 + AGENDA_FOLGA_MS
}
function minDoInput() {
  const t = Date.now() + AGENDA_MIN_MIN * 60_000 + AGENDA_FOLGA_MS
  return paraInput(new Date(Math.ceil(t / 60_000) * 60_000))
}

// "hoje 17:00" / "amanha 12:00" / "sab, 20/09 17:00"
function quandoLongo(iso: string) {
  const d = new Date(iso)
  const hoje = new Date()
  const amanha = new Date(hoje)
  amanha.setDate(hoje.getDate() + 1)
  const hhmm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === hoje.toDateString()) return `hoje ${hhmm}`
  if (d.toDateString() === amanha.toDateString()) return `amanhã ${hhmm}`
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
  return `${dia.replace('.', '')} ${hhmm}`
}

// "em 3h20" / "em 12 min" / "agora" — o quanto falta, em linguagem de gente
function faltaPara(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'agora'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `em ${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m > 0 ? `em ${h}h${String(m).padStart(2, '0')}` : `em ${h}h`
  return `em ${Math.round(h / 24)} dias`
}

const SITUACAO: Record<DisparoResumo['situacao'], { label: string; cls: string }> = {
  agendado: { label: 'agendado', cls: 'b-agendado' },
  armado: { label: 'armado', cls: 'b-agendado' },
  // 'pausado' nasceu no gate: antes um disparo parado pela mao do operador aparecia como
  // "rodando" e a tela escondia o "Mudar horário" de algo que nao estava saindo.
  pausado: { label: 'pausado', cls: 'b-pausada' },
  rodando: { label: 'indo pro motor', cls: 'b-rodando' },
  entregue: { label: 'entregue ao motor', cls: 'b-concluida' },
  erro: { label: 'terminou com erro', cls: 'b-erro' },
  cancelado: { label: 'cancelado', cls: 'b-cancelada' },
}

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

// cabecalho do pedido: "hoje 11:59" / "ontem 20:10" / "02/09 19:18"
function quandoPedido(iso: string) {
  const d = new Date(iso)
  const hoje = new Date()
  const ontem = new Date(hoje)
  ontem.setDate(hoje.getDate() - 1)
  const hhmm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === hoje.toDateString()) return `hoje ${hhmm}`
  if (d.toDateString() === ontem.toDateString()) return `ontem ${hhmm}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hhmm}`
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
  // agendar (PRD 17/09): quando vazio, o botao dispara em 60s como sempre
  const [agendar, setAgendar] = useState(false)
  const [quando, setQuando] = useState('')
  const [agendados, setAgendados] = useState<DisparoResumo[]>([])
  const [reagendandoId, setReagendandoId] = useState<string | null>(null)
  const [reagendaQuando, setReagendaQuando] = useState('')
  const [cancelandoId, setCancelandoId] = useState<string | null>(null)
  // "Começar já" manda um disparo em massa AGORA: pede confirmação igual ao cancelar
  const [comecarId, setComecarId] = useState<string | null>(null)
  const [vivoId, setVivoId] = useState<string | null>(null)
  const [st, setSt] = useState<DisparoStatus | null>(null)
  const [agora, setAgora] = useState(Date.now())
  const [confirmaAborto, setConfirmaAborto] = useState(false)
  const [agindo, setAgindo] = useState(false)
  // ajuste de detalhe sem cancelar a copy (PRD_copyia_editar_variacao_2026-08-31)
  const [editandoVar, setEditandoVar] = useState<CopyVariacao | null>(null)
  const [sincronizando, setSincronizando] = useState(false)
  // PRD 09/09 (Peterson): so o ultimo pedido aberto; o resto mora no "Arquivo de copy"
  const [arquivoAberto, setArquivoAberto] = useState(false)
  // campanha de OUTRO projeto (ex.: JA) nunca aparece por padrao; revelar e ato consciente
  const [mostrarFora, setMostrarFora] = useState(false)

  // Peterson mexeu nos grupos direto no SendFlow (31/08): enfileira a coleta AGORA
  // (a diária é só 6:05) e re-busca os grupos enquanto o worker de 1 min processa.
  async function atualizarGrupos() {
    if (sincronizando) return
    setSincronizando(true)
    try {
      const r = await sendflowAtualizarGrupos()
      toast(r.ja_pendente
        ? 'Já tem uma atualização a caminho, os números chegam em ~1 min'
        : 'Atualização pedida ao SendFlow, os números chegam em ~1 min')
      ;[30_000, 60_000, 90_000].forEach((ms, i, arr) =>
        setTimeout(() => {
          sendflowGruposVip(null, true).then(setGrupos).catch(() => {})
          if (i === arr.length - 1) setSincronizando(false)
        }, ms),
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
      setSincronizando(false)
    }
  }

  // cooldown é conveniência: sem ele a mesa segue funcionando
  const carregarCooldown = useCallback(() => {
    sendflowGruposUltimoEnvio()
      .then((rows) => setUltimoEnvio(new Map(rows.map((r) => [r.gid, r.ultimo_em]))))
      .catch(() => {})
  }, [])

  // a lista de disparos vem do BANCO: um agendado aparece em qualquer maquina e
  // sobrevive a fechar o navegador (o localStorage segue so como atalho do vivo)
  const carregarAgendados = useCallback(
    () => sendflowDisparosListar(2).then(setAgendados).catch(() => {}),
    [],
  )

  useEffect(() => {
    sendflowGruposVip(null, true)
      .then(setGrupos)
      .catch((e) => setErroGrupos(e instanceof Error ? e.message : 'Não consegui carregar os grupos.'))
    carregarCooldown()
    carregarAgendados()
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

  // enquanto houver disparo marcado ou andando, a lista se atualiza sozinha (30s).
  // Sem nada aberto, os timers param: a tela nao fica batendo no banco a toa.
  const temAberto = agendados.some(
    (d) => d.situacao === 'agendado' || d.situacao === 'armado' || d.situacao === 'pausado' || d.situacao === 'rodando',
  )
  useEffect(() => {
    if (!temAberto) return
    const t = setInterval(() => {
      carregarAgendados()
      setAgora(Date.now())
    }, 30_000)
    return () => clearInterval(t)
  }, [temAberto, carregarAgendados])

  // "mesa" = o que "Todas VIP" marca (SO o projeto); "visiveis" = o que a lista mostra.
  // Revelar outras campanhas mostra as linhas e as pills ambar, mas nunca muda o que o
  // botao de sempre marca em bloco (revisao 09/09: Todas VIP arrastava JA + Rox Premios).
  const gruposMesa = useMemo(() => grupos.filter((g) => !g.fora_da_mesa), [grupos])
  const gruposVisiveis = useMemo(
    () => (mostrarFora ? grupos : gruposMesa),
    [grupos, gruposMesa, mostrarFora],
  )
  const nFora = grupos.length - gruposMesa.length
  const releasesFora = new Set(grupos.filter((g) => g.fora_da_mesa).map((g) => g.release_id)).size
  const releases = useMemo(() => {
    const m = new Map<string, { nome: string; fora: boolean }>()
    gruposVisiveis.forEach((g) => m.set(g.release_id, { nome: g.release_nome, fora: g.fora_da_mesa }))
    // as de fora vao pro fim da fileira: o aviso ambar se destaca
    return [...m.entries()]
      .map(([id, r]) => ({ id, nome: r.nome, fora: r.fora }))
      .sort((a, b) => Number(a.fora) - Number(b.fora))
  }, [gruposVisiveis])

  // esconder de novo poda a selecao fantasma (grupo de fora marcado e depois escondido)
  function alternarFora() {
    if (mostrarFora) {
      const foraIds = new Set(grupos.filter((g) => g.fora_da_mesa).map((g) => g.gid))
      setSelGids((s) => new Set([...s].filter((gid) => !foraIds.has(gid))))
    }
    setMostrarFora((v) => !v)
  }
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
  const gruposSel = gruposVisiveis.filter((g) => selGids.has(g.gid))
  const gruposSelFora = gruposSel.filter((g) => g.fora_da_mesa)
  const ultimoPedido = porPedido[0]
  const arquivo = porPedido.slice(1)
  const nArquivo = arquivo.reduce((s, p) => s + p.vs.length, 0)
  const selNoArquivo = selecionadas.filter((v) => v.fila_id !== ultimoPedido?.fid).length
  const pessoas = gruposSel.reduce((s, g) => s + (g.participantes || 0), 0)
  const erroSequencia = sequenciaValida(blocos)
  const nMidias = blocos.filter((b) => b.tipo === 'midia').length
  const podeRevisar = selecionadas.length > 0 && gruposSel.length > 0 && !erroSequencia

  // ===== hora do agendamento: sugestao, atalhos e os dois avisos =====
  const quandoData = useMemo(() => doInput(quando), [quando])

  // atalhos do dia a dia do Peterson (o pico dele e 17h; 12h e o outro horario forte).
  // "hoje" some quando ja passou: atalho que nao da pra usar e so ruido.
  const atalhos = useMemo(() => {
    const monta = (diasAFrente: number, hora: number) => {
      const d = new Date()
      d.setDate(d.getDate() + diasAFrente)
      d.setHours(hora, 0, 0, 0)
      return d
    }
    const lista = [
      { label: 'hoje 17h', data: () => monta(0, 17) },
      { label: 'amanhã 12h', data: () => monta(1, 12) },
      { label: 'amanhã 17h', data: () => monta(1, 17) },
    ]
    return lista.filter((a) => !cedoDemais(a.data().getTime()))
    // recalcula tambem ao ABRIR a revisao: com a aba parada o relogio interno nao anda,
    // e o atalho ficava congelado no momento em que a tela montou (podia oferecer 17h as 17h10)
  }, [agora, revisando])

  const avisoHora = useMemo(() => {
    if (!quandoData) return ''
    const h = quandoData.getHours()
    if (h < HORA_BOA_DE || h >= HORA_BOA_ATE) {
      return `${String(h).padStart(2, '0')}h está fora do horário que a operação costuma usar (${HORA_BOA_DE}h às ${HORA_BOA_ATE}h). Dá pra agendar assim mesmo, só confere se é isso.`
    }
    return ''
  }, [quandoData])

  // dois disparos marcados perto disputam o mesmo chip: o segundo espera o primeiro
  const avisoPerto = useMemo(() => {
    if (!quandoData) return ''
    const perto = agendados.filter((d) => {
      if (!d.agendado_para) return false
      if (d.situacao !== 'agendado' && d.situacao !== 'armado') return false
      return Math.abs(new Date(d.agendado_para).getTime() - quandoData.getTime()) < PERTO_MIN * 60_000
    })
    if (perto.length === 0) return ''
    return `Já tem ${perto.length} disparo marcado por perto (${perto.map((d) => quandoLongo(d.agendado_para as string)).join(', ')}). Um número manda um lote por vez, então o segundo só sai quando o primeiro terminar de entregar.`
  }, [quandoData, agendados])

  // sugestao de hora ao abrir o campo: o proximo horario de pico que ainda cabe
  function sugestaoHora() {
    const a = atalhos[0]?.data()
    return a && !cedoDemais(a.getTime()) ? a : new Date(Date.now() + 60 * 60_000)
  }

  // fuso errado no PC passa limpo pelo banco (a hora vira outra no Brasil) e nada avisaria
  const fusoEstranho = new Date().getTimezoneOffset() !== FUSO_BR_OFFSET
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
    const alvo = rid === null ? gruposMesa : gruposVisiveis.filter((g) => g.release_id === rid)
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
    // agendado: valida a hora ANTES de mandar, com a mesma regua do banco
    let quandoISO: string | null = null
    if (agendar) {
      const d = doInput(quando)
      if (!d) return toast('Escolhe o dia e a hora do disparo', true)
      if (cedoDemais(d.getTime())) {
        return toast(`A hora tem que ser pelo menos ${AGENDA_MIN_MIN} minutos à frente`, true)
      }
      if (d.getTime() > Date.now() + AGENDA_MAX_DIAS * 86_400_000) {
        return toast(`Dá pra agendar no máximo ${AGENDA_MAX_DIAS} dias à frente`, true)
      }
      quandoISO = d.toISOString()
    }
    setEnviando(true)
    try {
      const r = await sendflowDisparar(
        gruposSel.map((g) => g.gid),
        selecionadas.map((v) => v.id),
        mencao, RITMOS[ritmo].min, RITMOS[ritmo].max,
        blocosParaRpc(blocos), quandoISO ? 0 : PARTIDA_S, quandoISO,
      )
      setRevisando(false)
      const extra = r.ignorados_n ? ` · ${r.ignorados_n} grupos ignorados (sumiram)` : ''
      if (quandoISO) {
        // agendado nao abre o painel de contagem: ele vive no cartao "Agendados"
        // e a mesa fica limpa pro proximo (o texto revisado ja foi congelado no banco).
        await carregarAgendados()
        setAgendar(false)
        setQuando('')
        resetMesa()
        toast(`Disparo agendado para ${quandoLongo(quandoISO)}${extra}`)
      } else {
        setVivoId(r.disparo_id)
        localStorage.setItem(LS_VIVO, r.disparo_id)
        const s = await sendflowDisparoStatus(r.disparo_id).catch(() => null)
        if (s) setSt(s)
        toast(`Disparo armado: parte em ${PARTIDA_S}s${extra}`)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setEnviando(false)
    }
  }

  // ===== acoes do cartao "Agendados" =====
  async function reagendar(id: string) {
    const d = doInput(reagendaQuando)
    if (!d) return toast('Escolhe a hora nova', true)
    if (cedoDemais(d.getTime())) {
      return toast(`A hora tem que ser pelo menos ${AGENDA_MIN_MIN} minutos à frente`, true)
    }
    if (d.getTime() > Date.now() + AGENDA_MAX_DIAS * 86_400_000) {
      return toast(`Dá pra agendar no máximo ${AGENDA_MAX_DIAS} dias à frente`, true)
    }
    if (agindo) return
    setAgindo(true)
    try {
      const r = await sendflowDisparoReagendar(id, d.toISOString())
      // o banco recusa se algum lote ja saiu: a tela conta a verdade dele, nao a minha
      if (!r.ok) toast(r.erro ?? 'Não consegui mudar a hora', true)
      else toast(`Disparo remarcado para ${quandoLongo(d.toISOString())}`)
      setReagendandoId(null)
      setReagendaQuando('')
      await carregarAgendados()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setAgindo(false)
    }
  }

  // Retomar devolve o lote pra `greatest(now(), agendado_para)`. Se a hora marcada JA PASSOU
  // (e passou em todo caminho que produz um pausado), isso quer dizer: sai no proximo minuto.
  // A tela dizia o contrario. Agora conta a verdade e o toast fala o que o banco devolveu.
  async function retomarDisparo(id: string, horaPassou: boolean) {
    if (agindo) return
    setAgindo(true)
    try {
      const r = await sendflowDisparoRetomar(id)
      if (r.retomados > 0) {
        toast(horaPassou
          ? `${r.retomados} lote(s) retomados, o motor pega no próximo minuto`
          : `${r.retomados} lote(s) retomados para a hora marcada`)
      } else {
        toast('Não retomei nada: esse disparo já saiu ou foi cancelado. Abre em Acompanhar pra ver.', true)
      }
      await carregarAgendados()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setAgindo(false)
      setComecarId(null)
    }
  }

  // "Começar já" pode nao liberar nada (o motor pegou o lote no mesmo minuto, ou o disparo
  // foi cancelado de outra maquina). A tela conta o que o banco devolveu, nao um texto fixo.
  async function comecarJa(id: string) {
    if (agindo) return
    setAgindo(true)
    try {
      const r = await sendflowDisparoAgora(id)
      if (r.liberados > 0) toast(`${r.liberados} lote(s) liberados, o motor pega no próximo minuto`)
      else toast('Não liberei nada: esse disparo já saiu, foi cancelado ou está pausado. Abre em Acompanhar pra ver.', true)
      await carregarAgendados()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setAgindo(false)
      setComecarId(null)
    }
  }

  async function cancelarAgendado(id: string) {
    if (agindo) return
    setAgindo(true)
    try {
      const r = await sendflowDisparoCancelar(id)
      if (r.ja_no_motor > 0) {
        toast(`${r.cancelados} lotes cancelados, ${r.ja_no_motor} já estavam no motor e vão até o fim`, true)
      } else {
        toast('Disparo cancelado, nada foi enviado')
      }
      await carregarAgendados()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setAgindo(false)
      setCancelandoId(null)
    }
  }

  async function acompanhar(id: string) {
    const s = await sendflowDisparoStatus(id).catch(() => null)
    if (!s) return toast('Não consegui abrir esse disparo', true)
    setVivoId(id)
    setSt(s)
    // so gruda no localStorage o que ja esta acontecendo: um agendado de amanha nao pode
    // sequestrar a mesa depois de um refresh
    const futuro = s.agendado_para != null && new Date(s.agendado_para).getTime() > Date.now()
    if (!futuro) localStorage.setItem(LS_VIVO, id)
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
        toast(`${r.cancelados} lotes cancelados, ${r.ja_no_motor} já estavam no motor e vão até o fim`, true)
        const s = await sendflowDisparoStatus(vivoId).catch(() => null)
        if (s) setSt(s)
      } else {
        toast('Disparo cancelado, nada foi enviado')
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
    carregarAgendados()
  }

  // ===== cartao "Agendados" =====
  // Fica visivel na mesa E no painel vivo: disparo marcado pra amanha nao pode
  // depender de o Peterson lembrar que marcou.
  const abertos = agendados.filter(
    (d) => d.situacao === 'agendado' || d.situacao === 'armado' || d.situacao === 'pausado' || d.situacao === 'rodando',
  )
  // o disparo que ja esta aberto no painel vivo nao se repete aqui
  const marcados = abertos.filter((d) => d.agendado_para && d.disparo_id !== vivoId)

  function cartaoAgendados() {
    if (marcados.length === 0) return null
    return (
      <div className="card agendados">
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <CalendarClock size={17} style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0 }}>
            Agendados ({marcados.length})
          </h3>
        </div>
        <p className="mut" style={{ fontSize: 12.5, marginTop: 0 }}>
          A mensagem já está guardada do jeito que você revisou. Até <b>perto</b> da hora marcada dá
          pra mudar o horário, começar na hora ou cancelar. No minuto da hora marcada o motor pode já
          ter pego o lote, e lote que entra no motor do SendFlow vai até o fim.
        </p>
        {marcados.map((d) => {
          const r = d.resumo
          // agendado_para = a hora que o operador marcou (nunca muda).
          // partida_em = quando o motor PODE pegar. Depois de um 403/429 o banco empurra
          // pra +61 min, e sem olhar isso a tela dizia "saindo agora" na hora original
          // de um disparo que so vai tentar de novo daqui uma hora.
          const marcadoMs = new Date(d.agendado_para as string).getTime()
          const partiuMs = d.partida_em ? new Date(d.partida_em).getTime() : null
          const remarcado = partiuMs != null && partiuMs > marcadoMs + 120_000
          const passou = marcadoMs <= Date.now()
          const atrasado = passou && Date.now() - marcadoMs > 10 * 60_000
          const parado = r.paused > 0 && r.sending === 0
          const mexivel = d.situacao === 'agendado' || d.situacao === 'armado'
          return (
            <div key={d.disparo_id} className="agrow">
              <div className="agwhen">
                <b>{quandoLongo(d.agendado_para as string)}</b>
                <span className="mut">
                  {remarcado
                    ? `o motor remarcou pra ${quandoLongo(d.partida_em as string)}`
                    : atrasado
                      ? 'marcado pra essa hora, ainda não saiu'
                      : passou
                        ? 'saindo agora'
                        : faltaPara(d.agendado_para as string)}
                </span>
              </div>
              <div className="agbody">
                <div className="row" style={{ gap: 7 }}>
                  {/* o selo sai do RESUMO, nao so da situacao: lote pausado nunca pode
                      aparecer como "indo pro motor", venha o que vier do banco */}
                  <span className={`badge ${parado ? 'b-pausada' : SITUACAO[d.situacao].cls}`}>
                    {parado ? 'pausado, esperando você' : SITUACAO[d.situacao].label}
                  </span>
                  <span className="mut" style={{ fontSize: 12.5 }}>
                    <b style={{ color: 'var(--txt)' }}>{r.grupos_total}</b> grupos · {d.campanhas.join(', ')}
                    {d.variacoes.length > 1 ? ` · ${d.variacoes.length} variações` : ''}
                    {d.blocos > 1 ? ` · ${d.blocos - 1} mídia${d.blocos > 2 ? 's' : ''} + copy` : ''}
                    {d.mencao ? ' · menção LIGADA' : ''}
                  </span>
                </div>
                {d.previa && <p className="agprevia">{d.previa}</p>}
                {d.situacao === 'rodando' && (
                  <p className="mut" style={{ fontSize: 12, margin: '4px 0 0' }}>
                    {r.grupos_feitos} de {r.grupos_total} grupos entregues ao motor
                  </p>
                )}
                {r.grupos_removidos > 0 && (
                  <p style={{ fontSize: 12, color: 'var(--amber)', margin: '4px 0 0' }}>
                    {r.grupos_removidos} grupo{r.grupos_removidos > 1 ? 's sumiram' : ' sumiu'} depois de
                    agendado e saiu do envio
                  </p>
                )}
                {parado && (
                  <p style={{ fontSize: 12, color: 'var(--amber)', margin: '4px 0 0' }}>
                    Este disparo está <b>parado e não vai sair sozinho</b>.{' '}
                    {passou
                      ? `A hora marcada (${quandoLongo(d.agendado_para as string)}) já passou, então Retomar manda no próximo minuto, não espera mais nada. Se não é isso que você quer, usa Cancelar.`
                      : 'Retomar devolve ele para a hora marcada, não dispara agora.'}
                  </p>
                )}
                {/* aviso que nao sai e falha silenciosa: quem agendou precisa ver na tela */}
                {d.situacao === 'rodando' && !d.aviso_partiu_ok && passou
                  && Date.now() - marcadoMs > 5 * 60_000 && (
                  <p style={{ fontSize: 12, color: 'var(--amber)', margin: '4px 0 0' }}>
                    O aviso no grupo Logs SendHX ainda não saiu. O disparo segue normal.
                  </p>
                )}
                {reagendandoId === d.disparo_id ? (
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <input
                      id={`reagenda-${d.disparo_id}`}
                      type="datetime-local"
                      value={reagendaQuando}
                      min={minDoInput()}
                      max={paraInput(new Date(Date.now() + AGENDA_MAX_DIAS * 86_400_000))}
                      onChange={(e) => setReagendaQuando(e.target.value)}
                    />
                    <button className="btn sm" disabled={agindo} onClick={() => reagendar(d.disparo_id)}>
                      Salvar hora
                    </button>
                    <button className="btn sm ghost" onClick={() => { setReagendandoId(null); setReagendaQuando('') }}>
                      Voltar
                    </button>
                  </div>
                ) : comecarId === d.disparo_id ? (
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <span className="mut" style={{ fontSize: 12.5 }}>
                      Mandar <b style={{ color: 'var(--txt)' }}>agora</b> o disparo de{' '}
                      {quandoLongo(d.agendado_para as string)}, {r.grupos_total} grupos?
                    </span>
                    <button
                      className="btn sm danger"
                      disabled={agindo}
                      onClick={() => (parado ? retomarDisparo(d.disparo_id, true) : comecarJa(d.disparo_id))}
                    >
                      Sim, mandar agora
                    </button>
                    <button className="btn sm ghost" onClick={() => setComecarId(null)}>Voltar</button>
                  </div>
                ) : cancelandoId === d.disparo_id ? (
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <span className="mut" style={{ fontSize: 12.5 }}>
                      Cancela o disparo de {quandoLongo(d.agendado_para as string)}?
                    </span>
                    <button className="btn sm danger" disabled={agindo} onClick={() => cancelarAgendado(d.disparo_id)}>
                      Sim, cancelar
                    </button>
                    <button className="btn sm ghost" onClick={() => setCancelandoId(null)}>Voltar</button>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    {mexivel && (
                      <>
                        <button
                          className="btn sm ghost"
                          disabled={agindo}
                          onClick={() => {
                            setReagendandoId(d.disparo_id)
                            setReagendaQuando(paraInput(new Date(d.agendado_para as string)))
                          }}
                        >
                          <CalendarClock size={13} /> Mudar horário
                        </button>
                        <button
                          className="btn sm ghost"
                          disabled={agindo}
                          onClick={() => setComecarId(d.disparo_id)}
                        >
                          <Zap size={13} /> Começar já
                        </button>
                      </>
                    )}
                    {parado && (
                      <button
                        className="btn sm ghost"
                        disabled={agindo}
                        // hora ja passou = retomar E disparar: passa pela mesma confirmacao
                        // de dois passos do "Começar já", que e o que ele de fato faz
                        onClick={() => (passou ? setComecarId(d.disparo_id) : retomarDisparo(d.disparo_id, false))}
                      >
                        <Play size={13} /> {passou ? 'Retomar e disparar agora' : 'Retomar'}
                      </button>
                    )}
                    <button className="btn sm ghost" disabled={agindo} onClick={() => acompanhar(d.disparo_id)}>
                      <Eye size={13} /> Acompanhar
                    </button>
                    {r.pending + r.paused > 0 && (
                      <button className="btn sm ghost red" disabled={agindo} onClick={() => setCancelandoId(d.disparo_id)}>
                        <XCircle size={13} /> Cancelar
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // sem copy aprovada nao ha o que disparar
  if (aprovadas.length === 0) return null

  // ===================== PAINEL VIVO (armado / andamento / terminou) =====================
  if (vivoId && !st) {
    return (
      <>
        {cartaoAgendados()}
        <div className="card" style={{ borderColor: 'var(--accent)', maxWidth: 720 }}>
          <p className="mut" style={{ margin: 0 }}>
            <span className="spin" /> Carregando o disparo…
          </p>
        </div>
      </>
    )
  }
  if (vivoId && st) {
    const r = st.resumo
    const terminou = r.total > 0 && r.pending + r.paused + r.sending === 0
    // num disparo marcado, a contagem regressiva grande nao faz sentido (pode faltar
    // um dia): quem manda na tela e a hora marcada, nao o relogio de segundos.
    const marcado = st.agendado_para
    const partidaMs = st.partida_em ? new Date(st.partida_em).getTime() : null
    const faltam = partidaMs ? Math.max(0, Math.ceil((partidaMs - agora) / 1000)) : 0
    const armado = !terminou && r.done + r.sending + r.error === 0 && faltam > 0 && !marcado
    const esperandoHora = !terminou && r.done + r.sending + r.error === 0 && faltam > 0 && !!marcado
    const pct = r.grupos_total > 0 ? Math.round((r.grupos_feitos / r.grupos_total) * 100) : 0

    return (
      <>
      {cartaoAgendados()}
      <div className="card" style={{ borderColor: 'var(--accent)', maxWidth: 720 }}>
        {esperandoHora && (
          <div className="armado">
            <p className="mut" style={{ margin: '0 0 6px', fontSize: 13 }}>Disparo marcado para</p>
            <div className="cd cd-data">{quandoLongo(marcado)}</div>
            <p className="mut" style={{ fontSize: 12.5, margin: '10px auto 18px', maxWidth: 420 }}>
              {faltaPara(marcado)} · {r.total} lotes ·{' '}
              <b style={{ color: 'var(--txt)' }}>{r.grupos_total} grupos</b>. A mensagem já está
              guardada. Até perto da hora dá pra cancelar; depois que um lote entra no motor do
              SendFlow, ele vai até o fim.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button
                className="btn"
                disabled={agindo}
                onClick={() => acao(() => sendflowDisparoAgora(vivoId), 'Liberado, o motor pega no próximo minuto')}
              >
                <Zap size={15} /> Começar já
              </button>
              <button className="btn ghost" disabled={agindo} onClick={() => encerrarVivo(false)}>
                Voltar pra mesa
              </button>
              <button className="btn ghost red" disabled={agindo} onClick={cancelarArmado}>
                <XCircle size={15} /> Cancelar disparo
              </button>
            </div>
          </div>
        )}
        {!esperandoHora && (
        <>
        {armado ? (
          <div className="armado">
            <p className="mut" style={{ margin: '0 0 6px', fontSize: 13 }}>
              Disparo armado, parte em
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
                onClick={() => acao(() => sendflowDisparoAgora(vivoId), 'Partida liberada, o motor pega no próximo minuto')}
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
                : 'Lote entregue ao motor não tem volta. Pausar ou cancelar vale só pro que ainda está na fila.'}
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
                  {l.n_removidos > 0 && (
                    <span className="mut"> · {l.n_removidos} sumiram antes do envio</span>
                  )}
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
        </>
        )}
      </div>
      </>
    )
  }

  // ===================== A MESA (4 cartões + celular) =====================
  return (
    <>
    {cartaoAgendados()}
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
            (round-robin) pra medir qual segura mais o grupo. Clica pra escolher, a última clicada
            aparece no celular ao lado.
          </p>
          {(arquivoAberto ? porPedido : porPedido.slice(0, 1)).map(({ fid, vs }) => (
            <div key={fid} style={{ marginBottom: 10 }}>
              <span className="mut" style={{ fontSize: 11.5 }}>
                Pedido #{fid} · {quandoPedido(vs[0].criado_em)}{fid === ultimoPedido?.fid ? ' · o mais recente' : ''}
              </span>
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
          {arquivo.length > 0 && (
            <button type="button" className="btn sm ghost" onClick={() => setArquivoAberto((v) => !v)}>
              <Archive size={13} />
              {arquivoAberto
                ? 'Fechar o arquivo'
                : `Arquivo de copy (${arquivo.length} pedidos · ${nArquivo} copies)${selNoArquivo > 0 ? ` · ${selNoArquivo} escolhida${selNoArquivo > 1 ? 's' : ''} lá dentro` : ''}`}
            </button>
          )}
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
              <Users size={13} /> Todas VIP ({gruposMesa.length})
            </button>
            {releases.map((rl) => (
              <button key={rl.id} type="button" className="btn sm ghost" onClick={() => toggleRelease(rl.id)}
                title={rl.fora ? 'Campanha de OUTRO projeto: confere antes de marcar' : undefined}
                style={rl.fora ? { color: 'var(--amber)' } : undefined}>
                {rl.fora ? '⚠ ' : ''}{rl.nome} ({gruposVisiveis.filter((g) => g.release_id === rl.id).length})
              </button>
            ))}
            {selGids.size > 0 && (
              <button type="button" className="btn sm ghost" onClick={() => setSelGids(new Set())}>Limpar</button>
            )}
            <button type="button" className="btn sm ghost" disabled={sincronizando} onClick={atualizarGrupos}
              title="Excluiu ou criou grupo direto no SendFlow? Puxa a lista de lá agora (a automática é 1x por dia).">
              <RefreshCw size={13} className={sincronizando ? 'girando' : undefined} />
              {sincronizando ? 'Atualizando…' : 'Atualizar do SendFlow'}
            </button>
          </div>
          <p className="mut" style={{ fontSize: 11.5, margin: '0 0 8px' }}>
            O selo mostra há quanto tempo o grupo recebeu o último disparo (âmbar = menos de{' '}
            {COOLDOWN_H}h). É só informação, marcar em bloco marca todo mundo.
          </p>
          {nFora > 0 && (
            <button type="button" className="btn sm ghost" style={{ marginBottom: 8 }}
              onClick={alternarFora}
              title="Campanhas de outro projeto ficam escondidas por padrão">
              {mostrarFora
                ? 'Esconder outras campanhas'
                : `Mostrar outras campanhas (${releasesFora} · ${nFora} grupos)`}
            </button>
          )}
          {erroGrupos && <p className="st-falha" style={{ fontSize: 12 }}>{erroGrupos}</p>}
          {gruposVisiveis.length > 0 && (
            <div className="galvo">
              {gruposVisiveis.map((g) => {
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
            Cada número dispara <b>uma variação por vez</b>, nunca dois templates ao mesmo tempo no
            mesmo chip. Números diferentes (VIP 01 e 02) vão em paralelo.
          </p>
          <label className="row" style={{ gap: 8, cursor: 'pointer', margin: 0 }}>
            <input type="checkbox" checked={mencao} onChange={(e) => setMencao(e.target.checked)} />
            <AtSign size={15} /> Mencionar todos os participantes
            <span className="mut" style={{ fontSize: 12 }}>(padrão desligado, menos queda de grupo; volta a desligar a cada disparo)</span>
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
          sub="Confere tudo aqui: depois da partida, lote que entra no motor não volta."
          onClose={() => !enviando && setRevisando(false)}
        >
          <div className="card" style={{ borderColor: 'var(--amber)', marginTop: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
              <b>
                Vai para {gruposSel.length} grupos · ≈{pessoas.toLocaleString('pt-BR')} pessoas, de verdade.
              </b>
            </div>
            <p className="mut" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Cada variação pega ~{porVariacao} grupos, {RITMOS[ritmo].sub} entre mensagens, uma
              variação por número de cada vez.{' '}
              {agendar
                ? quandoData
                  ? `Sai ${quandoLongo(quandoData.toISOString())}. Até perto da hora dá pra cancelar; no minuto da hora marcada o motor pode já ter pego o lote, e lote que entra no motor vai até o fim.`
                  : 'Escolhe o dia e a hora aqui embaixo.'
                : `A partida é em ${PARTIDA_S}s e dá pra cancelar até lá.`}
            </p>
            {gruposSelFora.length > 0 && (
              <p style={{ fontSize: 12.5, color: 'var(--amber)', margin: '8px 0 0' }}>
                ⚠ {gruposSelFora.length} dos grupos marcados são de OUTRA campanha (
                {[...new Set(gruposSelFora.map((g) => g.release_nome))].join(', ')}). Confere se é isso mesmo.
              </p>
            )}
            {(() => {
              const nRecentes = gruposSel.filter((g) => emCooldown(g.gid)).length
              return nRecentes > 0 ? (
                <p style={{ fontSize: 12.5, color: 'var(--amber)', margin: '8px 0 0' }}>
                  {nRecentes} dos grupos marcados receberam disparo há menos de {COOLDOWN_H}h
                  (normal quando os disparos empilham no dia, só confere se é essa a intenção).
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

          {/* quando sai: agora (60s) ou dia e hora marcados (pedido do Peterson, 17/09) */}
          <div className="quando-box">
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className={'btn sm ' + (agendar ? 'ghost' : '')}
                onClick={() => setAgendar(false)}
              >
                <Send size={13} /> Disparar em {PARTIDA_S}s
              </button>
              <button
                type="button"
                className={'btn sm ' + (agendar ? '' : 'ghost')}
                onClick={() => {
                  setAgendar(true)
                  if (!quando) setQuando(paraInput(sugestaoHora()))
                }}
              >
                <CalendarClock size={13} /> Agendar dia e hora
              </button>
            </div>
            {agendar && (
              <div className="quando-campo">
                <label htmlFor="agenda-quando">Dia e hora do disparo</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    id="agenda-quando"
                    type="datetime-local"
                    value={quando}
                    min={minDoInput()}
                    max={paraInput(new Date(Date.now() + AGENDA_MAX_DIAS * 86_400_000))}
                    onChange={(e) => setQuando(e.target.value)}
                  />
                  {atalhos.map((a) => (
                    <button key={a.label} type="button" className="btn sm ghost"
                      onClick={() => setQuando(paraInput(a.data()))}>
                      {a.label}
                    </button>
                  ))}
                </div>
                {quandoData && (
                  <p className="mut" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
                    Sai <b style={{ color: 'var(--txt)' }}>{quandoLongo(quandoData.toISOString())}</b>,{' '}
                    {faltaPara(quandoData.toISOString())}. A mensagem fica guardada do jeito que está
                    aqui: se editar a copy depois, este disparo não muda.
                  </p>
                )}
                {avisoHora && (
                  <p style={{ fontSize: 12.5, color: 'var(--amber)', margin: '6px 0 0' }}>⚠ {avisoHora}</p>
                )}
                {avisoPerto && (
                  <p style={{ fontSize: 12.5, color: 'var(--amber)', margin: '6px 0 0' }}>⚠ {avisoPerto}</p>
                )}
                {fusoEstranho && (
                  <p style={{ fontSize: 12.5, color: 'var(--amber)', margin: '6px 0 0' }}>
                    ⚠ O relógio deste computador não está no horário de Brasília. A hora marcada aqui
                    vale pelo relógio DESTE computador, e o aviso no WhatsApp vai mostrar a hora de
                    Brasília. Confere o fuso do Windows antes de agendar.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <button id="cta-disparo" className="btn" disabled={enviando || (agendar && !quandoData)} onClick={armar}>
              {agendar ? <CalendarClock size={15} /> : <Send size={15} />}{' '}
              {enviando
                ? 'Armando…'
                : agendar
                  ? quandoData ? `Agendar para ${quandoLongo(quandoData.toISOString())}` : 'Escolhe o dia e a hora'
                  : `Disparar em ${PARTIDA_S}s`}
            </button>
            <button className="btn ghost" disabled={enviando} onClick={() => setRevisando(false)}>
              Voltar e ajustar
            </button>
          </div>
        </Modal>
      )}
    </div>
    </>
  )
}
