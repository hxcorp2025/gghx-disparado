import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Copy, Plus, RefreshCw, ShieldOff, Check } from 'lucide-react'
import {
  linksChaves, linksChaveCriar, linksChaveRevogar, linksProjetos, type ChaveApi, type EscopoApi, type LinkProjeto,
} from '../../lib/linksDb'
import { CONFIG } from '../../lib/config'
import { Empty } from '../../components/Empty'
import { SkeletonList } from '../../components/Skeleton'
import { toast } from '../../lib/toast'
import { Ajuda, copiarTexto, dataBR, n, quando } from './comum'

// =====================================================================
// Chaves de API: criar link, ler e editar por fora do Send (n8n, cliente,
// script). A chave inteira aparece UMA vez; o banco guarda so a impressao
// digital. A chave do redirecionador nao aparece aqui nem se revoga aqui.
// =====================================================================

const ESCOPOS: { id: EscopoApi; txt: string; desc: string }[] = [
  { id: 'api:criar', txt: 'criar', desc: 'cria links (lnk_api_criar)' },
  { id: 'api:ler', txt: 'ler', desc: 'lê um link com os cliques e lista links (lnk_api_ler, lnk_api_listar)' },
  { id: 'api:editar', txt: 'editar', desc: 'muda nome, destinos, tags, pausa e reativa (lnk_api_editar)' },
]

const BASE = `${CONFIG.SUPABASE_URL}/rest/v1/rpc/`

function exemplo(fn: string, corpo: Record<string, unknown>) {
  return [
    `curl -X POST "${BASE}${fn}" \\`,
    `  -H "apikey: ${CONFIG.SUPABASE_ANON_KEY}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(corpo)}'`,
  ].join('\n')
}

const EXEMPLOS: { titulo: string; fn: string; corpo: Record<string, unknown>; resposta: string }[] = [
  {
    titulo: 'Criar um link',
    fn: 'lnk_api_criar',
    corpo: { p_token: 'hxl_SUA_CHAVE', p_link: { destino: 'https://exemplo.com/pagina?utm_source=whatsapp', nome: 'VIP setembro', projeto: 'pdm', slug: 'vip-set', tags: ['vip'] } },
    resposta: '{"ok":true,"id":"...","urls":[{"url":"https://l.hx-corp.com/vip-set",...}],"link":{...}}',
  },
  {
    titulo: 'Ler um link pela URL curta (com os cliques)',
    fn: 'lnk_api_ler',
    corpo: { p_token: 'hxl_SUA_CHAVE', p_url: 'https://l.hx-corp.com/vip-set' },
    resposta: '{"ok":true,"link":{...},"kpis":{"cliques_7d":12,"cliques_hoje":3,"cliques_total":40,"pessoas_7d":9,...}}',
  },
  {
    titulo: 'Listar links de um projeto',
    fn: 'lnk_api_listar',
    corpo: { p_token: 'hxl_SUA_CHAVE', p_projeto: 'pdm', p_limite: 50 },
    resposta: '{"ok":true,"links":[{"id":"...","nome":"...","url_curta":"...","cliques_7d":...},...]}',
  },
  {
    titulo: 'Pausar, reativar ou editar',
    fn: 'lnk_api_editar',
    corpo: { p_token: 'hxl_SUA_CHAVE', p_link_id: 'ID_DO_LINK', p_patch: { estado: 'pausado' } },
    resposta: '{"ok":true,"estado":"pausado","link":{...}}  (no p_patch também cabem nome, tags, destinos, projeto, expira_em...)',
  },
]

export function Chaves() {
  const [chaves, setChaves] = useState<ChaveApi[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [nome, setNome] = useState('')
  const [escopos, setEscopos] = useState<EscopoApi[]>(['api:criar', 'api:ler'])
  // escopo de projeto (gate 15/09): chave de cliente so enxerga o projeto dela;
  // "todos" e so pra uso interno (n8n da casa). Sem escolha, nao gera.
  const [projetos, setProjetos] = useState<LinkProjeto[]>([])
  const [todos, setTodos] = useState(false)
  const [projSel, setProjSel] = useState<string[]>([])
  const nomeProjeto = (slug: string) => projetos.find((p) => p.slug === slug)?.nome ?? slug
  const [ocupado, setOcupado] = useState(false)
  const [nova, setNova] = useState<{ nome: string; token: string } | null>(null)
  const [confirmar, setConfirmar] = useState<ChaveApi | null>(null)
  // a chave nova aparece ACIMA do formulario; no celular quem acabou de tocar em
  // "Gerar chave" esta olhando pro botao, entao a tela rola ate ela
  const caixaNova = useRef<HTMLDivElement>(null)
  useEffect(() => { if (nova) caixaNova.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, [nova])

  const carregar = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([linksChaves(), linksProjetos()])
      setChaves(c)
      setProjetos(p)
      setErro(null)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falhou')
    }
  }, [])
  useEffect(() => { carregar() }, [carregar])

  async function criar() {
    if (ocupado) return
    if (!nome.trim()) { toast('Dá um nome pra chave: quem vai usar (n8n, cliente X...).', true); return }
    if (!escopos.length) { toast('Marca pelo menos um escopo.', true); return }
    if (!todos && !projSel.length) { toast('Escolhe os projetos que a chave enxerga, ou marca "todos" se for uso interno.', true); return }
    setOcupado(true)
    try {
      const r = await linksChaveCriar(nome, escopos, todos ? null : projSel)
      if (!r.token) {
        // sem a chave em maos ela e inutil e ja existe no banco: nao fingir sucesso
        toast('A chave foi registrada, mas não recebi o valor dela. Revoga essa e gera outra.', true)
        await carregar()
        return
      }
      setNova({ nome: r.nome ?? nome, token: r.token })
      setNome('')
      setProjSel([])
      setTodos(false)
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function revogar(c: ChaveApi) {
    if (ocupado) return
    setOcupado(true)
    try {
      const r = await linksChaveRevogar(c.id)
      toast(r.ja_estava ? 'Já estava revogada.' : (r.aviso ?? 'Revogada.'))
      setConfirmar(null)
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  const ativas = chaves?.filter((c) => c.ativa) ?? []
  const revogadas = chaves?.filter((c) => !c.ativa) ?? []

  return (
    <>
      <p className="mut" style={{ fontSize: 13, margin: '0 0 14px' }}>
        Uma chave deixa outro sistema (n8n, um cliente, um script) criar, ler e editar links sem entrar no
        Send. Cada chave tem um nome, escopos e o registro do último uso; o que ela fizer entra no
        histórico do link como <code>api:nome-da-chave</code>.
      </p>

      {nova && (
        <div className="card chave-box" style={{ marginBottom: 14 }} ref={caixaNova}>
          <b>Chave "{nova.nome}" criada. Copia agora: ela não aparece de novo.</b>
          <div className="urlbox hero" style={{ marginTop: 10 }}>
            <code>{nova.token}</code>
            <button className="btn sm" onClick={async () => {
              const ok = await copiarTexto(nova.token)
              toast(ok ? 'Chave copiada' : 'Toque e segure na chave pra copiar', !ok)
            }}><Copy size={13} />Copiar</button>
          </div>
          <p className="mut" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
            Eu guardo só a impressão digital dela. Perdeu, revoga e cria outra.
          </p>
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setNova(null)}><Check size={13} />Já copiei</button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Nova chave</b>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="ch-nome">Pra quem é</label>
            <input id="ch-nome" value={nome} placeholder="n8n, cliente X, script do Peterson" maxLength={60}
              onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="field" role="group" aria-labelledby="ch-escopos">
            <span id="ch-escopos" style={{ display: 'block', marginBottom: 7, fontWeight: 550, fontSize: 13 }}>O que ela pode fazer</span>
            {ESCOPOS.map((e) => (
              <label key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, marginBottom: 6 }}>
                <input type="checkbox" checked={escopos.includes(e.id)}
                  onChange={(ev) => setEscopos(ev.target.checked ? [...escopos, e.id] : escopos.filter((x) => x !== e.id))} />
                <span><b>{e.txt}</b> <span className="mut" style={{ fontSize: 12.5 }}>{e.desc}</span></span>
              </label>
            ))}
          </div>
        </div>
        <div className="field" role="group" aria-labelledby="ch-projetos">
          <span id="ch-projetos" style={{ display: 'block', marginBottom: 7, fontWeight: 550, fontSize: 13 }}>Quais projetos ela enxerga</span>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, marginBottom: 6 }}>
            <input type="checkbox" checked={todos} onChange={(ev) => setTodos(ev.target.checked)} />
            <span><b>Todos os projetos</b> <span className="mut" style={{ fontSize: 12.5 }}>só pra uso interno (o n8n da casa); nunca pra chave de cliente</span></span>
          </label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', opacity: todos ? 0.45 : 1 }}>
            {projetos.map((p) => (
              <label key={p.slug} className={'chip' + (projSel.includes(p.slug) && !todos ? ' on' : '')} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: todos ? 'not-allowed' : 'pointer' }}>
                <input type="checkbox" disabled={todos} checked={projSel.includes(p.slug)} style={{ width: 14, height: 14 }}
                  onChange={(ev) => setProjSel(ev.target.checked ? [...projSel, p.slug] : projSel.filter((x) => x !== p.slug))} />
                {p.nome}
              </label>
            ))}
            {!projetos.length && <span className="mut" style={{ fontSize: 12.5 }}>carregando os projetos...</span>}
          </div>
          <span className="mut" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            Link de outro projeto responde "não encontrado" pra essa chave. Link marcado <b>em produção</b> (URL colada
            fora do Send) nunca é editável pela API, por nenhuma chave.
          </span>
        </div>
        <button className="btn" onClick={criar} disabled={ocupado || !nome.trim() || !escopos.length || (!todos && !projSel.length)}>
          {ocupado ? <i className="spin" /> : <Plus size={15} />}Gerar chave
        </button>
      </div>

      {erro && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--red)' }}>
          <b>Não consegui carregar as chaves</b>
          <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>{erro}</p>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={carregar}><RefreshCw size={13} />Tentar de novo</button>
        </div>
      )}
      {!chaves && !erro && <SkeletonList rows={2} height={70} />}
      {chaves && chaves.length === 0 && (
        <Empty Icon={KeyRound} title="Nenhuma chave ainda" sub="Gera uma acima pra usar no n8n ou entregar pra um cliente." />
      )}

      {ativas.map((c) => (
        <div className="card" key={c.id} style={{ marginBottom: 10 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b>{c.nome}</b>{' '}
              <code className="mut" style={{ fontSize: 12 }}>{c.prefixo ?? 'hxl_'}…</code>
            </div>
            {confirmar?.id === c.id ? (
              <div className="row" style={{ gap: 6 }}>
                <span style={{ fontSize: 12.5 }}>Quem usa essa chave para de funcionar na hora.</span>
                <button className="btn sm danger" onClick={() => revogar(c)} disabled={ocupado}>Sim, revogar</button>
                <button className="btn ghost sm" onClick={() => setConfirmar(null)}>Cancelar</button>
              </div>
            ) : (
              <button className="btn ghost sm red" onClick={() => setConfirmar(c)} disabled={ocupado}><ShieldOff size={13} />Revogar</button>
            )}
          </div>
          <div className="dispmeta" style={{ marginTop: 10, marginBottom: 0 }}>
            {c.escopo.map((e) => <span className="mchip" key={e}>{e.replace('api:', '')}</span>)}
            <span className="mchip" title={c.projetos ? 'só enxerga esses projetos' : 'enxerga todos os projetos: uso interno'}>
              {c.projetos ? c.projetos.map(nomeProjeto).join(', ') : 'todos os projetos'}
            </span>
            <span className="mchip">{n(c.usos)} uso(s)</span>
            <span className="mchip">último uso {quando(c.ultimo_uso)}</span>
            <span className="mchip">criada {dataBR(c.criado_em, false)}{c.criado_por ? ` por ${c.criado_por.split('@')[0]}` : ''}</span>
          </div>
        </div>
      ))}

      {revogadas.length > 0 && (
        <details className="ajuda" style={{ marginTop: 6 }}>
          <summary>{n(revogadas.length)} chave(s) revogada(s)</summary>
          <p>
            {revogadas.map((c) => (
              <span key={c.id} style={{ display: 'block' }}>
                <b>{c.nome}</b> ({c.prefixo ?? 'hxl_'}…): revogada em {dataBR(c.revogado_em)}, {n(c.usos)} uso(s) na vida.
              </span>
            ))}
          </p>
        </details>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <b style={{ fontSize: 15 }}>Como chamar</b>
        <p className="mut" style={{ fontSize: 13, margin: '6px 0 12px' }}>
          É um POST com JSON. O cabeçalho <code>apikey</code> é público (só abre a porta); quem autoriza é
          a sua chave <code>hxl_</code> dentro do corpo. Toda resposta tem <code>ok</code>: chave errada,
          revogada ou sem o escopo devolve <code>{'{"ok":false,"erro":"nao_autorizado"}'}</code>. No n8n,
          é o nó HTTP Request com método POST, "Send Body" em JSON e esses dois cabeçalhos.
        </p>
        {EXEMPLOS.map((ex) => {
          const txt = exemplo(ex.fn, ex.corpo)
          return (
            <div key={ex.fn} style={{ marginBottom: 14 }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <b style={{ fontSize: 13.5 }}>{ex.titulo}</b>
                <button className="btn ghost sm" onClick={async () => {
                  const ok = await copiarTexto(txt)
                  toast(ok ? 'Exemplo copiado' : 'Não consegui copiar', !ok)
                }}><Copy size={13} />Copiar</button>
              </div>
              <pre className="api-pre"><code>{txt}</code></pre>
              <p className="mut api-resp" style={{ fontSize: 12, margin: '4px 0 0' }}>Resposta: <code>{ex.resposta}</code></p>
            </div>
          )
        })}
        <Ajuda titulo="o que cada campo do p_link aceita">
          <b>destino</b> (obrigatório, ou <b>destinos</b>: lista de {'{url, rotulo, peso}'} pra dividir),
          <b> nome</b> (sem ele uso o endereço), <b>projeto</b> (slug: hx-geral, pdm, ja, sortudao, lcy...),
          <b> slug</b> (3 a 40 caracteres, nasce no domínio institucional), <b>tags</b> (lista, até 10),
          <b> params</b> (UTMs: lista de {'{chave, valor}'}), <b>divisao</b> (clique ou pessoa),
          <b> observacao</b>, <b>expira_em</b> (data ISO), <b>preview</b> ({'{modo, titulo, desc, img}'}).
          As mesmas regras da tela valem aqui: o banco recusa e explica em português no campo <code>erro</code>.
          Chave com projeto definido: <b>projeto</b> pode ficar de fora quando ela enxerga um só (vai nele);
          com mais de um, é obrigatório. Link de outro projeto volta <code>link_nao_encontrado</code>; link
          <b>em produção</b> volta <code>link_protegido</code> no editar. Se o editar recusar qualquer parte,
          nada é gravado (tudo ou nada). Limite: um link por chamada e 3 segundos por pedido; pra muitos
          links de uma vez, usa "Criar vários" na aba Links ou chama em sequência.
        </Ajuda>
      </div>
    </>
  )
}
