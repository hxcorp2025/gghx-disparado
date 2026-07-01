// Renderiza texto no estilo WhatsApp p/ o preview (client-side, sem API).
// Ordem: escapar HTML → aplicar formatação → auto-linkar URLs.
// Sem lookbehind de regex (compat. com Safari/iOS antigos).

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

// envolve trechos delimitados (*, _, ~) que não começam/terminam com espaço
function wrap(s: string, delim: string, open: string, close: string): string {
  const d = '\\' + delim
  const re = new RegExp(d + '([^\\n' + delim + ']+)' + d, 'g')
  return s.replace(re, (m, inner: string) => (/^\s|\s$/.test(inner) ? m : open + inner + close))
}

function applyFormatting(s: string): string {
  s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>') // monospace
  s = wrap(s, '*', '<b>', '</b>') // negrito
  s = wrap(s, '_', '<i>', '</i>') // itálico
  s = wrap(s, '~', '<s>', '</s>') // tachado
  return s
}

function linkify(s: string): string {
  return s.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (url) => {
    const href = url.startsWith('http') ? url : 'https://' + url
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`
  })
}

export function waToHtml(text: string): string {
  if (!text) return ''
  return linkify(applyFormatting(escapeHtml(text)))
}
