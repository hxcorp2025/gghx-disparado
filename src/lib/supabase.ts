import { createClient } from '@supabase/supabase-js'
import { CONFIG } from './config'

export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY)
