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
por conta nos grupos. Frontend já tem os seletores prontos (hoje só 'HxSend').

Backend (esboço):
- **Tabela `gghx_contas`**: `id`, `nome`, `instance_id`/`token` (refs Vault), `numero`, `status`, `criado_em`.
  Popular HxSend como a 1ª linha.
- **`gghx_grupos.conta_id`** (FK) = tag de origem (hoje é `instancia` text default 'HxSend').
- **Motor parametrizado por conta**: hoje `ZBASE`/`ZCLIENT` são const (só HxSend). Ler da `gghx_contas`
  pelo `conta_id` do disparo. Lock passa a ser 1-disparo-por-conta (já é por chip).
- **Criar/gerir instâncias**: Z-API Partner API — `POST /instances/integrator/on-demand` (cria, retorna
  id+token), `list-instances`, `unsubscribe-instance`. Integrator Token cria até 25 instâncias.
  Guardar id/token de cada instância no Vault. ~R$/instância/mês (confirmar preço com Z-API).
- **Conexão por conta**: workflow `HX-gghx-conexao` parametrizado pela instância da conta.
- Cada conta = 1 chip = pode rodar 1 disparo em paralelo com as outras.

Frontend a ligar quando o backend existir: aba Conexão vira gestão de N contas; seletor de número no
wizard (etapa 2) e no import de grupos por conta.

---

## Referência rápida (IDs)

- Supabase projeto: `ntavetjmfotlwmcgwsju`
- Motor: n8n `HX-gghx-disparar` id `0W9yI1VhSE05G3HN` (webhook `.../webhook/HX-gghx-disparar`)
- Sync: `HX-gghx-sync-grupos` `KIypwJ8zwUOYl9HH` · Conexão: `HX-gghx-conexao` `v5BPpdFWqn8jOY48`
- Tracking: `9y0fgYlgP2B6UbJQ` · Snapshot: `131ImYnKQKLxKYSB` · Cleanup: `0K5e4Nqi0f1Z7HaE`
