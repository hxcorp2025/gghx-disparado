import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Custom domain (send.hx-corp.com) → base '/'
// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [react()],
})
