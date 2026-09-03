import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { useMemo } from 'react'
import type { StatDia, DisparoDia } from '../lib/db'

// O recharts pinta SVG com string literal em stroke/fill, entao nao enxerga
// var(--...). Em vez de repetir os hex aqui (era o que fazia o grafico ficar
// para tras a cada troca de paleta), leio o token do :root em runtime. Roda
// dentro do componente: o modulo e lazy, mas o CSS ja esta aplicado no render.
const tok = (nome: string, alt: string) => {
  if (typeof document === 'undefined') return alt
  const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim()
  return v || alt
}

const paleta = () => ({
  grade: tok('--hair', 'rgba(255,255,255,0.07)'),
  eixo: tok('--dim', '#5f6670'),
  marca: tok('--serie-1', '#a894ff'),
  enviadas: tok('--serie-4', '#f5a524'),
  entregues: tok('--serie-3', '#3dd68c'),
  lidas: tok('--serie-2', '#6fa8ff'),
  dica: {
    background: tok('--surface-2', '#14161a'),
    border: `1px solid ${tok('--hair-strong', 'rgba(255,255,255,0.14)')}`,
    borderRadius: 10,
    fontSize: 12,
    fontFamily: tok('--mono', 'ui-monospace, monospace'),
    color: tok('--text', '#f2f3f5'),
  },
})

const fmtDia = (d: string) => {
  const [, m, dd] = d.split('-')
  return `${dd}/${m}`
}

// Entregas por dia (enviadas / entregues / lidas)
export function EntregasChart({ data }: { data: StatDia[] }) {
  const c = useMemo(paleta, [])
  return (
    <ResponsiveContainer width="100%" height={230}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="gEnv" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.enviadas} stopOpacity={0.35} />
            <stop offset="100%" stopColor={c.enviadas} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gEnt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.entregues} stopOpacity={0.35} />
            <stop offset="100%" stopColor={c.entregues} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gLid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.lidas} stopOpacity={0.35} />
            <stop offset="100%" stopColor={c.lidas} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={c.grade} vertical={false} />
        <XAxis dataKey="dia" tickFormatter={fmtDia} stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} width={34} />
        <Tooltip contentStyle={c.dica} labelFormatter={(l) => fmtDia(String(l))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="enviadas" name="Enviadas" stroke={c.enviadas} fill="url(#gEnv)" strokeWidth={2} />
        <Area type="monotone" dataKey="entregues" name="Entregues" stroke={c.entregues} fill="url(#gEnt)" strokeWidth={2} />
        <Area type="monotone" dataKey="lidas" name="Lidas" stroke={c.lidas} fill="url(#gLid)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// Disparos por dia (barras)
export function DisparosChart({ data }: { data: DisparoDia[] }) {
  const c = useMemo(paleta, [])
  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.marca} stopOpacity={1} />
            <stop offset="100%" stopColor={c.marca} stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={c.grade} vertical={false} />
        <XAxis dataKey="dia" tickFormatter={fmtDia} stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} width={34} allowDecimals={false} />
        <Tooltip contentStyle={c.dica} labelFormatter={(l) => fmtDia(String(l))} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar dataKey="n" name="Disparos" fill="url(#gBar)" radius={[5, 5, 0, 0]} maxBarSize={38} />
      </BarChart>
    </ResponsiveContainer>
  )
}
