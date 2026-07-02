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
          background: '#1e1e22',
          border: '1px solid rgba(255,255,255,0.11)',
          color: '#ececee',
        },
      }}
    />
  )
}
