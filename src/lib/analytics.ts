import posthog from 'posthog-js'
import { POSTHOG_KEY, POSTHOG_HOST } from './config'

let started = false

// só inicia em produção (não polui métricas com o localhost de dev)
export function initAnalytics() {
  if (started || !POSTHOG_KEY) return
  if (typeof window !== 'undefined' && /localhost|127\.0\.0\.1/.test(window.location.hostname)) return
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,
    capture_exceptions: true, // error tracking
    autocapture: true,
    persistence: 'localStorage+cookie',
  })
  started = true
}

export function identifyUser(email: string | undefined, id?: string) {
  if (!started || !email) return
  posthog.identify(id || email, { email })
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!started) return
  posthog.capture(event, props)
}

export function resetAnalytics() {
  if (started) posthog.reset()
}
