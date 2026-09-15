import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Pencil, Pause, Play, Snowflake, RefreshCw, Download, Lock, ExternalLink } from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceArea,
} from 'recharts'
import { linksDetalhe, linksEstado, type LinkDetalhe, type LinkDominiosPainel, type LinkSnapshot, type Dim } from '../../lib/linksDb'
import { SkeletonCards } from '../../components/Skeleton'
import { downloadCSV } from '../../lib/csv'
import { toast } from '../../lib/toast'
import { n, pct, quando, dataBR, Ajuda, ESTADO_LINK, UrlCurta, Barras, copiarComToast } from './comum'
import { Editor } from './Editor'

type Props = { id: string; doms: LinkDominiosPainel | null; onVoltar: () => void }
type Periodo = '24h' | '7d' | '30d' | '90d'

// meia-noite de Brasilia, N dias atras, em ISO. Sem horario de verao desde
// 2019, entao -03:00 e fixo e a conta em UTC nao desloca o dia.
function inicioDiaBR(diasAtras: number): string {
  const hojeBR = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
  const d = new Date(`${hojeBR}T00:00:00-03:00`)
  d.setUTCDate(d.getUTCDate() - diasAtras)
  return d.toISOString()
}

const tok = (nome: string, alt: string) => {
  if (typeof document === 'undefined') return alt
  const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim()
  return v || alt
}

const FAMILIA: Record<string, string> = {
  in_app: 'dentro de app (Instagram, Facebook, WhatsApp)',
  navegador: 'navegador',
  robo: 'robô',
  outro: 'outro',
}
// a Cloudflare devolve o nome da regiao em ingles em alguns casos
const REGIAO: Record<string, string> = { 'Federal District': 'Distrito Federal' }
const CLASSE: Record<string, { txt: string; cls: string }> = {
  humano: { txt: 'gente', cls: 'b-concluida' },
  crawler: { txt: 'crawler', cls: 'b-rascunho' },
  bot: { txt: 'robô', cls: 'b-rascunho' },
  interno: { txt: 'teste nosso', cls: 'b-rodando' },
  desconhecido: { txt: 'sem link', cls: 'b-agendado' },
}

function soNaoInformado(d: Dim) {
  return d.total > 0 && d.itens.length === 1 && d.itens[0].k === '(não informado)'
}

// =====================================================================
// Detalhe de UM link: e a tela que faltava. Serie, aparelho, navegador,
// regiao, referer, UTM, destinos, ultimos acessos, historico. Toda
// metrica nova vem com a nota didatica que o banco escreveu (notas).
// =====================================================================
export function Detalhe({ id, doms, onVoltar }: Props) {
  const [det, setDet] = useState<LinkDetalhe | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [periodo, setPeriodo] = useState<Periodo>('7d')
  const [porHora, setPorHora] = useState(false)
  const [editando, setEditando] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [confirmar, setConfirmar] = useState<{ msg: string; acao: () => Promise<void> } | null>(null)

  const janela = useMemo(() => {
    switch (periodo) {
      case '24h': return { de: new Date(Date.now() - 86400000).toISOString(), grao: 'hora' as const }
      case '30d': return { de: inicioDiaBR(29), grao: 'dia' as const }
      case '90d': return { de: inicioDiaBR(89), grao: 'dia' as const }
      default: return { de: null, grao: porHora ? 'hora' as const : 'dia' as const }
    }
  }, [periodo, porHora])

  const carregar = useCallback(async () => {
    try {
      setDet(await linksDetalhe(id, janela.de, null, janela.grao))
      setErro(null)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falhou')
    }
  }, [id, janela])

  useEffect(() => { carregar() }, [carregar])

  async function mudarEstado(estado: 'ativo' | 'pausado' | 'congelado', forcar = false) {
    if (ocupado) return
    setOcupado(true)
    try {
      const r = await linksEstado(id, estado, forcar)
      if (!r.ok) {
        if (r.precisa_forcar) { setConfirmar({ msg: r.erro ?? '', acao: () => mudarEstado(estado, true) }); return }
        toast(r.erro ?? 'Não consegui.', true)
        return
      }
      setConfirmar(null)
      toast((estado === 'pausado' ? 'Pausado. ' : estado === 'congelado' ? 'Congelado. ' : 'No ar. ') + (r.propagacao ?? ''))
      await carregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  const link: LinkSnapshot | undefined = det?.link
  const k = det?.kpis
  const cores = useMemo(() => ({
    grade: tok('--hair', 'rgba(255,255,255,0.07)'), eixo: tok('--dim', '#5f6670'),
    cliques: tok('--serie-1', '#a894ff'), robos: tok('--dim', '#5f6670'),
    dica: {
      background: tok('--surface-2', '#14161a'), border: `1px solid ${tok('--hair-strong', 'rgba(255,255,255,0.14)')}`,
      borderRadius: 10, fontSize: 12, fontFamily: tok('--mono', 'ui-monospace, monospace'), color: tok('--text', '#f2f3f5'),
    },
  }), [])

  const grao = det?.periodo.grao ?? 'dia'
  const fmtT = (t: string) => {
    if (grao === 'dia') { const [, m, d] = t.split('-'); return `${d}/${m}` }
    const [dia, hora] = t.split('T')
    const [, m, d] = dia.split('-')
    return periodo === '24h' ? `${hora.slice(0, 2)}h` : `${d}/${m} ${hora.slice(0, 2)}h`
  }
  const parcial = det?.serie.find((p) => p.parcial)?.t

  const exportarSerie = () => {
    if (!det) return
    downloadCSV(`serie-${link?.nome ?? 'link'}.csv`, det.serie.map((p) => ({
      periodo: p.t, cliques: p.cliques, robos: p.robos, acessos: p.acessos, parcial: p.parcial ? 'sim' : '' })))
  }
  const exportarAcessos = () => {
    if (!det) return
    downloadCSV(`acessos-${link?.nome ?? 'link'}.csv`, det.ultimos_acessos.map((a) => ({
      hora: dataBR(a.ts), classe: a.classe, contavel: a.contavel ? 'sim' : 'nao', aparelho: a.device ?? '',
      sistema: a.os ?? '', navegador: a.browser ?? '', cidade: a.cidade ?? '', estado: a.regiao ?? '',
      pais: a.pais ?? '', referer: a.referer ?? '', destino: a.destino ?? '', utm_source: a.utm_source ?? '',
      utm_campaign: a.utm_campaign ?? '', utm_content: a.utm_content ?? '', cookie: a.cookie ?? '', endereco: `${a.host}/${a.slug}` })))
  }

  if (erro && !det) {
    return (
      <>
        <button className="voltar" onClick={onVoltar}><ArrowLeft size={14} />Links</button>
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <b>Não consegui abrir esse link</b>
          <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>{erro}</p>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={carregar}><RefreshCw size={13} />Tentar de novo</button>
        </div>
      </>
    )
  }

  const est = link ? (ESTADO_LINK[link.estado] ?? ESTADO_LINK.ativo) : null
  const variacao = k?.variacao_pct

  return (
    <>
      <button className="voltar" onClick={onVoltar}><ArrowLeft size={14} />Links</button>

      {editando && link && (
        <Editor modo="editar" link={link} doms={doms} onFechar={() => setEditando(false)}
          onSalvo={() => { setEditando(false); carregar() }} />
      )}

      {!link && <SkeletonCards n={4} />}

      {link && est && (
        <>
          <div className="lk-head">
            <div style={{ minWidth: 0 }}>
              <div className="lk-title" style={{ marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>{link.nome}</h2>
                <span className={'badge ' + est.cls}>{est.txt}</span>
                {link.protegido && (
                  <span className="badge b-rascunho" title="Endereço colado em produção fora do Send: o slug não muda e pausar pede confirmação.">
                    <Lock size={11} />em produção
                  </span>
                )}
                {link.divisao === 'pessoa' && <span className="badge b-rascunho">A/B por pessoa</span>}
              </div>
              {link.tags.length > 0 && (
                <div className="lk-tags" style={{ marginBottom: 6 }}>{link.tags.map((t) => <span className="tagchip off" key={t}>{t}</span>)}</div>
              )}
              <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
                {link.destinos.filter((d) => d.ativo).length > 1
                  ? `${link.destinos.filter((d) => d.ativo).length} destinos`
                  : (link.destinos.find((d) => d.ativo)?.url ?? '(sem destino ativo)')}
                {' · '}criado {dataBR(link.criado_em)}
                {link.expira_em && ` · expira ${dataBR(link.expira_em)}`}
                {det?.frescor.ultimo_evento && ` · último acesso ${quando(det.frescor.ultimo_evento)}`}
              </p>
              {link.observacao && <p style={{ fontSize: 13, margin: '8px 0 0', maxWidth: 640 }}>{link.observacao}</p>}
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => setEditando(true)}><Pencil size={13} />Editar</button>
              {link.ativo ? (
                <button className="btn ghost sm" disabled={ocupado} onClick={() => mudarEstado('pausado')} title="Tira do ar: quem clicar vai pro destino de expirado ou pra página do domínio">
                  <Pause size={13} />Pausar
                </button>
              ) : (
                <button className="btn ghost sm" disabled={ocupado} onClick={() => mudarEstado('ativo')}>
                  <Play size={13} />Colocar no ar
                </button>
              )}
              {link.ativo && (
                link.congelado
                  ? <button className="btn ghost sm" disabled={ocupado} onClick={() => mudarEstado('ativo')} title="Volta ao cache normal"><Snowflake size={13} />Descongelar</button>
                  : <button className="btn ghost sm" disabled={ocupado} onClick={() => mudarEstado('congelado')} title="Cache longo na borda: pra link que não vai mais mudar"><Snowflake size={13} />Congelar</button>
              )}
            </div>
          </div>

          {confirmar && (
            <div className="card confirmar" style={{ marginBottom: 14 }}>
              <b>Confirma?</b>
              <p style={{ fontSize: 13, margin: '6px 0 10px' }}>{confirmar.msg}</p>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={() => confirmar.acao()} disabled={ocupado}>Sim, forçar</button>
                <button className="btn ghost" onClick={() => setConfirmar(null)}>Cancelar</button>
              </div>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <UrlCurta url={link.url_curta} nome={link.nome} hero />
            {link.urls.length > 1 && (
              <div className="dispmeta" style={{ marginTop: 8, marginBottom: 0 }}>
                {link.urls.map((u) => (
                  <button key={u.dominio} className="mchip" onClick={() => copiarComToast(u.url)} title="Copiar">
                    {u.dominio}/{u.slug}{u.protegida && <Lock size={10} />}
                  </button>
                ))}
              </div>
            )}
            {link.url_curta && (
              <a className="mut" style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center', marginTop: 6 }}
                href={link.url_curta + '?warm=painel'} target="_blank" rel="noreferrer">
                <ExternalLink size={12} />abrir numa aba (conta como acesso)
              </a>
            )}
          </div>

          {/* ---------- periodo ---------- */}
          <div className="toolbar between">
            <div className="row" style={{ gap: 6 }}>
              {(['24h', '7d', '30d', '90d'] as Periodo[]).map((p) => (
                <button key={p} className={'btn sm' + (periodo === p ? '' : ' ghost')}
                  aria-pressed={periodo === p} onClick={() => setPeriodo(p)}>{p}</button>
              ))}
              {periodo === '7d' && (
                <button className={'chip' + (porHora ? ' on' : '')} aria-pressed={porHora} onClick={() => setPorHora(!porHora)}>por hora</button>
              )}
            </div>
            {det && (
              <span className="mut" style={{ fontSize: 12 }}>
                {dataBR(det.periodo.de)} até {dataBR(det.periodo.ate)} · horário de Brasília
              </span>
            )}
          </div>

          {!det && <SkeletonCards n={4} />}

          {det && k && (
            <>
              <div className="statcards">
                <div className="statcard sc-in">
                  <div className="lbl">Cliques de gente</div>
                  <div className="val">{n(k.cliques)}</div>
                  <div className="sub">
                    {variacao == null
                      ? (k.cliques_periodo_anterior === 0 ? 'sem período anterior pra comparar' : '·')
                      : <><span className={variacao >= 0 ? 'delta-up' : 'delta-down'}>{variacao >= 0 ? '+' : ''}{pct(variacao)}</span> vs período anterior ({n(k.cliques_periodo_anterior)})</>}
                  </div>
                </div>
                <div className="statcard sc-pessoas">
                  <div className="lbl">Pessoas</div>
                  <div className="val">{k.pessoas == null ? '·' : n(k.pessoas)}</div>
                  <div className="sub">{k.pessoas == null ? 'sem cookie de visitante ainda' : `${pct(k.pct_com_cookie)} dos cliques com cookie · ${n(k.visitas_repetidas)} voltaram`}</div>
                </div>
                <div className="statcard sc-out">
                  <div className="lbl">Robôs</div>
                  <div className="val">{n(k.robos)}</div>
                  <div className="sub">{pct(k.pct_robo)} dos {n(k.acessos)} acessos</div>
                </div>
                <div className="statcard">
                  <div className="lbl">Hoje</div>
                  <div className="val">{n(k.cliques_hoje)}</div>
                  <div className="sub">último clique {quando(k.ultimo_clique)}</div>
                </div>
                {k.bloqueados > 0 && (
                  <div className="statcard sc-saldo">
                    <div className="lbl">Bloqueados</div>
                    <div className="val">{n(k.bloqueados)}</div>
                    <div className="sub">clicaram com o link pausado ou expirado</div>
                  </div>
                )}
              </div>

              <Ajuda titulo="como ler esses quatro números">
                {det.notas.cliques}<br /><br />
                <b>Pessoas.</b> {det.notas.pessoas}<br /><br />
                <b>Robôs.</b> {det.notas.robos}<br /><br />
                <b>IPs distintos</b> neste período: {n(k.ips_distintos)}. {det.notas.ips}<br />
                {k.bloqueados > 0 && <><br /><b>Bloqueados.</b> {det.notas.bloqueados}</>}
                <br /><b>Variação.</b> {det.notas.variacao}
              </Ajuda>

              {/* ---------- serie ---------- */}
              <div className="card" style={{ marginTop: 14 }}>
                <div className="row between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <b>Cliques por {grao === 'hora' ? 'hora' : 'dia'}</b>
                  <button className="btn ghost sm" onClick={exportarSerie}><Download size={13} />CSV</button>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={det.serie} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gLkCli" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={cores.cliques} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={cores.cliques} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={cores.grade} vertical={false} />
                    {parcial && <ReferenceArea x1={parcial} x2={parcial} fill={cores.eixo} fillOpacity={0.18} ifOverflow="extendDomain" />}
                    <XAxis dataKey="t" tickFormatter={(t) => (t === parcial ? 'agora' : fmtT(String(t)))}
                      stroke={cores.eixo} fontSize={11} tickLine={false} axisLine={false} minTickGap={18} />
                    <YAxis stroke={cores.eixo} fontSize={11} tickLine={false} axisLine={false} width={42} allowDecimals={false} />
                    <Tooltip contentStyle={cores.dica}
                      labelFormatter={(l) => (l === parcial ? `${fmtT(String(l))}, em andamento` : fmtT(String(l)))}
                      formatter={(v) => n(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="cliques" name="Cliques de gente" stroke={cores.cliques} fill="url(#gLkCli)" strokeWidth={2} />
                    <Area type="monotone" dataKey="robos" name="Robôs" stroke={cores.robos} fill="none" strokeWidth={1.5} strokeDasharray="4 3" />
                  </AreaChart>
                </ResponsiveContainer>
                <p className="mut" style={{ fontSize: 12, margin: '6px 0 0' }}>
                  A faixa sombreada é o {grao === 'hora' ? 'a hora' : 'o dia'} em andamento: ainda vai crescer.
                </p>
              </div>

              {/* ---------- dimensoes ---------- */}
              <div className="grouplbl" style={{ marginTop: 18 }}>QUEM CLICOU</div>
              <div className="dimgrid">
                <div className="dimcard">
                  <h4>Aparelho <span>{n(det.por_aparelho.total)}</span></h4>
                  <Barras itens={det.por_aparelho.itens} total={det.por_aparelho.total} />
                </div>
                <div className="dimcard">
                  <h4>Navegador <span>{n(det.por_navegador.total)}</span></h4>
                  <Barras itens={det.por_navegador.itens} total={det.por_navegador.total} />
                </div>
                <div className="dimcard">
                  <h4>Sistema <span>{n(det.por_sistema.total)}</span></h4>
                  <Barras itens={det.por_sistema.itens} total={det.por_sistema.total} />
                </div>
                <div className="dimcard">
                  <h4>Onde abriu <span>{n(det.por_familia.total)}</span></h4>
                  <Barras itens={det.por_familia.itens.map((i) => ({ ...i, k: FAMILIA[i.k] ?? i.k }))} total={det.por_familia.total} />
                </div>
                <div className="dimcard">
                  <h4>Estado <span>{n(det.por_regiao.total)}</span></h4>
                  <Barras itens={det.por_regiao.itens.map((i) => ({ ...i, k: REGIAO[i.k] ?? i.k }))} total={det.por_regiao.total} />
                  {det.por_regiao.restantes > 0 && <p className="mut" style={{ fontSize: 11.5, margin: '6px 0 0' }}>e mais {n(det.por_regiao.restantes)} em outros estados</p>}
                </div>
                <div className="dimcard">
                  <h4>Cidade <span>{n(det.por_cidade.total)}</span></h4>
                  <Barras itens={det.por_cidade.itens} total={det.por_cidade.total} />
                  {det.por_cidade.restantes > 0 && <p className="mut" style={{ fontSize: 11.5, margin: '6px 0 0' }}>e mais {n(det.por_cidade.restantes)} em outras cidades</p>}
                </div>
                <div className="dimcard">
                  <h4>De onde veio (referer) <span>{n(det.por_referer.total)}</span></h4>
                  {soNaoInformado(det.por_referer)
                    ? <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>Ninguém informou de onde veio. {det.notas.referer}</p>
                    : <Barras itens={det.por_referer.itens} total={det.por_referer.total} />}
                </div>
                <div className="dimcard">
                  <h4>UTM campanha <span>{n(det.por_utm.campaign.total)}</span></h4>
                  {soNaoInformado(det.por_utm.campaign)
                    ? <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>Nenhum clique chegou com utm_campaign no link curto.</p>
                    : <Barras itens={det.por_utm.campaign.itens} total={det.por_utm.campaign.total} />}
                </div>
                {!soNaoInformado(det.por_utm.source) && det.por_utm.source.total > 0 && (
                  <div className="dimcard">
                    <h4>UTM source <span>{n(det.por_utm.source.total)}</span></h4>
                    <Barras itens={det.por_utm.source.itens} total={det.por_utm.source.total} />
                  </div>
                )}
                {!soNaoInformado(det.por_utm.content) && det.por_utm.content.total > 0 && (
                  <div className="dimcard">
                    <h4>UTM content <span>{n(det.por_utm.content.total)}</span></h4>
                    <Barras itens={det.por_utm.content.itens} total={det.por_utm.content.total} />
                  </div>
                )}
              </div>
              <p className="mut" style={{ fontSize: 12, margin: '10px 0 0' }}>
                Dados preenchidos neste período: aparelho {pct(k.completude.aparelho)} · cidade {pct(k.completude.cidade)} ·
                referer {pct(k.completude.referer)} · cookie {pct(k.completude.cookie)}
              </p>
              <Ajuda titulo="o que dá pra confiar nesses gráficos">
                <b>Aparelho, sistema e navegador.</b> {det.notas.aparelho}<br /><br />
                <b>Estado e cidade</b> vêm do IP na borda da Cloudflare: bom pra estado, aproximado pra cidade
                (operadora de celular às vezes aparece na capital).<br /><br />
                <b>De onde veio.</b> {det.notas.referer}<br /><br />
                <b>UTM</b> aqui é o que veio colado NO LINK CURTO (por exemplo, o pop-up mandando
                <code> ?utm_campaign=x</code>). As UTMs que o link injeta no destino ficam na configuração, não aqui.
              </Ajuda>

              {/* ---------- destinos ---------- */}
              <div className="card" style={{ marginTop: 14 }}>
                <b>Destinos: peso configurado contra o que aconteceu</b>
                <div className="scroll" style={{ marginTop: 10 }}>
                  <table className="tabela-min">
                    <thead>
                      <tr>
                        <th>Destino</th><th className="num">Configurado</th><th className="num">Real</th>
                        <th className="num">Margem</th><th className="num">Cliques</th>
                      </tr>
                    </thead>
                    <tbody>
                      {det.por_destino.map((d) => {
                        const fora = d.comparavel && d.pct_real != null && d.pct_configurado != null && d.margem_pp != null
                          && Math.abs(d.pct_real - d.pct_configurado) > d.margem_pp
                        return (
                          <tr key={d.id} style={!d.ativo ? { opacity: 0.55 } : undefined}>
                            <td>
                              <b>{d.rotulo}</b>{!d.ativo && <span className="badge b-rascunho" style={{ marginLeft: 6 }}>desligado</span>}
                              <div className="mut" style={{ fontSize: 11.5, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.url}</div>
                            </td>
                            <td className="num">{pct(d.pct_configurado)}</td>
                            <td className="num" style={fora ? { color: 'var(--amber)' } : undefined}>{d.comparavel ? pct(d.pct_real) : '·'}</td>
                            <td className="num">{d.comparavel ? '± ' + pct(d.margem_pp) : '·'}</td>
                            <td className="num">{n(d.cliques)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {det.por_destino.length > 1 && (
                  <Ajuda titulo="por que às vezes aparece um ponto no lugar do número">
                    {det.notas.destinos} A comparação só aparece com 2 ou mais destinos ligados e a partir
                    de 30 cliques na janela. A margem é a variação normal do sorteio pra esse volume: dentro
                    dela, está tudo certo mesmo que os números não batam exatamente.
                  </Ajuda>
                )}
              </div>

              {/* ---------- ultimos acessos ---------- */}
              <div className="card" style={{ marginTop: 14 }}>
                <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <b>Últimos acessos</b>
                  <button className="btn ghost sm" onClick={exportarAcessos} disabled={!det.ultimos_acessos.length}><Download size={13} />CSV</button>
                </div>
                {det.ultimos_acessos.length === 0
                  ? <p className="mut" style={{ fontSize: 13, margin: '8px 0 0' }}>Nenhum acesso neste período.</p>
                  : (
                    <div className="scroll" style={{ marginTop: 10 }}>
                      <table className="tabela-min">
                        <thead>
                          <tr><th>Quando</th><th>Quem</th><th>Aparelho</th><th>Onde</th><th>Veio de</th><th>Destino</th><th>Cookie</th></tr>
                        </thead>
                        <tbody>
                          {det.ultimos_acessos.map((a) => {
                            const c = CLASSE[a.classe] ?? CLASSE.desconhecido
                            const bloq = a.motivos.some((m) => m === 'link_expirado' || m === 'link_inativo')
                            return (
                              <tr key={a.id}>
                                <td className="quando">{dataBR(a.ts)}</td>
                                <td><span className={'badge ' + (bloq ? 'b-agendado' : c.cls)}>{bloq ? 'bloqueado' : c.txt}</span></td>
                                <td style={{ fontSize: 12.5 }}>{[a.browser, a.os].filter(Boolean).join(' · ') || '·'}</td>
                                <td style={{ fontSize: 12.5 }}>{[a.cidade, a.regiao].filter(Boolean).join(', ') || (a.pais ?? '·')}</td>
                                <td style={{ fontSize: 12.5 }}>{a.referer ?? '·'}</td>
                                <td style={{ fontSize: 12.5 }}>{a.destino ?? '·'}</td>
                                <td style={{ fontSize: 12.5 }}>{a.cookie === 'novo' ? 'novo' : a.cookie === 'volta' ? 'voltou' : '·'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                <p className="mut" style={{ fontSize: 12, margin: '8px 0 0' }}>
                  Os 30 mais recentes do período, incluindo robôs e testes, pra você ver o que o link está recebendo.
                </p>
              </div>

              {/* ---------- historico ---------- */}
              <div className="card" style={{ marginTop: 14 }}>
                <b>Histórico de mudanças</b>
                {det.historico.length === 0
                  ? <p className="mut" style={{ fontSize: 13, margin: '8px 0 0' }}>Nenhuma mudança registrada desde 15/09/2026 (antes disso não havia histórico).</p>
                  : (
                    <div className="hist" style={{ marginTop: 8 }}>
                      {det.historico.map((h) => (
                        <div className="hist-item" key={h.id}>
                          <span>{h.resumo}{h.por && <span className="mut"> · {h.por.split('@')[0]}</span>}</span>
                          <span className="mut" style={{ whiteSpace: 'nowrap' }}>{dataBR(h.em)}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
