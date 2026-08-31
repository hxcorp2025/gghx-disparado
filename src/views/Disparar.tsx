import { useCallback, useEffect, useState } from 'react'
import { Rocket } from 'lucide-react'
import { copyRevisar } from '../lib/copyDb'
import type { CopyVariacao } from '../lib/copyDb'
import { Empty } from '../components/Empty'
import { DisparoSendflow } from '../components/DisparoSendflow'

// Aba "Disparar cópias": SÓ escolhe entre as cópias APROVADAS (a biblioteca de geração/revisão
// mora na aba "Copy com IA") e dispara pelo motor do SendFlow. Busca as aprovadas por conta
// própria pela mesma RPC da biblioteca (hx_copy_revisar). Ver PRD_copyia_biblioteca_disparo_2026-08-13.
export function Disparar() {
  const [aprovadas, setAprovadas] = useState<CopyVariacao[]>([])
  const [carregou, setCarregou] = useState(false)
  const [erro, setErro] = useState('')

  const carregar = useCallback(async () => {
    try {
      const vars = await copyRevisar(false)
      setAprovadas(vars.filter((v) => v.aprovada === true))
      setErro('')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui carregar as cópias.')
    } finally {
      setCarregou(true)
    }
  }, [])

  useEffect(() => {
    carregar()
  }, [carregar])

  if (erro) {
    return (
      <section>
        <h2>Disparar cópias</h2>
        <Empty Icon={Rocket} title="Não consegui carregar" sub={erro} />
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn" onClick={carregar}>
            Tentar de novo
          </button>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2>Disparar cópias</h2>
      <p className="mut" style={{ marginTop: 0, maxWidth: 680 }}>
        Aqui você só escolhe entre as cópias já <b>aprovadas</b> e dispara pelo motor do SendFlow.
        Para gerar, revisar e aprovar cópias (e comentar as reprovadas pra IA melhorar), use a aba{' '}
        <b>Copy com IA</b>.
      </p>

      {carregou && aprovadas.length === 0 ? (
        <Empty
          Icon={Rocket}
          title="Nenhuma cópia aprovada ainda"
          sub="Vá na aba Copy com IA, cole a mensagem e aprove as variações. Elas aparecem aqui pra disparar."
        />
      ) : (
        <DisparoSendflow aprovadas={aprovadas} onRecarregar={carregar} />
      )}
    </section>
  )
}
