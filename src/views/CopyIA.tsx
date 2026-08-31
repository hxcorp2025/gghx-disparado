import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Check, X, RefreshCw, AlertTriangle, Pencil } from 'lucide-react'
import {
  copyResumo, copyFila, copyRevisar, copyPedir, copyDecidir,
} from '../lib/copyDb'
import type { CopyFila, CopyVariacao, CopyResumo } from '../lib/copyDb'
import { toast } from '../lib/toast'
import { Empty } from '../components/Empty'
import { EditorCopyTexto } from '../components/EditorCopyTexto'

const STATUS: Record<string, { txt: string; badge: string }> = {
  pending: { txt: 'na fila', badge: 'b-agendado' },
  doing: { txt: 'gerando', badge: 'b-rodando' },
  ok: { txt: 'pronto', badge: 'b-concluida' },
  error: { txt: 'erro', badge: 'b-erro' },
}
const st = (s: string) => STATUS[s] ?? { txt: s, badge: 'b-rascunho' }

// nome tecnico da violacao -> o que a pessoa precisa entender pra corrigir
const VIOLACAO: Record<string, string> = {
  travessao: 'usa travessão (proibido na copy da casa)',
  texto_vazio: 'veio vazio',
}

export function CopyIA() {
  const [resumo, setResumo] = useState<CopyResumo | null>(null)
  const [fila, setFila] = useState<CopyFila[]>([])
  const [vars, setVars] = useState<CopyVariacao[]>([])
  const [verTodas, setVerTodas] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState('')
  const [carregou, setCarregou] = useState(false)

  const [original, setOriginal] = useState('')
  const [n, setN] = useState(3)
  const [dominios, setDominios] = useState('')
  const [instrucoes, setInstrucoes] = useState('')

  // reprovacao com motivo: o comentario realimenta o motor (secao "NAO REPITA ESTES ERROS")
  const [reprovando, setReprovando] = useState<number | null>(null)
  const [motivo, setMotivo] = useState('')
  // edicao in-place: copy boa com detalhe errado se ajusta, nao se cancela (Peterson, 31/08)
  const [editando, setEditando] = useState<number | null>(null)

  const carregar = useCallback(async () => {
    try {
      const [r, f, v] = await Promise.all([copyResumo(), copyFila(20), copyRevisar(false)])
      setResumo(r); setFila(f); setVars(v); setErro('')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui carregar.')
    } finally {
      setCarregou(true)
    }
  }, [])

  useEffect(() => { carregar() }, [carregar])

  // com pedido na fila, recarrega de 5 em 5s (o worker roda de 1 em 1 min)
  const gerando = fila.some((f) => f.status === 'pending' || f.status === 'doing')
  useEffect(() => {
    if (!gerando) return
    const t = setInterval(carregar, 5000)
    return () => clearInterval(t)
  }, [gerando, carregar])

  async function pedir() {
    if (ocupado) return
    setOcupado(true)
    try {
      const r = await copyPedir(
        original.trim(), n,
        dominios.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
        instrucoes.trim(),
      )
      toast(r.aviso ?? 'Pedido na fila')
      setOriginal(''); setInstrucoes('')
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function decidir(id: number, aprovada: boolean, mot?: string) {
    if (ocupado) return
    setOcupado(true)
    try {
      await copyDecidir(id, aprovada, mot)
      toast(aprovada ? 'Aprovada' : 'Reprovada')
      setReprovando(null); setMotivo('')
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  const custoHoje = resumo?.custo_30d?.[0]
  const diag = resumo?.diagnostico ?? {}
  // fetch traz todas; o filtro visual decide o que mostrar (o disparo agora mora na aba Disparar)
  const varsMostrados = verTodas ? vars : vars.filter((v) => v.aprovada === null)

  if (erro) {
    return (
      <section>
        <h2>Copy com IA</h2>
        <Empty Icon={Sparkles} title="Não consegui carregar" sub={erro} />
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn" onClick={carregar}>Tentar de novo</button>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2>Copy com IA</h2>
      <p className="mut" style={{ marginTop: 0, maxWidth: 680 }}>
        Aqui a IA escreve variações da mensagem de disparo. Isso não é firula: a forense das
        comunidades mostrou que <b>o que derruba grupo é o padrão de conteúdo</b>, texto igual
        repetido, sempre com o mesmo link. Variar de verdade é o anti-ban que funciona.
        Nada vai pro disparo sem alguém aprovar aqui.
      </p>

      <div className="statcards">
        <div className="statcard">
          <div className="lbl">Esperando revisão</div>
          <div className="val">{resumo?.pendentes ?? 0}</div>
          <div className="sub">ninguém aprovou ainda</div>
        </div>
        <div className="statcard">
          <div className="lbl">Aprovadas</div>
          <div className="val" style={{ color: 'var(--accent)' }}>{resumo?.aprovadas ?? 0}</div>
          <div className="sub">liberadas pro disparo</div>
        </div>
        <div className="statcard">
          <div className="lbl">Gasto hoje</div>
          <div className="val">
            {custoHoje ? 'US$ ' + Number(custoHoje.custo_usd).toFixed(3) : 'US$ 0,000'}
          </div>
          <div className="sub">{custoHoje ? custoHoje.chamadas + ' chamadas' : 'nenhuma chamada'}</div>
        </div>
        <div className="statcard">
          <div className="lbl">Modelo</div>
          <div className="val" style={{ fontSize: 16 }}>{resumo?.modelo ?? '?'}</div>
          <div className="sub">{resumo?.key_pronta ? 'chave no Vault' : 'sem chave'}</div>
        </div>
      </div>

      {resumo && !resumo.key_pronta && (
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <div className="row" style={{ gap: 8 }}>
            <AlertTriangle size={17} style={{ color: 'var(--red)' }} />
            <b>A chave da Anthropic não está no Vault.</b>
          </div>
          <p className="mut" style={{ fontSize: 13, marginBottom: 0 }}>
            Os pedidos ficam na fila e não geram nada até a chave entrar. Fala com o Matheus.
          </p>
        </div>
      )}

      {/* O diagnostico e o ARGUMENTO da tela: mostra o padrao que esta matando os grupos */}
      {diag.templates ? (
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>O que os disparos de hoje têm em comum</h3>
          <div className="grid2">
            <div>
              <span className="mut" style={{ fontSize: 12.5 }}>Mensagens analisadas</span>
              <div style={{ fontWeight: 600 }}>{diag.templates}</div>
            </div>
            <div>
              <span className="mut" style={{ fontSize: 12.5 }}>Marcam todo mundo</span>
              <div style={{ fontWeight: 600 }}>{diag.pct_mencao_todos}%</div>
            </div>
            <div>
              <span className="mut" style={{ fontSize: 12.5 }}>Levam link</span>
              <div style={{ fontWeight: 600 }}>{diag.pct_com_link}%</div>
            </div>
            <div>
              <span className="mut" style={{ fontSize: 12.5 }}>Domínios diferentes</span>
              <div style={{ fontWeight: 600, color: (diag.dominios_distintos ?? 0) < 5 ? 'var(--amber)' : undefined }}>
                {diag.dominios_distintos}
              </div>
            </div>
          </div>
          <p className="mut" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
            <b>Como ler:</b> quanto menos domínios diferentes, mais fácil o WhatsApp ligar um grupo
            no outro e derrubar a comunidade inteira. Com poucos domínios, variar só o texto
            resolve metade do problema.
          </p>
        </div>
      ) : null}

      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Pedir variações</h3>
        <div className="field">
          <label htmlFor="cp-orig">Cópia original (a mensagem que você quer variar)</label>
          <textarea
            id="cp-orig" rows={5} value={original}
            placeholder="Cola aqui a mensagem que você mandaria no grupo. A IA cria variações dela, e a original já fica disponível pra disparar."
            onChange={(e) => setOriginal(e.target.value)}
          />
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="cp-n">Quantas variações (1 a 10)</label>
            <input id="cp-n" type="number" min={1} max={10} value={n}
              onChange={(e) => setN(Math.max(1, Math.min(10, Number(e.target.value) || 3)))} />
          </div>
          <div className="field">
            <label htmlFor="cp-dom">Domínios liberados pro link</label>
            <input id="cp-dom" value={dominios} placeholder="separados por espaço ou vírgula"
              onChange={(e) => setDominios(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="cp-inst">Instrução extra (opcional)</label>
          <input id="cp-inst" value={instrucoes} placeholder="ex.: nao repetir o mesmo dominio em duas variacoes"
            onChange={(e) => setInstrucoes(e.target.value)} />
        </div>
        <div className="row">
          <button className="btn" disabled={ocupado || original.trim().length < 10} onClick={pedir}>
            <Sparkles size={15} /> Gerar variações
          </button>
          <button className="btn ghost" disabled={ocupado} onClick={carregar}>
            <RefreshCw size={15} /> Atualizar
          </button>
        </div>
        <p className="mut" style={{ fontSize: 12.5, marginBottom: 0 }}>
          As regras da casa ({resumo?.regras?.length ?? 0} ativas) já entram no pedido sozinhas.
          Você não precisa repetir aqui que não pode travessão, por exemplo.
        </p>
      </div>

      {fila.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Pedidos recentes</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Briefing</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 100 }}>Variações</th>
                  <th style={{ width: 160 }}>Quando</th>
                </tr>
              </thead>
              <tbody>
                {fila.slice(0, 8).map((f) => {
                  const brief = f.briefing ?? ''
                  return (
                  <tr key={f.id}>
                    <td style={{ maxWidth: 340 }}>
                      {brief.length > 90 ? brief.slice(0, 90) + '...' : brief}
                      {f.ultimo_erro && <div className="st-falha" style={{ fontSize: 12 }}>{f.ultimo_erro}</div>}
                    </td>
                    <td><span className={'badge ' + st(f.status).badge}>{st(f.status).txt}</span></td>
                    <td>{f.variacoes} / {f.n_variacoes}</td>
                    <td className="mut">{new Date(f.criado_em).toLocaleString('pt-BR')}</td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="row between" style={{ margin: '18px 0 12px' }}>
        <span className="count-pill"><b>{varsMostrados.length}</b> {verTodas ? 'no total' : 'esperando você'}</span>
        <button className="btn ghost sm" onClick={() => setVerTodas((v) => !v)}>
          {verTodas ? 'Ver só as pendentes' : 'Ver todas'}
        </button>
      </div>

      {varsMostrados.length === 0 && carregou && (
        <Empty
          Icon={Sparkles}
          title={verTodas ? 'Nenhuma variação ainda' : 'Nada esperando revisão'}
          sub="Peça variações no formulário acima. Elas aparecem aqui em menos de 1 minuto."
        />
      )}

      {varsMostrados.map((v) => {
        const viol = v.violacoes ?? []
        const ehOriginal = v.origem === 'original'
        return (
          <div className="card" key={v.id} style={viol.length ? { borderColor: 'var(--red)' } : undefined}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {ehOriginal && <span className="badge b-agendado">original</span>}
                {v.angulo && !ehOriginal && <span className="badge b-rodando">{v.angulo}</span>}
                {v.dominio_link
                  ? <span className="badge b-rascunho">{v.dominio_link}</span>
                  : <span className="badge b-rascunho">sem link</span>}
                <span className="badge b-rascunho">{v.chars} chars</span>
                {v.aprovada === true && <span className="badge b-concluida">aprovada</span>}
                {v.aprovada === false && <span className="badge b-erro">reprovada</span>}
                {v.editado_em && (
                  <span className="badge b-rodando" title={v.texto_original ? `Original:\n\n${v.texto_original}` : undefined}>
                    editada
                  </span>
                )}
              </div>
              <span className="mut" style={{ fontSize: 12 }}>#{v.fila_id}.{v.idx}</span>
            </div>

            {editando === v.id ? (
              <EditorCopyTexto
                id={v.id}
                textoAtual={v.texto}
                onSalvo={() => { setEditando(null); carregar() }}
                onFechar={() => setEditando(null)}
              />
            ) : (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14.5, lineHeight: 1.55 }}>{v.texto}</div>
            )}

            {viol.length > 0 && editando !== v.id && (
              <p className="st-falha" style={{ fontSize: 12.5, marginTop: 10 }}>
                Quebra regra da casa: {viol.map((x) => VIOLACAO[x] ?? x).join(' · ')}.
                Não dá pra aprovar como está — edita o texto ou reprova.
              </p>
            )}

            {v.aprovada === false && v.reprovacao_motivo && (
              <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
                <b>Motivo da reprovação:</b> {v.reprovacao_motivo}
              </p>
            )}

            {v.aprovada === null && reprovando !== v.id && editando !== v.id && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn sm" disabled={ocupado || viol.length > 0}
                  onClick={() => decidir(v.id, true)}>
                  <Check size={15} /> Aprovar
                </button>
                <button className="btn ghost sm" disabled={ocupado}
                  onClick={() => { setEditando(v.id); setReprovando(null) }}>
                  <Pencil size={14} /> Editar
                </button>
                <button className="btn danger sm" disabled={ocupado}
                  onClick={() => { setReprovando(v.id); setMotivo('') }}>
                  <X size={15} /> Reprovar
                </button>
              </div>
            )}

            {v.aprovada !== null && editando !== v.id && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn ghost sm" disabled={ocupado} onClick={() => setEditando(v.id)}>
                  <Pencil size={14} /> Editar{v.aprovada === false ? ' e resgatar' : ''}
                </button>
              </div>
            )}

            {v.aprovada === null && reprovando === v.id && (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor={`mot-${v.id}`}>Por que está reprovando? (a IA usa isso pra não repetir o erro)</label>
                <textarea
                  id={`mot-${v.id}`} rows={2} value={motivo} autoFocus
                  placeholder="ex.: curta demais, só uma frase e o link, sem gancho nem prova do prêmio"
                  onChange={(e) => setMotivo(e.target.value)}
                />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn danger sm" disabled={ocupado}
                    onClick={() => decidir(v.id, false, motivo)}>
                    <X size={15} /> Confirmar reprovação
                  </button>
                  <button className="btn ghost sm" disabled={ocupado}
                    onClick={() => { setReprovando(null); setMotivo('') }}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
