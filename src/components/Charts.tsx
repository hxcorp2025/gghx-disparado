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
  ReferenceArea,
} from 'recharts'
import { useMemo } from 'react'
import type { SendflowDia } from '../lib/sendflowDb'

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
  entradas: tok('--serie-3', '#3dd68c'),
  saidas: tok('--critico', '#ff4d4d'),
  cliques: tok('--serie-2', '#6fa8ff'),
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
const fmtN = (n: number) => n.toLocaleString('pt-BR')

// Movimento das comunidades por dia: quem clicou, quem entrou, quem saiu.
export function FunilChart({ data }: { data: SendflowDia[] }) {
  const c = useMemo(paleta, [])
  // O coletor roda de madrugada, entao o dia de hoje entra com uma fracao do
  // movimento e desenha um penhasco falso no fim da linha. Fica sombreado.
  const parcial = data.find((d) => d.parcial)?.dia
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <defs>
          <linearGradient id="gCli" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.cliques} stopOpacity={0.28} />
            <stop offset="100%" stopColor={c.cliques} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gEnt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.entradas} stopOpacity={0.35} />
            <stop offset="100%" stopColor={c.entradas} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gSai" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.saidas} stopOpacity={0.3} />
            <stop offset="100%" stopColor={c.saidas} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={c.grade} vertical={false} />
        {parcial && (
          <ReferenceArea x1={parcial} x2={parcial} fill={c.eixo} fillOpacity={0.18} ifOverflow="extendDomain" />
        )}
        <XAxis
          dataKey="dia"
          tickFormatter={(d) => (d === parcial ? 'hoje' : fmtDia(String(d)))}
          stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false}
        />
        <YAxis stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} width={42} tickFormatter={fmtN} />
        <Tooltip
          contentStyle={c.dica}
          labelFormatter={(l) => (l === parcial ? 'hoje, parcial' : fmtDia(String(l)))}
          formatter={(v) => fmtN(Number(v))}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="cliques" name="Cliques no convite" stroke={c.cliques} fill="url(#gCli)" strokeWidth={2} />
        <Area type="monotone" dataKey="entradas" name="Entraram" stroke={c.entradas} fill="url(#gEnt)" strokeWidth={2} />
        <Area type="monotone" dataKey="saidas" name="Saíram" stroke={c.saidas} fill="url(#gSai)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// Receita das comunidades por dia. E o numero que o painel do SendFlow nao tem:
// vem do cruzamento com as vendas do Sortudao.
export function ReceitaChart({ data }: { data: { dia: string; receita: number; vendas: number }[] }) {
  const c = useMemo(paleta, [])
  const brl = (n: number) => 'R$ ' + Number(n).toLocaleString('pt-BR')
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -6, bottom: 0 }}>
        <defs>
          <linearGradient id="gRec" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.marca} stopOpacity={1} />
            <stop offset="100%" stopColor={c.marca} stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={c.grade} vertical={false} />
        <XAxis dataKey="dia" tickFormatter={fmtDia} stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis stroke={c.eixo} fontSize={11} tickLine={false} axisLine={false} width={58}
               tickFormatter={(n) => 'R$ ' + Number(n).toLocaleString('pt-BR')} />
        <Tooltip contentStyle={c.dica} labelFormatter={(l) => fmtDia(String(l))}
                 formatter={(v, n) => (n === 'Receita' ? brl(Number(v)) : fmtN(Number(v)))}
                 cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar dataKey="receita" name="Receita" fill="url(#gRec)" radius={[5, 5, 0, 0]} maxBarSize={38} />
      </BarChart>
    </ResponsiveContainer>
  )
}
