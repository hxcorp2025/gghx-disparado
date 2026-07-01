import { useEffect, useState } from 'react'
import { onToast } from '../lib/toast'

export function Toast() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null)
  useEffect(() => {
    return onToast((t) => {
      setMsg(t)
      const id = setTimeout(() => setMsg(null), 3200)
      return () => clearTimeout(id)
    })
  }, [])
  if (!msg) return null
  return <div className={'toast' + (msg.err ? ' err' : '')}>{msg.text}</div>
}
