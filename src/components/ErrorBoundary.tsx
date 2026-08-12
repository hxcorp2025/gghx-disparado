import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props { children: ReactNode }
interface State { erro: Error | null }

// Rede de proteção do app. Sem isto, um dado inesperado (ex.: um registro com
// campo null vindo do banco) lança no render e o React 19 desmonta a árvore
// inteira -> tela branca, sem pista nenhuma pro operador no celular. Com o
// boundary, o erro vira um card legível com a mensagem real + botão de recarregar.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { erro: null }

  static getDerivedStateFromError(erro: Error): State {
    return { erro }
  }

  componentDidCatch(erro: Error, info: ErrorInfo) {
    console.error('Gestor de Grupos HX quebrou:', erro, info.componentStack)
  }

  render() {
    if (!this.state.erro) return this.props.children
    return (
      <div className="empty" style={{ padding: '10vh 16px' }}>
        <div className="empty-ico"><AlertTriangle size={24} /></div>
        <div className="empty-title">Algo quebrou nesta tela</div>
        <div className="empty-sub" style={{ maxWidth: 520, margin: '6px auto 0' }}>
          {this.state.erro.message || 'Erro inesperado.'}
        </div>
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn" onClick={() => location.reload()}>Recarregar</button>
        </div>
      </div>
    )
  }
}
