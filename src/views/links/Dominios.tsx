import { useState } from 'react'
import { Globe, Copy, Plus, RefreshCw, AlertTriangle } from 'lucide-react'
import {
  linksDominioCadastrar, linksDominioEstado, linksDominioReverificar, raizDe,
  type LinkDominiosPainel, type DominioEstado,
} from '../../lib/linksDb'
import { Empty } from '../../components/Empty'
import { SkeletonList } from '../../components/Skeleton'
import { toast } from '../../lib/toast'
import { n, quando, Ajuda, BADGE, copiarTexto } from './comum'

type Props = { doms: LinkDominiosPainel | null; carregando: boolean; recarregar: () => Promise<void> }

// =====================================================================
// Dominios do rodizio. Tela de 03/09 (gate de 34 correcoes), movida pra
// um arquivo proprio sem mudar comportamento.
// =====================================================================
export function Dominios({ doms, carregando, recarregar }: Props) {
  const [novoDom, setNovoDom] = useState('')
  const [ocupado, setOcupado] = useState(false)

  const resumo = doms?.resumo
  const poucos = resumo ? resumo.raizes < resumo.minimo : false

  async function cadastrarDominio() {
    const h = novoDom.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
    if (!h || ocupado) return
    setOcupado(true)
    try {
      const r = await linksDominioCadastrar(h, raizDe(h))
      toast(r.aviso ?? 'Domínio cadastrado.')
      setNovoDom('')
      await recarregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function reverificar(host: string) {
    if (ocupado) return
    setOcupado(true)
    try {
      const r = await linksDominioReverificar(host)
      toast(r.aviso ?? 'Vou conferir agora.')
      await recarregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    } finally {
      setOcupado(false)
    }
  }

  async function mudarEstado(host: string, estado: DominioEstado) {
    try {
      const r = await linksDominioEstado(host, estado)
      toast(r.aviso ?? 'Pronto.')
      await recarregar()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falhou', true)
    }
  }

  return (
    <>
      {resumo && (
        <div className="dispmeta">
          <span className={'badge ' + (poucos ? 'b-agendado' : 'b-concluida')}>
            Rodízio: {resumo.raizes} de {resumo.minimo} domínios
          </span>
          <span className="mchip">{resumo.ativos} ativos</span>
          {resumo.pendentes > 0 && <span className="mchip">{resumo.pendentes} esperando DNS</span>}
          {resumo.banidos > 0 && <span className="mchip">{resumo.banidos} banidos</span>}
        </div>
      )}

      {poucos && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--amber)' }}>
          <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
            <AlertTriangle size={17} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <b>O rodízio está com {resumo!.raizes} domínio(s) de raiz distinta.</b>
              <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>
                Pra disparo em massa, rodízio sobre poucas opções não é rodízio: cada domínio novo
                divide a exposição de todos os outros. Pra link avulso (pop-up, bio, material) o
                domínio institucional resolve sozinho.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Adicionar um domínio</b>
        <p className="mut" style={{ fontSize: 13, margin: '6px 0 14px' }}>
          Você só precisa ter comprado o domínio. O resto acontece aqui.
        </p>

        <div className="field">
          <label htmlFor="dom-novo">1. Qual endereço você quer usar nos links</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="dom-novo" value={novoDom} placeholder="l.meudominio.com.br"
              onChange={(e) => setNovoDom(e.target.value)} />
            <button className="btn" onClick={cadastrarDominio} disabled={ocupado || !novoDom.trim()}>
              {ocupado ? <i className="spin" /> : <Plus size={15} />}Cadastrar
            </button>
          </div>
          {novoDom.trim() && (
            <span className="mut" style={{ fontSize: 12 }}>
              Vira <code>https://{novoDom.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]}/abc123</code>
              {' · '}raiz que conta pro rodízio: <b>{raizDe(novoDom)}</b>
            </span>
          )}
        </div>

        <div className="grouplbl" style={{ marginTop: 14 }}>DEPOIS DE CADASTRAR</div>
        <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>
          <b>2.</b> Eu mostro dois endereços de nameserver aqui embaixo, no cartão do domínio.
          Você entra no site onde comprou o domínio (Registro.br, GoDaddy, Hostinger) e troca os
          nameservers dele por esses dois.
        </p>
        <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>
          <b>3.</b> Só isso. Eu confiro de minuto em minuto e, quando o apontamento chegar,
          crio o endereço, peço o certificado e ligo o domínio no rodízio sozinho. Você não
          precisa ficar olhando a tela.
        </p>
        <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
          A troca de nameserver costuma valer em 10 a 30 minutos, mas o registrador pode levar
          algumas horas. Enquanto isso o domínio fica como "esperando você" e não entra no
          rodízio, então nenhum disparo sai por ele antes da hora.
        </p>

        <Ajuda titulo="por que preciso trocar o nameserver e não só criar um registro">
          Trocar o nameserver passa o domínio inteiro pra nossa conta, e é isso que me deixa
          criar o endereço e o certificado sem você mexer em mais nada, além de trocar destino
          e desligar o domínio na hora se ele for bloqueado. Com um registro avulso eu
          dependeria de você pra cada mudança, e numa hora de bloqueio isso custa caro.
          O domínio continua seu: você pode levar embora quando quiser.
        </Ajuda>
      </div>

      {carregando && !doms && <SkeletonList rows={3} height={110} />}
      {doms && doms.dominios.length === 0 && (
        <Empty Icon={Globe} title="Nenhum domínio cadastrado"
          sub="Sem domínio o encurtador não tem onde publicar." />
      )}

      {doms?.dominios.map((d) => (
        <div className="card" key={d.hostname} style={{ marginBottom: 10 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b>{d.hostname}</b>{' '}
              <span className={'badge ' + BADGE[d.estado].cls}>{BADGE[d.estado].txt}</span>
              {!d.no_rodizio && <span className="badge b-rascunho">fora do rodízio</span>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {d.estado === 'ativo' && (
                <button className="btn ghost sm" onClick={() => mudarEstado(d.hostname, 'suspeito')}>
                  Marcar suspeito
                </button>
              )}
              {(d.estado === 'suspeito' || d.estado === 'pausado') && (
                <button className="btn ghost sm" onClick={() => mudarEstado(d.hostname, 'ativo')}>
                  Voltar pro rodízio
                </button>
              )}
            </div>
          </div>
          {/* o passo que depende do operador: os endereços pra copiar */}
          {d.estado !== 'ativo' && d.nameservers?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="grouplbl">TROCA OS NAMESERVERS DESTE DOMÍNIO POR ESTES DOIS</div>
              {d.nameservers.map((ns) => (
                <div className="urlbox" key={ns} style={{ marginBottom: 6 }}>
                  <code>{ns}</code>
                  <button className="btn ghost sm" onClick={async () => {
                    const ok = await copiarTexto(ns)
                    toast(ok ? 'Copiado' : 'Toque e segure no endereço pra copiar', !ok)
                  }}><Copy size={13} /></button>
                </div>
              ))}
              <p className="mut" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
                Isso é feito no site onde você comprou o domínio, na parte de DNS ou
                nameservers. Troca os dois que estiverem lá por estes.
                {d.tentativas > 0 && ` Já conferi ${n(d.tentativas)} vez(es); ainda não chegou.`}
              </p>
              <button className="btn sm" style={{ marginTop: 10 }} disabled={ocupado}
                onClick={() => reverificar(d.hostname)}>
                <RefreshCw size={13} />Já troquei, confere agora
              </button>
            </div>
          )}

          {d.estado === 'pendente' && !d.nameservers?.length && (
            d.ultimo_erro ? (
              // não é erro, é o passo que falta: instrução, não alarme vermelho
              <div style={{ marginTop: 10, borderLeft: '2px solid var(--amber)', paddingLeft: 12 }}>
                <b style={{ fontSize: 13.5 }}>Falta um passo seu</b>
                <p style={{ fontSize: 13, margin: '4px 0 8px' }}>{d.ultimo_erro}</p>
                <button className="btn sm" disabled={ocupado}
                  onClick={() => reverificar(d.hostname)}>
                  <RefreshCw size={13} />Já fiz, confere agora
                </button>
              </div>
            ) : (
              <p className="mut" style={{ fontSize: 12.5, marginTop: 10 }}>
                <i className="spin" /> Preparando o domínio e buscando os nameservers. A tela
                atualiza sozinha.
              </p>
            )
          )}

          <div className="dispmeta" style={{ marginTop: 10, marginBottom: 0 }}>
            <span className="mchip">raiz {d.raiz}</span>
            <span className="mchip">{n(d.urls)} links</span>
            <span className="mchip">{n(d.entregas_7d)} entregas em 7d</span>
            <span className="mchip">{n(d.cliques_7d)} cliques em 7d</span>
            <span className="mchip">usado {quando(d.ultimo_uso)}</span>
            {d.pedido_na_fila && <span className="mchip"><i className="spin" />conferindo</span>}
          </div>
          {/* o pendente já mostrou a instrução acima; aqui só erro de verdade */}
          {d.ultimo_erro && d.estado !== 'verificando' && d.estado !== 'pendente' && (
            <p className="st-falha" style={{ fontSize: 12.5, marginTop: 8 }}>{d.ultimo_erro}</p>
          )}
        </div>
      ))}

      <Ajuda titulo="por que a raiz importa mais que o endereço">
        Quem bloqueia link (WhatsApp, Google, filtros de spam) trabalha no domínio raiz, não no
        endereço completo. Uma listagem em exemplo.com pega junto todos os l.exemplo.com,
        promo.exemplo.com e assim por diante. Por isso o rodízio conta raízes distintas: seis
        endereços do mesmo domínio seriam um alvo só, não seis.
      </Ajuda>
    </>
  )
}
