# Backend — o que falta rodar em produção (janela dedicada)

O app novo (frontend) está no ar em send.hx-corp.com. Estas tarefas mexem em infra de
produção (Supabase SQL / n8n) e por isso ficam fora do fluxo automático — rodar com
revisão, em janela de baixo tráfego, sem disparo pendente.

Deploy do frontend: push na `main` → GitHub Actions builda e publica sozinho.

---

## 1. Agendamento (Fase 2)

**Arquivo:** [`agendamento.sql`](./agendamento.sql) — poller Supabase-native (pg_cron + pg_net), sem n8n.

Passos:
1. Pegar o `ISECRET` do motor no n8n (workflow `HX-gghx-disparar`, id `0W9yI1VhSE05G3HN`, Code node,
   `const ISECRET='...'`).
2. `SELECT upsert_secret('gghx_motor_isecret', '<ISECRET>', 'segredo interno do motor gghx');`
3. Rodar `agendamento.sql` no SQL Editor (cria coluna + índice + função + cron 1min).
4. `src/lib/config.ts` → `FEATURES.agendamento = true` → commit/push (deploya).
5. Teste: criar disparo agendado p/ +2min num grupo interno; confirmar que inicia sozinho.

Frontend já pronto (dormante atrás da flag): wizard etapa 4 tem o campo de data/hora e
`agendarDisparo()` grava `status='agendado' + scheduled_at`.

---

## 2. Hardening

- **Desligar signup público** (Supabase → Authentication → Sign In/Providers → desmarcar
  "Allow new users to sign up"). Ou via API:
  `PATCH https://api.supabase.com/v1/projects/ntavetjmfotlwmcgwsju/config/auth {"disable_signup": true}`.
- **Rotacionar `service_role`** — CUIDADO: está embutida nos workflows n8n do disparador **e de
  outros projetos (PDM/Sortudão)**. Rotacionar = trocar no Supabase + re-bakar em TODOS os Code
  nodes que a usam. Tarefa coordenada, janela dedicada. Não fazer isolado.

---

## 3. Multi-conta / multi-número (Fase 3)

Objetivo: várias contas Z-API (números), cada disparo escolhe de qual número sai; tag de origem
por conta nos grupos. Cada conta = 1 chip = roda 1 disparo em paralelo com as outras.

**Arquivo:** [`multiconta.sql`](./multiconta.sql) — cria `gghx_contas`, seed HxSend, adiciona
`conta_id` em `gghx_grupos` (tag de origem) e `gghx_campanhas`, com backfill e índices.

Ordem:

**A) SQL** — rodar `multiconta.sql` no SQL Editor.

**B) Motor** (`HX-gghx-disparar`, id `0W9yI1VhSE05G3HN`, Code node) — 2 mudanças:
1. Resolver ZBASE/ZCLIENT por conta em vez de const (`const ZBASE='...'`). Inserir depois de carregar
   `camp` (que agora tem `conta_id`):
   ```js
   const contaId = camp.conta_id || 'hxsend';
   const cs = await http({method:'GET',url:SB+'/gghx_contas?id=eq.'+contaId+'&select=*',headers:sbH,json:true});
   const conta = cs && cs[0]; if(!conta) return [{json:{ok:false,error:'conta nao encontrada'}}];
   const gsec = async (n)=>{ const r=await http({method:'POST',url:SB+'/rpc/get_secret',headers:sbH,body:{secret_name:n},json:true}); return r; };
   const iid = await gsec(conta.vault_instance);
   const itok = await gsec(conta.vault_token);
   const ZCLIENT = await gsec(conta.vault_client_token);
   const ZBASE = 'https://api.z-api.io/instances/'+iid+'/token/'+itok;
   ```
   (o motor já tem `service_role`, então pode chamar o RPC `get_secret`.)
2. **Lock por conta**: a query do lock (1 campanha rodando) passa a filtrar por `conta_id` — assim
   contas diferentes rodam em paralelo:
   ```
   /gghx_campanhas?status=eq.rodando&conta_id=eq.<contaId>&id=neq.<campId>
   ```
   Gravar `instancia` nos inserts de `gghx_mensagens`/`gghx_eventos` = `contaId` (não 'HxSend' fixo).

**C) Sync + Conexão** — aceitar `conta_id` no body: o sync grava `gghx_grupos.conta_id` (tag) e usa a
instância da conta; o `HX-gghx-conexao` faz status/qr/disconnect da instância da conta.

**D) Partner API — adicionar um número novo:**
```bash
# cria instância (Partner Token no header)
curl -s -X POST "https://api.z-api.io/instances/integrator/on-demand" \
  -H "Authorization: Bearer <PARTNER_TOKEN>" -H "Content-Type: application/json" \
  -d '{"name":"Disparador 2"}'
# resposta: { id, token, due }  → guardar no Vault:
#   SELECT upsert_secret('zapi_conta2_instance_id', '<id>', 'z-api conta2');
#   SELECT upsert_secret('zapi_conta2_instance_token', '<token>', 'z-api conta2');
# e inserir a conta:
#   INSERT INTO gghx_contas (id,nome,vault_instance,vault_token)
#   VALUES ('conta2','Disparador 2','zapi_conta2_instance_id','zapi_conta2_instance_token');
```
Integrator Token cria até 25 instâncias. Preço por instância/mês: confirmar com a Z-API.

**E) Frontend** — `src/lib/config.ts` → `FEATURES.multiconta = true`. Já pronto (dormante):
`listContas()` lê `gghx_contas` (fallback HxSend), o wizard (etapa 2) e a aba Conexão usam as contas
reais, e o disparo passa `conta_id`. Aba Conexão vira gestão de N contas; Grupos ganha filtro por conta.

---

## Referência rápida (IDs)

- Supabase projeto: `ntavetjmfotlwmcgwsju`
- Motor: n8n `HX-gghx-disparar` id `0W9yI1VhSE05G3HN` (webhook `.../webhook/HX-gghx-disparar`)
- Sync: `HX-gghx-sync-grupos` `KIypwJ8zwUOYl9HH` · Conexão: `HX-gghx-conexao` `v5BPpdFWqn8jOY48`
- Tracking: `9y0fgYlgP2B6UbJQ` · Snapshot: `131ImYnKQKLxKYSB` · Cleanup: `0K5e4Nqi0f1Z7HaE`
