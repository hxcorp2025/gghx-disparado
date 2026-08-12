import { useCallback, useEffect, useState } from 'react'
import { Activity, Settings2 } from 'lucide-react'
import { evoSaudeChips, evoPoliticaSalvar } from '../lib/evoDb'
import type { EvoChipSaude, PoliticaForm } from '../lib/evoDb'
import { toast } from '../lib/toast'

// Padrao seguro da casa (04_ANTIBAN): rampa de 7 dias comecando em 20/dia x1,8,
// teto de 200/hora e 1500/dia, janela comercial, intervalo de 60 a 90s com jitter.
const PADRAO: PoliticaForm = {
  aquecendo: true,
  teto_dia: 20,
  teto_hora: 200,
  janela_ini: '08:00',
  janela_fim: '20:00',
  intervalo_min_ms: 60000,
  intervalo_max_ms: 90000,
  ativo: true,
}

function Barra({ n, total }: { n: number; total: number | null }) {
  if (!total) return null
  const pct = Math.min(100, Math.round((n / total) * 100))
  const cor = pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--accent)'
  return (
    <div style={{ marginTop: 6 }}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span className="mut" style={{ fontSize: 12 }}>
          {n.toLocaleString('pt-BR')} de {total.toLocaleString('pt-BR')} hoje
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: cor }}>{pct}%</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: 'var(--surface2)', overflow: 'hidden' }}>
        <div style={{ width: pct + '%', height: '100%', background: cor, transition: 'width .3s ease' }} />
      </div>
    </div>
  )
}

export function ChipsSaude({ admin }: { admin: boolean }) {
  const [chips, setChips] = useState<EvoChipSaude[]>([])
  const [erro, setErro] = useState('')
  const [editando, setEditando] = useState<string | null>(null)
  const [form, setForm] = useState<PoliticaForm>(PADRAO)
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    try { setChips(await evoSaudeChips()); setErro('') }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não consegui ler a saúde dos chips.') }
  }, [])

  useEffect(() => { carregar() }, [carregar])

  function abrir(c: EvoChipSaude) {
    setForm(
      c.politica_ativa === null
        ? PADRAO
        : {
            aquecendo: !!c.aquecendo,
            teto_dia: c.teto_hoje ?? 20,
            teto_hora: c.teto_hora ?? 200,
            janela_ini: (c.janela_inicio ?? '08:00').slice(0, 5),
            janela_fim: (c.janela_fim ?? '20:00').slice(0, 5),
            intervalo_min_ms: c.intervalo_min_ms ?? 60000,
            intervalo_max_ms: c.intervalo_max_ms ?? 90000,
            ativo: c.politica_ativa ?? true,
          },
    )
    setEditando(c.nome)
  }

  async function salvar(nome: string) {
    if (ocupado) return
    setOcupado(true)
    try {
      await evoPoliticaSalvar(nome, form)
      toast('Limites salvos')
      setEditando(null)
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally { setOcupado(false) }
  }

  if (erro) return <p className="st-falha" style={{ fontSize: 13 }}>{erro}</p>
  if (!chips.length) return null

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 4 }}>
        <h3 className="row" style={{ gap: 7, margin: 0 }}>
          <Activity size={17} /> Saúde e limites de cada número
        </h3>
      </div>
      <p className="mut" style={{ fontSize: 12.5 }}>
        O disparo só sai se o número passar por aqui. <b>Sem política cadastrada, o número não
        envia nada</b>, é proposital: chip novo entra em rampa antes de ganhar volume.
      </p>

      {chips.map((c) => (
        <div key={c.nome} style={{ borderTop: '1px solid var(--line)', padding: '14px 0' }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <b>{c.nome}</b>
              {c.estado === 'open'
                ? <span className="badge b-concluida">conectado</span>
                : <span className="badge b-rascunho">desconectado</span>}
              {c.aquecendo && c.dia_do_warmup && (
                <span className="badge b-agendado">aquecendo, dia {c.dia_do_warmup} de 7</span>
              )}
              {c.politica_ativa === false && <span className="badge b-erro">envio desligado</span>}
              {c.falhas_24h > 0 && (
                <span className="badge b-erro">{c.falhas_24h} falha{c.falhas_24h > 1 ? 's' : ''} em 24h</span>
              )}
            </div>
            {admin && editando !== c.nome && (
              <button className="btn ghost sm" onClick={() => abrir(c)}>
                <Settings2 size={14} /> {c.politica_ativa === null ? 'Definir limites' : 'Ajustar'}
              </button>
            )}
          </div>

          {c.politica_ativa === null ? (
            <p className="mut" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
              Sem limites definidos, então este número não dispara.
              {admin ? ' Clique em "Definir limites" pra liberar em rampa.' : ' Fala com o Matheus.'}
            </p>
          ) : (
            <>
              <Barra n={c.enviadas_hoje} total={c.teto_hoje} />
              <p className="mut" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
                {c.ultima_hora} na última hora (teto {c.teto_hora}) · janela{' '}
                {(c.janela_inicio ?? '').slice(0, 5)} às {(c.janela_fim ?? '').slice(0, 5)} ·
                intervalo {Math.round((c.intervalo_min_ms ?? 0) / 1000)}s a{' '}
                {Math.round((c.intervalo_max_ms ?? 0) / 1000)}s
              </p>
              <p style={{ fontSize: 12.5, margin: '4px 0 0',
                          color: c.travado_por ? 'var(--amber)' : 'var(--accent)' }}>
                {c.travado_por ? 'Travado agora: ' + c.travado_por : 'Livre pra enviar agora'}
              </p>
            </>
          )}

          {editando === c.nome && (
            <div style={{ marginTop: 12 }}>
              <div className="grid2">
                <div className="field">
                  <label>Teto do dia (base da rampa)</label>
                  <input type="number" min={1} max={1500} value={form.teto_dia}
                    onChange={(e) => setForm({ ...form, teto_dia: Number(e.target.value) || 20 })} />
                </div>
                <div className="field">
                  <label>Teto por hora (máx 200)</label>
                  <input type="number" min={1} max={200} value={form.teto_hora}
                    onChange={(e) => setForm({ ...form, teto_hora: Number(e.target.value) || 200 })} />
                </div>
                <div className="field">
                  <label>Começa às</label>
                  <input type="time" value={form.janela_ini}
                    onChange={(e) => setForm({ ...form, janela_ini: e.target.value })} />
                </div>
                <div className="field">
                  <label>Para às</label>
                  <input type="time" value={form.janela_fim}
                    onChange={(e) => setForm({ ...form, janela_fim: e.target.value })} />
                </div>
                <div className="field">
                  <label>Intervalo mínimo (segundos)</label>
                  <input type="number" min={2} max={600}
                    value={Math.round(form.intervalo_min_ms / 1000)}
                    onChange={(e) => setForm({ ...form, intervalo_min_ms: (Number(e.target.value) || 60) * 1000 })} />
                </div>
                <div className="field">
                  <label>Intervalo máximo (o jitter)</label>
                  <input type="number" min={3} max={900}
                    value={Math.round(form.intervalo_max_ms / 1000)}
                    onChange={(e) => setForm({ ...form, intervalo_max_ms: (Number(e.target.value) || 90) * 1000 })} />
                </div>
              </div>

              <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
                <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.aquecendo}
                    onChange={(e) => setForm({ ...form, aquecendo: e.target.checked })} />
                  <span style={{ fontSize: 13 }}>Em aquecimento (rampa de 7 dias)</span>
                </label>
                <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.ativo}
                    onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
                  <span style={{ fontSize: 13 }}>Pode enviar</span>
                </label>
              </div>

              <p className="mut" style={{ fontSize: 12.5 }}>
                Com o aquecimento ligado, o teto do dia sobe sozinho: começa no valor acima e
                multiplica por 1,8 a cada dia, até o limite seguro. Desmarcar e marcar de novo
                <b> reinicia a rampa no dia 1</b>. O intervalo sorteia um valor entre o mínimo e o
                máximo a cada envio, porque intervalo fixo é assinatura de robô.
              </p>

              <div className="row">
                <button className="btn sm" disabled={ocupado} onClick={() => salvar(c.nome)}>
                  Salvar limites
                </button>
                <button className="btn ghost sm" disabled={ocupado} onClick={() => setEditando(null)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
