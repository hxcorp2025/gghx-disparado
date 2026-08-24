import { sb } from './supabase'

// ===== Biblioteca de mídias do Send (PRD_send_upload_midia_2026-08-24) =====
// Upload vai pro bucket PÚBLICO gghx-midia (pasta disparos/, nome = uuid — nunca o nome
// original do arquivo na URL). A linha em send_midia é o catálogo; o disparo referencia
// por midia_id e o BANCO resolve a URL (ninguém injeta URL por fora).

export type MidiaTipo = 'imagem' | 'video' | 'audio'

export type Midia = {
  id: number
  tipo: MidiaTipo
  nome: string
  url: string
  mimetype: string
  tamanho_bytes: number
  criado_por: string | null
  criado_em: string
  ativa: boolean
}

// limites WhatsApp-safe (validados também no banco via constraint de tamanho)
export const LIMITES: Record<MidiaTipo, { max: number; mimes: string[]; rotulo: string }> = {
  imagem: { max: 5 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp'], rotulo: 'JPG/PNG/WebP até 5MB' },
  video: { max: 60 * 1024 * 1024, mimes: ['video/mp4'], rotulo: 'MP4 até 60MB (acima de 16MB pode falhar em aparelho antigo)' },
  audio: { max: 16 * 1024 * 1024, mimes: ['audio/ogg', 'audio/mpeg'], rotulo: 'OGG (voice note) ou MP3 até 16MB' },
}

export function tipoDoArquivo(f: File): MidiaTipo | null {
  if (LIMITES.imagem.mimes.includes(f.type)) return 'imagem'
  if (LIMITES.video.mimes.includes(f.type)) return 'video'
  if (LIMITES.audio.mimes.includes(f.type)) return 'audio'
  return null
}

export async function listMidias(): Promise<Midia[]> {
  const { data, error } = await sb
    .from('send_midia')
    .select('*')
    .eq('ativa', true)
    .order('criado_em', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return data as Midia[]
}

export async function uploadMidia(f: File, nome: string): Promise<Midia> {
  const tipo = tipoDoArquivo(f)
  if (!tipo) throw new Error('Formato não aceito. ' + Object.values(LIMITES).map((l) => l.rotulo).join(' · '))
  const lim = LIMITES[tipo]
  if (f.size > lim.max) throw new Error(`Arquivo grande demais pra ${tipo}: ${lim.rotulo}`)

  // nome respeita o check do banco (2-80) ANTES do upload — senão o arquivo vira órfão no bucket
  let nomeFinal = (nome.trim() || f.name).slice(0, 80)
  if (nomeFinal.length < 2) nomeFinal = `mídia ${new Date().toLocaleDateString('pt-BR')}`

  const ext = (f.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `disparos/${crypto.randomUUID()}.${ext}`
  const up = await sb.storage.from('gghx-midia').upload(path, f, { contentType: f.type, upsert: false })
  if (up.error) throw new Error('Upload falhou: ' + up.error.message)

  const { data: pub } = sb.storage.from('gghx-midia').getPublicUrl(path)
  const { data: me } = await sb.auth.getSession()
  const { data, error } = await sb
    .from('send_midia')
    .insert({
      tipo,
      nome: nomeFinal,
      path,
      url: pub.publicUrl,
      mimetype: f.type,
      tamanho_bytes: f.size,
      criado_por: me.session?.user?.email ?? null,
      payload: { nome_original: f.name },
    })
    .select('*')
    .single()
  if (error) {
    // catálogo falhou: tira o arquivo do bucket pra não deixar órfão
    await sb.storage.from('gghx-midia').remove([path]).catch(() => {})
    throw new Error('Upload subiu mas o catálogo falhou (arquivo removido): ' + error.message)
  }
  return data as Midia
}

export async function desativarMidia(id: number): Promise<void> {
  const { error } = await sb.from('send_midia').update({ ativa: false }).eq('id', id)
  if (error) throw new Error(error.message)
}

export function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
