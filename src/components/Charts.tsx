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
import type { StatDia, DisparoDia } from '../lib/db'

const GRID = 'rgba(255,255,255,0.06)'
const AXIS = '#6a6a72'
const ACCENT = '#2fbd74'
const BLUE = '#4a9bff'
const AMBER = '#f5a623'

const fmtDia = (d: string) => {
  const [, m, dd] = d.split('-')
  return `${dd}/${m}`
}

const tooltipStyle = {
  background: '#1e1e22',
  border: '1px solid rgba(255,255,255,0.11)',
  borderRadius: 10,
  fontSize: 12,
  color: '#ececee',
}

// Entregas por dia (enviadas / entregues / lidas)
export function EntregasChart({ data }: { data: StatDia[] }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="gEnv" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={AMBER} stopOpacity={0.35} />
            <stop offset="100%" stopColor={AMBER} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gEnt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
            <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gLid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BLUE} stopOpacity={0.35} />
            <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="dia" tickFormatter={fmtDia} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={34} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => fmtDia(String(l))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="enviadas" name="Enviadas" stroke={AMBER} fill="url(#gEnv)" strokeWidth={2} />
        <Area type="monotone" dataKey="entregues" name="Entregues" stroke={ACCENT} fill="url(#gEnt)" strokeWidth={2} />
        <Area type="monotone" dataKey="lidas" name="Lidas" stroke={BLUE} fill="url(#gLid)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// Disparos por dia (barras)
export function DisparosChart({ data }: { data: DisparoDia[] }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="dia" tickFormatter={fmtDia} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={34} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => fmtDia(String(l))} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar dataKey="n" name="Disparos" fill={ACCENT} radius={[5, 5, 0, 0]} maxBarSize={38} />
      </BarChart>
    </ResponsiveContainer>
  )
}
