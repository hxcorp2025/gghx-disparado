// Toast global minimalista (pub/sub)
type ToastMsg = { text: string; err?: boolean; id: number }
type Listener = (t: ToastMsg) => void

let seq = 0
const listeners = new Set<Listener>()

export function toast(text: string, err = false) {
  const msg = { text, err, id: ++seq }
  listeners.forEach((l) => l(msg))
}

export function onToast(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
