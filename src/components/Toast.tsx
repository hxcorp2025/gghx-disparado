import { useEffect, useRef, useState } from 'react'
import { onToast } from '../lib/toast'

export function Toast() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const off = onToast((t) => {
      setMsg(t)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setMsg(null), 3200)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  if (!msg) return null
  return <div className={'toast' + (msg.err ? ' err' : '')}>{msg.text}</div>
}
