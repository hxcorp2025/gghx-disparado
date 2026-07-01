import { useEffect, useMemo, useState } from 'react'
import type { ViewId } from '../App'
import { useApp } from '../state'
import { listCampanhas, uploadMidia, criarEDisparar, agendarDisparo } from '../lib/db'
import { FEATURES } from '../lib/config'
import { toast } from '../lib/toast'
import { PreviewWhatsApp } from '../components/PreviewWhatsApp'
import type { Campanha, MediaTipo, MencaoTipo } from '../lib/types'

// Contas conectadas (Fase 3 = vem do banco/Partner API). Hoje 1 chip.
const CONTAS = [{ id: 'HxSend', nome: 'HxSend · número atual' }]

const STEPS = ['Campanha', 'Número', 'Configurar', 'Confirmar']

const ACCEPT: Record<string, string> = { imagem: 'image/*', video: 'video/*', audio: 'audio/*' }

export function NovoDisparo({ goTo }: { goTo: (v: ViewId) => void }) {
  const { grupos, selected } = useApp()
  const [step, setStep] = useState(0)

  // etapa 1
  const [campanhas, setCampanhas] = useState<Campanha[]>([])
  const [fonte, setFonte] = useState<'campanha' | 'selecao'>('campanha')
  const [campanhaId, setCampanhaId] = useState<number | null>(null)

  // etapa 2
  const [conta, setConta] = useState(CONTAS[0].id)

  // etapa 3
  const [nome, setNome] = useState('')
  const [mediaTipo, setMediaTipo] = useState<MediaTipo>('texto')
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [mensagem, setMensagem] = useState('')
  const [tipoMencao, setTipoMencao] = useState<MencaoTipo>('fantasma')
  const [intervalo, setIntervalo] = useState(60)
  const [jitter, setJitter] = useState(20)

  // etapa 4
  const [agendar, setAgendar] = useState(false)
  const [agendarData, setAgendarData] = useState('') // datetime-local (hora local)
  const [firing, setFiring] = useState(false)

  useEffect(() => {
    listCampanhas().then(setCampanhas).catch(() => {})
  }, [])

  const groupIds = useMemo(() => {
    if (fonte === 'selecao') return [...selected]
    const c = campanhas.find((x) => x.id === campanhaId)
    return c ? c.group_ids : []
  }, [fonte, selected, campanhas, campanhaId])

  const subjects = useMemo(() => {
    const m: Record<string, string | null> = {}
    grupos.forEach((g) => (m[g.group_id] = g.subject))
    return m
  }, [grupos])

  // conta só grupos CONHECIDOS (na lista carregada) sem participantes lidos.
  // grupos não-carregados o motor resolve na hora (lê metadata) — não pré-conta como pulado.
  const semLista = groupIds.filter((g) => {
    const gr = grupos.find((x) => x.group_id === g)
    return !!gr && gr.participantes == null
  }).length
  const nomeCampanha = campanhas.find((c) => c.id === campanhaId)?.nome
  const nomeConta = CONTAS.find((c) => c.id === conta)?.nome
  const riscoBan = intervalo < 15

  function podeAvancar(): boolean {
    if (step === 0) return groupIds.length > 0
    if (step === 1) return !!conta
    if (step === 2) return mensagem.trim().length > 0 && (mediaTipo === 'texto' || !!mediaUrl)
    return true
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    setMediaUrl(null)
    setFileName('')
    if (!f) return
    if (f.size > 100 * 1024 * 1024) return toast('Arquivo muito grande (máx 100MB)', true)
    setUploading(true)
    try {
      const url = await uploadMidia(f)
      setMediaUrl(url)
      setFileName(f.name)
      toast('Arquivo enviado')
    } catch (err) {
      toast('Erro no upload: ' + (err as Error).message, true)
    } finally {
      setUploading(false)
    }
  }

  async function disparar() {
    const payload = {
      nome: nome.trim() || null,
      mensagem: mensagem.trim(),
      tipo_mencao: tipoMencao,
      intervalo_seg: intervalo,
      jitter_seg: jitter,
      media_tipo: mediaTipo,
      media_url: mediaUrl,
      group_ids: groupIds,
      subjects,
    }

    if (agendar) {
      if (!agendarData) return toast('Escolha a data e hora do agendamento', true)
      const quando = new Date(agendarData)
      if (isNaN(quando.getTime()) || quando.getTime() <= Date.now()) {
        return toast('A data do agendamento tem que ser no futuro', true)
      }
      if (!confirm(`Agendar disparo para ${groupIds.length} grupo(s) em ${quando.toLocaleString('pt-BR')}?`)) return
      setFiring(true)
      try {
        const id = await agendarDisparo(payload, quando.toISOString())
        toast(`Disparo #${id} agendado para ${quando.toLocaleString('pt-BR')}`)
        goTo('disparos')
      } catch (e) {
        toast('Erro: ' + (e as Error).message, true)
      } finally {
        setFiring(false)
      }
      return
    }

    if (!confirm(`Disparar para ${groupIds.length} grupo(s) pela conta ${conta}? Vai enviar mensagem de verdade.`)) return
    setFiring(true)
    try {
      const { id, started } = await criarEDisparar(payload)
      if (started) {
        toast(`Disparo #${id} iniciado!`)
      } else {
        toast(`Disparo #${id} criado, mas o motor não respondeu. Use "Iniciar" na aba Disparos.`, true)
      }
      goTo('disparos')
    } catch (e) {
      toast('Erro: ' + (e as Error).message, true)
    } finally {
      setFiring(false)
    }
  }

  return (
    <section>
      <h2>Novo disparo</h2>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={'step' + (i === step ? ' on' : '') + (i < step ? ' done' : '')}
            onClick={() => i < step && setStep(i)}
          >
            <span className="num">{i < step ? '✓' : i + 1}</span>
            {s}
          </div>
        ))}
      </div>

      <div className="card">
        {/* ETAPA 1 — CAMPANHA */}
        {step === 0 && (
          <>
            <div className="field">
              <label>De onde vêm os grupos?</label>
              <select value={fonte} onChange={(e) => setFonte(e.target.value as 'campanha' | 'selecao')}>
                <option value="campanha">De uma campanha salva</option>
                <option value="selecao">Da seleção atual da aba Grupos ({selected.size})</option>
              </select>
            </div>
            {fonte === 'campanha' && (
              <div className="field">
                <label>Campanha</label>
                <select
                  value={campanhaId ?? ''}
                  onChange={(e) => setCampanhaId(e.target.value ? +e.target.value : null)}
                >
                  <option value="">selecione...</option>
                  {campanhas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome} ({c.group_ids.length} grupos)
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className="mut">{groupIds.length} grupo(s) neste disparo.</p>
          </>
        )}

        {/* ETAPA 2 — NÚMERO */}
        {step === 1 && (
          <div className="field">
            <label>Número disparador</label>
            <select value={conta} onChange={(e) => setConta(e.target.value)}>
              {CONTAS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
            <p className="mut" style={{ marginBottom: 0 }}>
              Hoje só a conta HxSend. Multi-número entra na Fase 3 (Partner API).
            </p>
          </div>
        )}

        {/* ETAPA 3 — CONFIGURAR */}
        {step === 2 && (
          <>
            <div className="field">
              <label>Nome do disparo (opcional)</label>
              <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: Aviso sorteio 25/07" />
            </div>
            <div className="field">
              <label>Tipo de conteúdo</label>
              <select
                value={mediaTipo}
                onChange={(e) => {
                  setMediaTipo(e.target.value as MediaTipo)
                  setMediaUrl(null)
                  setFileName('')
                }}
              >
                <option value="texto">Texto</option>
                <option value="imagem">Imagem</option>
                <option value="video">Vídeo</option>
                <option value="audio">Áudio (nota de voz)</option>
              </select>
            </div>
            {mediaTipo !== 'texto' && (
              <div className="field">
                <label>Arquivo de {mediaTipo === 'audio' ? 'áudio (vira nota de voz)' : mediaTipo}</label>
                <input type="file" accept={ACCEPT[mediaTipo]} onChange={onFile} />
                <p className="mut" style={{ marginBottom: 0 }}>
                  {uploading ? (
                    <>
                      <span className="spin" /> enviando...
                    </>
                  ) : (
                    fileName && '✅ ' + fileName
                  )}
                </p>
              </div>
            )}
            <div className="field">
              <label>{mediaTipo === 'texto' ? 'Mensagem' : 'Texto (vai abaixo da mídia e marca todos)'}</label>
              <textarea
                rows={5}
                value={mensagem}
                onChange={(e) => setMensagem(e.target.value)}
                placeholder="Escreva a mensagem... (*negrito*, _itálico_, ~tachado~)"
              />
            </div>

            <div className="field">
              <label>Pré-visualização (como fica no WhatsApp)</label>
              <PreviewWhatsApp texto={mensagem} mediaTipo={mediaTipo} />
            </div>

            <div className="grid2">
              <div className="field">
                <label>Tipo de menção</label>
                <select value={tipoMencao} onChange={(e) => setTipoMencao(e.target.value as MencaoTipo)}>
                  <option value="fantasma">Fantasma (marca todos, texto limpo) · recomendado</option>
                  <option value="all">@all (marca todos, mostra @all)</option>
                  <option value="nenhuma">Sem menção</option>
                </select>
              </div>
              <div className="field">
                <label>Intervalo entre grupos (s)</label>
                <input
                  type="number"
                  min={5}
                  max={180}
                  value={intervalo}
                  onChange={(e) => setIntervalo(e.target.value === '' ? 0 : Math.max(0, parseInt(e.target.value, 10) || 0))}
                />
              </div>
            </div>
            <div className="grid2">
              <div className="field">
                <label>Jitter aleatório (s, anti-ban)</label>
                <input
                  type="number"
                  min={0}
                  value={jitter}
                  onChange={(e) => setJitter(e.target.value === '' ? 0 : Math.max(0, parseInt(e.target.value, 10) || 0))}
                />
              </div>
              <div />
            </div>
            <p className="mut" style={{ color: riscoBan ? '#e5484d' : undefined }}>
              {riscoBan
                ? `⚠️ RISCO DE BAN: ${intervalo}s ≈ ${Math.round(60 / Math.max(1, intervalo))} grupos/min (acima do seguro ~8/min). Recomendado ≥ 60s.`
                : `⏱️ Espera de ${intervalo}s a ${intervalo + jitter}s entre cada grupo. Reduz risco de bloqueio.`}
            </p>
          </>
        )}

        {/* ETAPA 4 — CONFIRMAR */}
        {step === 3 && (
          <>
            <h2 style={{ marginTop: 0 }}>Confirmar disparo</h2>
            <table>
              <tbody>
                <tr>
                  <td className="mut">Nome</td>
                  <td>{nome || '(sem nome)'}</td>
                </tr>
                <tr>
                  <td className="mut">Campanha</td>
                  <td>{fonte === 'campanha' ? nomeCampanha || '·' : 'Seleção da aba Grupos'}</td>
                </tr>
                <tr>
                  <td className="mut">Grupos</td>
                  <td>
                    {groupIds.length}
                    {semLista > 0 && tipoMencao === 'fantasma' && (
                      <span style={{ color: 'var(--amber)' }}> · {semLista} sem lista serão PULADOS</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="mut">Número</td>
                  <td>{nomeConta}</td>
                </tr>
                <tr>
                  <td className="mut">Conteúdo</td>
                  <td>{mediaTipo}</td>
                </tr>
                <tr>
                  <td className="mut">Menção</td>
                  <td>{tipoMencao}</td>
                </tr>
                <tr>
                  <td className="mut">Intervalo</td>
                  <td>
                    {intervalo}s + jitter {jitter}s
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="field" style={{ marginTop: 16 }} hidden={!FEATURES.agendamento}>
              <label>
                <input
                  type="checkbox"
                  style={{ width: 'auto', marginRight: 8, verticalAlign: -3 }}
                  checked={agendar}
                  onChange={(e) => setAgendar(e.target.checked)}
                />
                Agendar (em vez de disparar agora)
              </label>
              {agendar && (
                <div style={{ marginTop: 10 }}>
                  <input
                    type="datetime-local"
                    value={agendarData}
                    onChange={(e) => setAgendarData(e.target.value)}
                    style={{ maxWidth: 260 }}
                  />
                  <p className="mut" style={{ marginBottom: 0 }}>
                    O disparo fica salvo como <b>agendado</b> e inicia sozinho na hora marcada (o motor
                    respeita o intervalo/jitter a partir daí).
                  </p>
                </div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <PreviewWhatsApp texto={mensagem} mediaTipo={mediaTipo} />
            </div>

            <button className="btn" style={{ width: '100%' }} disabled={firing} onClick={disparar}>
              {firing ? (
                <span className="spin" />
              ) : agendar ? (
                `Agendar disparo para ${groupIds.length} grupo(s)`
              ) : (
                `Disparar para ${groupIds.length} grupo(s)`
              )}
            </button>
          </>
        )}
      </div>

      {/* navegação */}
      <div className="row between" style={{ marginTop: 16 }}>
        <button className="btn ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
          ← Voltar
        </button>
        {step < 3 && (
          <button className="btn" disabled={!podeAvancar()} onClick={() => setStep(step + 1)}>
            Avançar →
          </button>
        )}
      </div>
    </section>
  )
}
