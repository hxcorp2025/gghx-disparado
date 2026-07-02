import { toast as sonner } from 'sonner'

// mantém a API antiga toast(text, err) — agora renderizado pelo Sonner
export function toast(text: string, err = false) {
  if (err) sonner.error(text)
  else sonner.success(text)
}
