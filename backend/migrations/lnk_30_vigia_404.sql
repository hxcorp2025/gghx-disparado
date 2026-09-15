-- =====================================================================
-- lnk_30: vigia de 404 com gente. PRD Links HX v2 (15/09/2026), F1.
--
-- O caso que motivou: de 03/09 a 14/09 o slug grupo-vip-pix-do-milhao
-- (CTA do pop-up antigo do PDM) recebeu 7.443 acessos, 92% de navegador
-- in-app de Instagram/Facebook, e mandou todo mundo pra home da
-- hx-corp.com. A RPC do painel tinha o numero (perdidos_404) e a tela nao
-- mostrava. Ninguem soube por 12 dias.
--
-- Regra: slug inexistente com >= 20 acessos de GENTE (celular/tablet ou
-- navegacao real) nas ultimas 2h -> WhatsApp do Matheus, 1 aviso por slug
-- a cada 6h (cooldown do notificar_whatsapp). Scanner de vulnerabilidade
-- (.git, api, config...) chega de desktop e nao passa no filtro.
-- =====================================================================
create or replace function public.lnk_vigia_404(p_dry boolean default false)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare r record; v_msg text; v_res text; v_out jsonb := '[]'::jsonb; v_min int := 20;
begin
  for r in
    select c.host, c.slug, count(*) n,
           count(*) filter (where c.device in ('celular', 'tablet') or 'navegacao_real' = any (c.classe_motivo)) gente,
           count(*) filter (where c.ua_familia = 'in_app') in_app,
           count(distinct c.ip_hash) filter (where c.ip_hash is not null) ips,
           min(c.ts) de, max(c.ts) ate,
           (select coalesce(d.destino_404, d.destino_panico) from public.lnk_dominios d where d.hostname = c.host) destino
    from public.lnk_cliques c
    where c.ts >= now() - interval '2 hours'
      and c.link_id is null
      and 'slug_inexistente' = any (c.classe_motivo)
      and c.slug !~ '^[._]'                       -- .git, .env, __clockwork: scanner
    group by c.host, c.slug
    having count(*) filter (where c.device in ('celular', 'tablet') or 'navegacao_real' = any (c.classe_motivo)) >= v_min
    order by 3 desc
  loop
    v_msg := '🔗 Encurtador HX: link morto recebendo gente' || E'\n\n'
      || r.host || '/' || r.slug || ': ' || r.n || ' acessos nas últimas 2h, '
      || r.gente || ' de celular (' || r.in_app || ' in-app), indo pra ' || coalesce(r.destino, 'lugar nenhum') || '.' || E'\n\n'
      || 'Provável: link antigo ainda colado em algum lugar (pop-up, bio, material, mensagem).' || E'\n'
      || 'Resolve: no Send, Links > Novo link > slug personalizado "' || r.slug || '" apontando pro destino certo. O alerta para sozinho.' || E'\n\n'
      || '⚡ Heimdall Claude HX';
    if p_dry then
      v_res := 'dry';
    else
      v_res := public.notificar_whatsapp('links', 'alerta', 'lnk404:' || r.host || '/' || r.slug, v_msg, 360);
    end if;
    v_out := v_out || jsonb_build_object('slug', r.host || '/' || r.slug, 'acessos', r.n, 'gente', r.gente,
                                          'in_app', r.in_app, 'ips', r.ips, 'de', r.de, 'ate', r.ate, 'envio', v_res);
  end loop;
  return jsonb_build_object('ok', true, 'alertas', v_out, 'minimo', v_min, 'janela', '2 hours', 'em', now());
end $$;
revoke execute on function public.lnk_vigia_404(boolean) from public, anon, authenticated;

-- a cada 30 min, como o PRD pediu
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lnk_vigia_404_30min') then
    perform cron.unschedule('lnk_vigia_404_30min');
  end if;
  perform cron.schedule('lnk_vigia_404_30min', '*/30 * * * *', 'select public.lnk_vigia_404()');
end $$;
