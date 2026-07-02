import { useEffect, useMemo, useState } from 'react'
import { Wrench, Image, Type, FileText, UserPlus, ShieldPlus, ShieldMinus } from 'lucide-react'
import { useApp } from '../state'
import {
  listCampanhas,
  listContas,
  uploadMidia,
  criarEExecutarAcao,
  listAcoes,
  getAcaoItens,
  setAcaoStatus,
  chamarMotorExtras,
} from '../lib/db'
import type { Campanha, Conta } from '../lib/types'
import type { Acao, AcaoItem } from '../lib/db'
import { toast } from '../lib/toast'
import { track } from '../lib/analytics'

const TIPOS = [
  { id: 'nome', label: 'Nome', Icon: Type, campo: 'texto', grupo: 'Editar comunidade', descr: 'Trocar o nome' },
  { id: 'descricao', label: 'Descrição', Icon: FileText, campo: 'texto', grupo: 'Editar comunidade', descr: 'Trocar a descrição' },
  { id: 'foto', label: 'Foto', Icon: Image, campo: 'foto', grupo: 'Editar comunidade', descr: 'Trocar a imagem' },
  { id: 'add_membro', label: 'Adicionar membro', Icon: UserPlus, campo: 'phones', grupo: 'Membros e administradores', descr: 'Incluir números' },
  { id: 'add_admin', label: 'Tornar admin', Icon: ShieldPlus, campo: 'phones', grupo: 'Membros e administradores', descr: 'Promover a admin' },
  { id: 'remove_admin', label: 'Remover admin', Icon: ShieldMinus, campo: 'phones', grupo: 'Membros e administradores', descr: 'Rebaixar admin' },
] as const

const GRUPOS = [...new Set(TIPOS.map((t) => t.grupo))]

export function Extras() {
  const { grupos, selected } = useApp()
  const [tipo, setTipo] = useState<string>('nome')
  const [texto, setTexto] = useState('')
  const [fotoUrl, setFotoUrl] = useState<string | null>(null)
  const [fotoNome, setFotoNome] = useState('')
  const [uploading, setUploading] = useState(false)
  const [phones, setPhones] = useState('')
  const [fonte, setFonte] = useState<'campanha' | 'selecao'>('selecao')
  const [campanhas, setCampanhas] = useState<Campanha[]>([])
  const [campanhaId, setCampanhaId] = useState<number | null>(null)
  const [contas, setContas] = useState<Conta[]>([{ id: 'hxsend', nome: 'HxSend' }])
  const [conta, setConta] = useState('hxsend')
  const [intervalo, setIntervalo] = useState(15) // MINUTOS (ações admin são lentas p/ anti-ban)
  const [jitter, setJitter] = useState(3) // MINUTOS
  const [firing, setFiring] = useState(false)
  const [acoes, setAcoes] = useState<Acao[]>([])
  const [abertoId, setAbertoId] = useState<number | null>(null)
  const [itens, setItens] = useState<AcaoItem[]>([])

  const tSel = TIPOS.find((t) => t.id === tipo)!
  const campo = tSel.campo

  useEffect(() => {
    listCampanhas().then(setCampanhas).catch(() => {})
    listContas().then((cs) => {
      setContas(cs)
      setConta(cs[0].id)
    })
    reloadAcoes()
  }, [])

  async function reloadAcoes() {
    try {
      setAcoes(await listAcoes())
    } catch {
      /* noop */
    }
  }

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

  async function onFoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    setFotoUrl(null)
    setFotoNome('')
    if (!f) return
    setUploading(true)
    try {
      setFotoUrl(await uploadMidia(f))
      setFotoNome(f.name)
      toast('Foto enviada')
    } catch (err) {
      toast('Erro no upload: ' + (err as Error).message, true)
    } finally {
      setUploading(false)
    }
  }

  function valorFinal(): string | null {
    if (campo === 'texto') return texto.trim() || null
    if (campo === 'foto') return fotoUrl
    const arr = phones
      .split(/[\n,;]+/)
      .map((p) => p.replace(/\D/g, ''))
      .filter((p) => p.length >= 10)
    return arr.length ? JSON.stringify(arr) : null
  }

  async function executar() {
    if (!groupIds.length) return toast('Selecione grupos (aba Grupos) ou uma campanha', true)
    const valor = valorFinal()
    if (!valor) return toast('Preencha o valor da ação', true)
    if (
      !confirm(
        `${tSel.label} em ${groupIds.length} grupo(s) pela conta ${conta}?\n\n⚠️ O chip precisa ser ADMIN dos grupos. Executa de verdade, ~1 grupo a cada ${intervalo} min (anti-ban).`,
      )
    )
      return
    setFiring(true)
    try {
      const { id, started } = await criarEExecutarAcao({
        tipo,
        conta_id: conta,
        valor,
        intervalo_seg: intervalo * 60,
        jitter_seg: jitter * 60,
        group_ids: groupIds,
        subjects,
      })
      track('ferramenta_executada', { tipo, grupos: groupIds.length })
      toast(started ? `Ação #${id} iniciada!` : `Ação #${id} criada; motor não respondeu (retomar na lista).`, !started)
      setTexto('')
      setPhones('')
      setFotoUrl(null)
      setFotoNome('')
      reloadAcoes()
    } catch (e) {
      toast('Erro: ' + (e as Error).message, true)
    } finally {
      setFiring(false)
    }
  }

  async function abrir(id: number) {
    setAbertoId(id)
    setItens(await getAcaoItens(id))
  }
  async function pausar(id: number) {
    await setAcaoStatus(id, 'pausada')
    toast('Pausado')
    reloadAcoes()
  }
  async function despausar(id: number) {
    await setAcaoStatus(id, 'pausada')
    await chamarMotorExtras(id).catch(() => null)
    toast('Retomando')
    setTimeout(reloadAcoes, 3000)
  }
  async function cancelar(id: number) {
    if (!confirm('Cancelar esta ação?')) return
    await setAcaoStatus(id, 'cancelada')
    reloadAcoes()
  }

  return (
    <section>
      <div className="row" style={{ gap: 9, marginBottom: 2 }}>
        <Wrench size={19} style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0 }}>Ferramentas</h2>
      </div>
      <p className="mut" style={{ marginTop: 0 }}>
        Gerir comunidades em massa. O chip precisa ser <b>admin</b> dos grupos; add membro/admin só aceita
        número de telefone (não @lid).
      </p>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="grouplbl">O que fazer</div>
        {GRUPOS.map((g) => (
          <div key={g}>
            <div className="grouplbl" style={{ color: 'var(--mut)' }}>
              {g}
            </div>
            <div className="actiongrid">
              {TIPOS.filter((t) => t.grupo === g).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={'actioncard' + (tipo === t.id ? ' on' : '')}
                  onClick={() => setTipo(t.id)}
                >
                  <span className="ac-ico">
                    <t.Icon size={17} />
                  </span>
                  <span className="ac-t">{t.label}</span>
                  <span className="ac-d">{t.descr}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* valor da ação escolhida */}
        {campo === 'texto' && (
          <div className="field">
            <label>{tipo === 'nome' ? 'Novo nome' : 'Nova descrição'}</label>
            {tipo === 'nome' ? (
              <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Novo nome do grupo" />
            ) : (
              <textarea rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Nova descrição" />
            )}
          </div>
        )}
        {campo === 'foto' && (
          <div className="field">
            <label>Nova foto</label>
            <input type="file" accept="image/*" onChange={onFoto} />
            <p className="mut" style={{ marginBottom: 0 }}>
              {uploading ? (
                <>
                  <span className="spin" /> enviando...
                </>
              ) : (
                fotoNome && '✅ ' + fotoNome
              )}
            </p>
          </div>
        )}
        {campo === 'phones' && (
          <div className="field">
            <label>Números (um por linha ou separados por vírgula)</label>
            <textarea
              rows={4}
              value={phones}
              onChange={(e) => setPhones(e.target.value)}
              placeholder={'5551999999999\n5544988888888'}
            />
          </div>
        )}

        <div className="grid2">
          <div className="field">
            <label>Alvo (grupos)</label>
            <select value={fonte} onChange={(e) => setFonte(e.target.value as 'campanha' | 'selecao')}>
              <option value="selecao">Seleção atual da aba Grupos ({selected.size})</option>
              <option value="campanha">De uma campanha salva</option>
            </select>
            {fonte === 'campanha' && (
              <select
                style={{ marginTop: 8 }}
                value={campanhaId ?? ''}
                onChange={(e) => setCampanhaId(e.target.value ? +e.target.value : null)}
              >
                <option value="">selecione...</option>
                {campanhas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome} ({c.group_ids.length})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="field">
            <label>Número (conta)</label>
            <select value={conta} onChange={(e) => setConta(e.target.value)}>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Intervalo entre grupos (minutos)</label>
            <input
              type="number"
              min={1}
              value={intervalo}
              onChange={(e) => setIntervalo(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          <div className="field">
            <label>Variação aleatória (minutos)</label>
            <input type="number" min={0} value={jitter} onChange={(e) => setJitter(parseInt(e.target.value, 10) || 0)} />
          </div>
        </div>
        <p className="mut" style={{ marginTop: -4 }}>
          {intervalo >= 1
            ? `~1 grupo a cada ${intervalo}${jitter ? `–${intervalo + jitter}` : ''} min · ≈ ${Math.max(1, Math.round(60 / (intervalo + jitter / 2)))} grupos/hora. Ir devagar reduz risco de ban.`
            : 'Defina o intervalo em minutos (anti-ban).'}
        </p>
        <div className="row between">
          <span className="count-pill">
            <b>{groupIds.length}</b> grupos
          </span>
          <button className="btn" disabled={firing} onClick={executar}>
            {firing ? <span className="spin" /> : `Executar ${tSel.label.toLowerCase()}`}
          </button>
        </div>
      </div>

      <div className="toolbar between">
        <h2 style={{ margin: 0 }}>Ações recentes</h2>
        <button className="btn ghost sm" onClick={reloadAcoes}>
          Atualizar
        </button>
      </div>
      {!acoes.length && <p className="mut">Nenhuma ação ainda.</p>}
      {acoes.map((a) => (
        <div className="listrow" key={a.id}>
          <div>
            <b>
              #{a.id} {TIPOS.find((t) => t.id === a.tipo)?.label || a.tipo}
            </b>{' '}
            <span className={'badge b-' + a.status}>{a.status}</span>
            <div className="mut">
              {a.enviados || 0}/{a.total || 0} feitos{a.falhas ? ` · ${a.falhas} falhas` : ''} ·{' '}
              {a.criado_em ? new Date(a.criado_em).toLocaleString('pt-BR') : ''}
            </div>
          </div>
          <div className="row">
            {a.status === 'rodando' && (
              <button className="btn ghost sm" onClick={() => pausar(a.id)}>
                Pausar
              </button>
            )}
            {a.status === 'pausada' && (
              <button className="btn sm" onClick={() => despausar(a.id)}>
                Despausar
              </button>
            )}
            {a.status !== 'concluida' && a.status !== 'cancelada' && (
              <button className="btn ghost sm" onClick={() => cancelar(a.id)}>
                Cancelar
              </button>
            )}
            <button className="btn ghost sm" onClick={() => abrir(a.id)}>
              Ver grupos
            </button>
          </div>
        </div>
      ))}

      {abertoId != null && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Ação #{abertoId} · grupos</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Grupo</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 160 }}>Quando / erro</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((it) => (
                  <tr key={it.id}>
                    <td>{it.subject || it.group_id}</td>
                    <td className={'st-' + it.status}>{it.status}</td>
                    <td className="mut">
                      {it.executado_em
                        ? new Date(it.executado_em).toLocaleTimeString('pt-BR')
                        : it.erro
                          ? it.erro.slice(0, 40)
                          : '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
