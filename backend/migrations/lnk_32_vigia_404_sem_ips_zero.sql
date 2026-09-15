-- lnk_32 (15/09/2026): vigia 404 sem a tolerância "ips = 0".
--
-- Por que existia: o Worker 1.1.0 registrava o acesso a slug morto sem ip_hash,
-- então o vigia aceitava "0 IPs distintos" como se fosse gente (senão nunca
-- alertaria). O Worker 1.2.0 (no ar 15/09 19h23 BR, deployment cbee9cfb) grava
-- ip_hash, aparelho, cidade e cookie em TODO acesso perdido, então a tolerância
-- virou buraco: 20 acessos de um scanner só já disparariam o alerta.
--
-- Regra agora: >= 20 acessos com cara de gente E >= 5 IPs distintos nas 2h.
-- Padrão da casa: reescrita textual da função com contagem de ocorrências
-- (0 ou 2+ = aborta sem mexer).
do $$
declare
  v_def text;
  v_re  text := '\(count\(distinct c\.ip_hash\) filter \(where c\.ip_hash is not null\) >= 5\s+or count\(distinct c\.ip_hash\) filter \(where c\.ip_hash is not null\) = 0\)';
  v_new text := 'count(distinct c.ip_hash) filter (where c.ip_hash is not null) >= 5';
  v_n   int;
begin
  v_def := pg_get_functiondef('public.lnk_vigia_404'::regproc);
  select count(*) into v_n from regexp_matches(v_def, v_re, 'g');
  if v_n <> 1 then
    raise exception 'lnk_32: esperava 1 ocorrência do trecho "ips = 0", achei %', v_n;
  end if;
  execute regexp_replace(v_def, v_re, v_new);
end $$;

comment on function public.lnk_vigia_404(boolean) is
  'Vigia de slug morto (pg_cron 169, a cada 10 min): alerta no WhatsApp quando um slug inexistente recebe >= 20 acessos com cara de gente e >= 5 IPs distintos em 2h; também avisa publicação travada no KV. p_dry = true só devolve o que enviaria. lnk_30 criou, lnk_32 tirou a tolerância ips = 0 (Worker 1.2.0 grava ip_hash em todo acesso perdido).';
