// Renderiza texto no estilo WhatsApp p/ o preview (client-side, sem API).
// Ordem: escapar HTML → aplicar formatação → auto-linkar URLs.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

// aplica marcação inline do WhatsApp; roda sobre texto JÁ escapado
function applyFormatting(s: string): string {
  // monospace ```texto```
  s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>')
  // negrito *texto*  (não vazio, sem quebra de linha)
  s = s.replace(/(^|[\s.,!?(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=$|[\s.,!?)])/g, '$1<b>$2</b>')
  // itálico _texto_
  s = s.replace(/(^|[\s.,!?(])_(?!\s)([^_\n]+?)(?<!\s)_(?=$|[\s.,!?)])/g, '$1<i>$2</i>')
  // tachado ~texto~
  s = s.replace(/(^|[\s.,!?(])~(?!\s)([^~\n]+?)(?<!\s)~(?=$|[\s.,!?)])/g, '$1<s>$2</s>')
  return s
}

function linkify(s: string): string {
  // URLs http(s) ou www. — evita capturar dentro de tags já inseridas
  return s.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (url) => {
    const href = url.startsWith('http') ? url : 'https://' + url
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`
  })
}

export function waToHtml(text: string): string {
  if (!text) return ''
  return linkify(applyFormatting(escapeHtml(text)))
}
