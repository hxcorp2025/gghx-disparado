import { Toaster as SonnerToaster } from 'sonner'

// Toaster do Sonner com tema dark alinhado ao nosso design system.
export function Toast() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-center"
      richColors
      closeButton
      toastOptions={{
        style: {
          background: 'var(--surface-2)',
          border: '1px solid var(--hair-strong)',
          color: 'var(--text)',
        },
      }}
    />
  )
}
