import { useCallback, useEffect, useRef, useState } from 'react'
import { QrCode, RefreshCw, Smartphone, Plus } from 'lucide-react'
import { sb } from '../lib/supabase'
import {
  evoListar, evoSincronizar, evoCriar, evoConectar,
  evoEstado, evoDesconectar, evoApagar,
} from '../lib/evoDb'
import type { EvoInstancia } from '../lib/evoDb'
import { toast } from '../lib/toast'
import { Empty } from '../components/Empty'
import { SaudeChipPanel } from '../components/SaudeChip'

const ROTULO: Record<string, { texto: string; badge: string }> = {
  open: { texto: 'Conectado', badge: 'b-concluida' },
  connecting: { texto: 'Aguardando leitura', badge: 'b-agendado' },
  close: { texto: 'Desconectado', badge: 'b-rascunho' },
}
const estadoDe = (e: string | null) => ROTULO[e ?? ''] ?? { texto: e ?? 'Desconhecido', badge: 'b-rascunho' }

// erro escopado: aparece no card onde a ação foi pedida, não num rodapé longe da vista
type Erro = { onde: string; msg: string } | null
const NOVO = '_novo'

export function Conexao() {
  const [itens, setItens] = useState<EvoInstancia[]>([])
  const [falhouCarregar, setFalhouCarregar] = useState('')
  const [erro, setErro] = useState<Erro>(null)
  const [ocupado, setOcupado] = useState(false)
  const [carregou, setCarregou] = useState(false)
  const [admin, setAdmin] = useState(true)
  const [abrirNovo, setAbrirNovo] = useState(false)
  const [nome, setNome] = useState('')
  const [rotulo, setRotulo] = useState('')
  const [apagando, setApagando] = useState<string | null>(null)
  const [desconectando, setDesconectando] = useState<string | null>(null)
  const [confirmacao, setConfirmacao] = useState('')
  // instâncias cujo QR venceu e que já tiveram o estado conferido uma vez
  const conferidas = useRef<Set<string>>(new Set())
  const tinhaQr = useRef<Set<string>>(new Set())

  const carregar = useCallback(async () => {
    try {
      setItens(await evoListar())
      setFalhouCarregar('')
    } catch (e) {
      setFalhouCarregar(e instanceof Error ? e.message : 'Não consegui ler as instâncias.')
    } finally {
      setCarregou(true)
    }
  }, [])

  useEffect(() => { carregar() }, [carregar])

  // papel só esconde botão (conveniência). A permissão de verdade mora no SQL do evo_pedir,
  // por isso um erro de leitura aqui mantém os botões visíveis em vez de travar o admin.
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      const email = data.session?.user?.email
      if (!email) return
      sb.from('painel_operadores').select('papel').eq('email', email)
        .then(({ data: d, error }) => { if (!error && d?.length) setAdmin(d[0].papel === 'admin') })
    })
  }, [])

  const trabalhando = itens.some((i) => i.qr_fresco || i.pedido_em_andamento)

  // com QR na tela ou pedido na fila, recarrega de 3 em 3s; senão devagar.
  // Pausa em segundo plano pra não bater no banco com a aba esquecida aberta.
  useEffect(() => {
    let t: number | undefined
    const liga = () => {
      clearInterval(t)
      if (document.hidden) return
      carregar() // ao voltar pra aba, busca na hora em vez de esperar o próximo tique
      t = setInterval(carregar, trabalhando ? 3000 : 20000) as unknown as number
    }
    liga()
    document.addEventListener('visibilitychange', liga)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', liga) }
  }, [carregar, trabalhando])

  // QR venceu sem virar conectado? confere o estado UMA vez, senão o card fica dizendo
  // "aguardando leitura" por minutos depois de a pessoa já ter lido.
  useEffect(() => {
    for (const i of itens) {
      if (i.qr_fresco) { tinhaQr.current.add(i.nome); conferidas.current.delete(i.nome); continue }
      if (tinhaQr.current.has(i.nome) && i.estado !== 'open' && !conferidas.current.has(i.nome)
          && !i.pedido_em_andamento) {
        conferidas.current.add(i.nome)
        evoEstado(i.nome).then(carregar).catch(() => {})
      }
    }
  }, [itens, carregar])

  async function agir(onde: string, fn: () => Promise<unknown>, aviso?: string) {
    if (ocupado) return
    setErro(null)
    setOcupado(true)
    try {
      await fn()
      await carregar()
      if (aviso) toast(aviso)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falhou'
      setErro({ onde, msg })
      toast(msg, true)
    } finally {
      setOcupado(false)
    }
  }

  const erroDe = (onde: string) =>
    erro?.onde === onde ? <p className="st-falha" role="alert" style={{ fontSize: 13, marginTop: 8 }}>{erro.msg}</p> : null

  if (falhouCarregar) {
    return (
      <section>
        <h2>Conexão dos números</h2>
        <Empty Icon={Smartphone} title="Não consegui carregar" sub={falhouCarregar} />
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn" onClick={carregar}>Tentar de novo</button>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2>Conexão dos números</h2>
      <p className="mut" style={{ marginTop: 0, maxWidth: 640 }}>
        Cada número de WhatsApp da operação é uma <b>instância</b> na nossa Evolution. Aqui você dá
        um nome, lê o QR no celular e ele fica conectado, sem abrir painel de fora.
        O app não fala com o WhatsApp direto: registra o pedido e um serviço executa em uns
        10 segundos, então o resultado aparece sozinho logo depois.
      </p>

      <SaudeChipPanel />

      <div className="row between" style={{ margin: '18px 0 12px' }}>
        <span className="count-pill">
          <b>{itens.length}</b> {itens.length === 1 ? 'número' : 'números'}
        </span>
        <div className="row">
          <button className="btn ghost sm" disabled={ocupado}
            onClick={() => agir(NOVO, evoSincronizar, 'Buscando a lista na Evolution')}>
            <RefreshCw size={15} /> Atualizar lista
          </button>
          {admin && !abrirNovo && (
            <button className="btn sm" disabled={ocupado} onClick={() => { setAbrirNovo(true); setErro(null) }}>
              <Plus size={15} /> Novo número
            </button>
          )}
        </div>
      </div>

      {admin && abrirNovo && (
        <div className="card">
          <div className="grid2">
            <div className="field">
              <label htmlFor="evo-nome">Nome curto, sem espaço</label>
              <input
                id="evo-nome"
                placeholder="ex.: rox-disparo-01"
                value={nome}
                maxLength={41}
                onChange={(e) => setNome(
                  e.target.value.toLowerCase()
                    .replace(/[^a-z0-9_-]/g, '')
                    .replace(/^[^a-z0-9]+/, ''), // o banco exige começar por letra ou número
                )}
              />
            </div>
            <div className="field">
              <label htmlFor="evo-rotulo">Rótulo pra equipe lembrar</label>
              <input
                id="evo-rotulo"
                placeholder="ex.: chip do Peterson, comunidades VIP"
                value={rotulo}
                onChange={(e) => setRotulo(e.target.value)}
              />
            </div>
          </div>
          <p className="mut" style={{ fontSize: 12.5 }}>
            O nome não muda depois e é o que aparece nos logs. Minúsculas, números, hífen ou
            sublinhado, de 3 a 41 caracteres, começando por letra ou número.
          </p>
          <div className="row">
            <button className="btn" disabled={nome.length < 3 || ocupado}
              onClick={() => agir(NOVO, async () => {
                await evoCriar(nome, rotulo.trim())
                setNome(''); setRotulo(''); setAbrirNovo(false)
              }, 'Número criado, o QR aparece em instantes')}>
              Criar e gerar QR
            </button>
            <button className="btn ghost" disabled={ocupado} onClick={() => setAbrirNovo(false)}>
              Cancelar
            </button>
          </div>
          {erroDe(NOVO)}
        </div>
      )}

      {itens.length === 0 && carregou && (
        <Empty
          Icon={Smartphone}
          title="Nenhum número conectado ainda"
          sub={admin
            ? 'Clique em "Novo número" pra criar o primeiro, ou em "Atualizar lista" pra puxar os que já existem na Evolution.'
            : 'Fala com o Matheus pra conectar o primeiro número.'}
        />
      )}

      {itens.map((i) => {
        const est = estadoDe(i.estado)
        return (
          <div className="card" key={i.nome}>
            <div className="row between" style={{ marginBottom: 10 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className={'badge ' + est.badge}>{est.texto}</span>
                {i.proxy_ativo && <span className="badge b-rodando">proxy {i.proxy_host ?? 'on'}</span>}
                {i.pedido_em_andamento && (
                  <span className="badge b-rodando">
                    <span className="spin" /> {i.pedido_em_andamento}
                  </span>
                )}
              </div>
              {i.criada_por && <span className="mut" style={{ fontSize: 12 }}>por {i.criada_por}</span>}
            </div>

            <div style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
              {i.nome}{i.rotulo ? <span className="mut" style={{ fontWeight: 400 }}> · {i.rotulo}</span> : null}
            </div>
            <p className="mut" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
              {i.numero ? `número ${i.numero}` : 'sem número conectado'}
              {i.perfil ? ` · ${i.perfil}` : ''}
              {i.visto_em ? ` · visto ${new Date(i.visto_em).toLocaleString('pt-BR')}` : ''}
            </p>

            {i.qr_fresco && i.qr_base64 && (
              <div style={{ marginTop: 14, textAlign: 'center' }}>
                <p className="mut" style={{ fontSize: 12.5, maxWidth: 460, margin: '0 auto 10px' }}>
                  No celular: <b>WhatsApp, Configurações, Aparelhos conectados, Conectar aparelho</b>,
                  e aponte pra este código. Ele vale mais ou menos 1 minuto. Se vencer, é só clicar
                  em "Gerar QR" de novo.
                </p>
                <img
                  src={i.qr_base64}
                  alt={`QR code pra conectar o número ${i.nome}`}
                  style={{ width: 250, maxWidth: '100%', imageRendering: 'pixelated',
                           borderRadius: 10, background: '#fff', padding: 8 }}
                />
                {i.pareamento && i.pareamento.length <= 12 && (
                  <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
                    Não consegue ler o código? Em <b>Conectar aparelho, Conectar com número de
                    telefone</b>, digite: <b>{i.pareamento}</b>
                  </p>
                )}
              </div>
            )}

            {i.ultimo_erro && (
              <p className="st-falha" style={{ fontSize: 12.5, marginTop: 8 }}>último erro: {i.ultimo_erro}</p>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              {i.estado !== 'open' && (
                <button className="btn sm" disabled={ocupado}
                  onClick={() => agir(i.nome, () => evoConectar(i.nome))}>
                  <QrCode size={15} /> {i.qr_fresco ? 'Gerar QR de novo' : 'Gerar QR'}
                </button>
              )}
              <button className="btn ghost sm" disabled={ocupado}
                onClick={() => agir(i.nome, () => evoEstado(i.nome))}>
                Conferir estado
              </button>
              {admin && i.estado === 'open' && desconectando !== i.nome && (
                <button className="btn danger sm" disabled={ocupado}
                  onClick={() => { setDesconectando(i.nome); setErro(null) }}>
                  Desconectar
                </button>
              )}
              {/* Apagar so aparece com o numero DESCONECTADO. Em 11/08 uma instancia conectada foi
                  apagada por engano no lugar de uma desconectada: o token dela morreu junto e levou
                  5 workflows do n8n a 401. Desconectar primeiro forca o olho no card certo. */}
              {admin && apagando !== i.nome && i.estado !== 'open' && (
                <button className="btn danger sm" disabled={ocupado}
                  onClick={() => { setApagando(i.nome); setConfirmacao(''); setErro(null) }}>
                  Apagar
                </button>
              )}
            </div>

            {desconectando === i.nome && (
              <div style={{ marginTop: 12 }}>
                <p className="mut" style={{ fontSize: 12.5 }}>
                  <b>Desconectar {i.nome}?</b> O número para de enviar na hora e só volta quando
                  alguém estiver com o celular na mão pra ler o QR de novo. Desconectar é
                  reversível e <b>não</b> mata o token, ao contrário de apagar.
                </p>
                <div className="row">
                  <button className="btn danger sm" disabled={ocupado}
                    onClick={() => agir(i.nome, async () => {
                      await evoDesconectar(i.nome); setDesconectando(null)
                    }, 'Desconectando o número')}>
                    Desconectar mesmo assim
                  </button>
                  <button className="btn ghost sm" disabled={ocupado} onClick={() => setDesconectando(null)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {apagando === i.nome && (
              <div style={{ marginTop: 12 }}>
                <p className="mut" style={{ fontSize: 12.5 }}>
                  <b>Apagar remove a instância da Evolution e não tem volta.</b> O histórico e os
                  grupos lidos dela somem, e o <b>token dela morre</b>: se algum fluxo do n8n
                  estiver usando esse token em vez da chave global, ele passa a dar erro 401.
                  Recriar com o mesmo nome gera um token NOVO, não o antigo.
                  Pra confirmar, digite <b>{i.nome}</b> abaixo.
                </p>
                <div className="field" style={{ maxWidth: 320 }}>
                  <input aria-label={`digite ${i.nome} pra confirmar`} placeholder={i.nome}
                    value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} />
                </div>
                <div className="row">
                  <button className="btn danger sm" disabled={ocupado || confirmacao.trim() !== i.nome}
                    onClick={() => agir(i.nome, async () => {
                      await evoApagar(i.nome, confirmacao.trim())
                      setApagando(null); setConfirmacao('')
                    }, 'Número apagado')}>
                    Apagar de verdade
                  </button>
                  <button className="btn ghost sm" disabled={ocupado}
                    onClick={() => { setApagando(null); setConfirmacao('') }}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {erroDe(i.nome)}
          </div>
        )
      })}
    </section>
  )
}
