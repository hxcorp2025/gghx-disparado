# Backend — estado

App no ar em send.hx-corp.com. Deploy do frontend: push na `main` → GitHub Actions publica.

## Status (02/07/2026)
- ✅ **Agendamento: ATIVO.** Aplicado via Supabase MCP: coluna `scheduled_at`, poller
  `gghx_fire_scheduled()` (usa a extensão **http** síncrona, não pg_net), cron `gghx-agendador`
  (1/min), e `ISECRET` do motor gravado no Vault (`gghx_motor_isecret`) server-side. Flag
  `FEATURES.agendamento=true`. Validado ponta a ponta (disparo seco 0 grupos → concluída).
- ✅ **Multi-conta: schema ATIVO** (`gghx_contas` seed hxsend, `conta_id` em grupos/campanhas
  backfillado). Frontend prep no ar. **Flag `multiconta` fica OFF** até existir 2º chip (aí:
  editar motor por conta + Partner API + insert conta + flip flag).
- ⏳ **Signup público:** desligar no painel Supabase (Auth → Providers). Management API bloqueia no auto-mode.
- ⏳ **Rotacionar service_role:** coordenado (re-bakar n8n de vários projetos).

## 0. Instâncias Evolution (11/08/2026) — a aba Conexão saiu da Z-API

A aba **Conexão** não fala mais com a Z-API. Ela conecta números na **nossa Evolution**
(`https://evolution.hx-corp.com`, v2.3.7) por uma camada no próprio Postgres. Frontend:
`src/views/Conexao.tsx` + `src/lib/evoDb.ts`. A `conexaoCall()` do `db.ts` foi removida
(o workflow `HX-gghx-conexao` segue existindo, mas nada no app o chama).

**Contrato:** o app NUNCA faz HTTP pra Evolution. `evo_pedir()` só **enfileira**; o worker
(`service_role`) executa em até ~10s e grava o resultado. Motivo: o papel `authenticated` tem
`statement_timeout` de 8s e `POST /instance/create` estoura isso — quando tentamos direto, a
transação deu rollback **com a instância já criada do outro lado** (órfã).

| Migration | O que faz |
|---|---|
| `evo_api_helper` + `evo_api_timeout_maior` | `evo_api()` — HTTP pra Evolution, chave do Vault, curl 30s. **Só postgres/service_role** |
| `evo_painel_instancias` | `evo_instancias`, `evo_fila` + RPCs `evo_pedir()` / `evo_painel()` (allowlist + papel admin) |
| `evo_worker` + `evo_worker_endurecido` + `evo_worker_acao_grupos` | worker: criar, conectar (QR), estado, logout, deletar, sincronizar, proxy, grupos |
| `evo_mascarar_payload_robusto` | tira credencial de dentro do payload em qualquer nível (token/apikey/password/uri/secret) |
| `evo_warmup_e_limites` | `evo_chip_politica`, `evo_envio_log`, `evo_teto_hoje()`, `evo_pode_enviar()`, view `evo_chips_saude` |
| `evo_grupos_leitura` | `evo_grupos` + `evo_processar_grupos()` (marca `sumiu_em` quem some da varredura) |
| `evo_vigia_itens_em_erro` | `evo_vigia_erros()` — alerta quando a fila acumula erro |

**Crons:** `evo_worker_10s` (#122, a cada **10 segundos** — o QR do WhatsApp vale ~1 min, com cron
de 1/min o código venceria antes de aparecer na tela) · `evo_sync_5min` (#128, */5, poda a fila e
pede `sincronizar` com guarda de duplicata) · `evo_grupos_6h` (#126, 25 */6) ·
`evo_vigia_erros_2h` (#129, 15 */2).

### 🔴 Antes de mexer em qualquer coisa `evo_*`

Este subsistema **já foi auditado e teve os grants fechados** (11/08). Se você recriar uma função
ou uma view aqui, ela **nasce aberta de novo** — foi assim que número de chip e GID de grupo ficaram
legíveis pela chave anon por algumas horas. Regras que valem sempre:

- Função nova ou recriada → `revoke all ... from public, anon, authenticated` + grant seletivo.
- **View nova → `revoke` também.** View de dono `postgres` sem `security_invoker` **fura a RLS** da
  tabela de baixo, mesmo com a tabela perfeitamente trancada. O app lê por RPC com gate, nunca
  por view.
- Ação destrutiva (criar/desconectar/apagar/proxy) exige `papel='admin'` dentro do SQL. Esconder o
  botão no front não é permissão: este repo é público e publica o nome da RPC.
- Nada de nome de instância cru na URL: é entrada de terceiro, valida com regex antes.
- Conferir depois: `select has_table_privilege('anon','public.<view>','SELECT')`.

## 0.1 Motor de DISPARO na Evolution (11/08/2026) — o v3.1 portado pro banco

O disparo não depende mais do motor n8n em Z-API. A lógica anti-ban inteira do v3.1 vive agora
em Postgres, e o envio sai pela nossa Evolution.

| Objeto | Papel |
|---|---|
| `evo_enviar_grupo(inst, gid, texto, mencao, forcar)` | envia + **grava `evo_envio_log` na MESMA transação** |
| `evo_participantes(inst, gid)` | menção fantasma, já sem opt-out |
| `evo_spintax(texto, grupo)` | `{a\|b\|c}` + `[grupo]` |
| `gghx_disparo_tick()` | o motor: 1 grupo por tick, cron **130 a cada 15s** |
| `gghx_disparo_recupera_orfaos()` | item preso em `enviando` volta pra fila, cron **131 (*/5)** |
| `gghx_iniciar_disparo(id)` | gatilho do painel: **roteia por conta** e devolve o motivo da recusa |
| `gghx_gid_evo(group_id)` | `1203...-group` (como o app guarda) → `1203...@g.us` (como a API quer) |

**Anti-ban preservado do v3.1:** claim atômico · lock 1 campanha por chip · intervalo clampado
5-180s + jitter · **429 pausa na hora** · **3× 403 seguidos pausam** · 404 segue · grupo sem lista
é **PULADO** (nunca cai pra `@all`, que suja a copy e é assinatura de ban) · sucesso zera o contador.

**Cutover sem big-bang:** `gghx_contas.evo_instancia` decide. Conta com instância = motor novo;
conta legada (`vault_instance`) = motor n8n. Os dois convivem até o último chip sair da Z-API.
A constraint `gghx_contas_uma_stack` impede uma conta ser as duas coisas ou nenhuma.

### 🔴 Armadilhas que este motor já paga

- **Nono dígito.** No grupo, BR aparece como `555196064788@s.whatsapp.net`, **sem o 9**. Menção
  montada a partir do número "certo" de 13 dígitos **não marca ninguém e não dá erro**. Por isso
  `evo_participantes` devolve o `phoneNumber` **cru da API**, nunca remontado.
- **`mentionsEveryOne: false` marca todo mundo** na 2.3.7 (o fix é do PR #2470, linha 2.4). O campo
  só entra no payload quando o valor é `true`.
- **LID resolvido:** a 2.3.7 devolve os dois ids no participante
  (`{"id":"...@lid","phoneNumber":"...@s.whatsapp.net"}`). Menção parcial testada no rig e
  confirmada no `contextInfo` da resposta.
- **Sem `sleep` no banco.** O intervalo é respeitado comparando com a hora do último envio, não
  segurando conexão dormindo como fazia o Code node.

## 0.2 O resto do app que a Z-API levou junto (11/08)

A assinatura vencida da Z-API não parou só o disparo: deixou **5 botões mortos** espalhados, cada
um numa tela diferente. Todos portados no mesmo dia:

| Onde | Chamava | Agora |
|---|---|---|
| Aba **Conexão** | `HX-gghx-conexao` | camada `evo_*` (instâncias próprias) |
| **Sincronizar grupos** | `HX-gghx-sync-grupos` | `gghx_sincronizar_grupos()` → `gghx_grupos_do_evo()` |
| Aba **Ferramentas** (6 ops) | `HX-gghx-extras` | `gghx_acoes_tick()` + `gghx_acao_executar()`, cron 1min |
| **Entraram/Saíram** (Estatísticas) | `HX-gghx-snapshot` | `gghx_snapshot_tick()`, cron */20 |
| **Iniciar disparo** | `HX-gghx-disparar` | `gghx_disparo_tick()`, cron 15s |

**Regra que nasceu do sync de grupos:** só entra grupo de instância com **conta de disparo ATIVA**
(`join`, não `left join`). Sem isso, um chip pessoal conectado despeja os grupos de família na
lista de escolha do disparo em massa. Aconteceu: 448 grupos, revertido com backup em
`gghx_grupos_backup_2026_08_11`.

**O snapshot cria BASELINE sem gerar movimento** na primeira leitura de cada grupo. Sem isso,
estrear um grupo despejaria milhares de "entrou" falsos no gráfico de entradas/saídas.

## 🔴 O único bloqueio de tudo isso: falta chip de disparo

Toda a cadeia está construída e passa por um ponto só. Hoje: 60 grupos ativos, todos marcados
`HxSend` (Z-API), e **nenhuma conta Evolution ativa** (só `evo_rig`, desligada de propósito depois
do teste). Enquanto isso:

- `gghx_disparo_tick` não tem campanha pra rodar
- `gghx_snapshot_tick` lê 0 grupos (é o resultado correto, não bug)
- `gghx_grupos_do_evo` insere 0 (é o que impede a contaminação)

**Destravar:** Peterson conecta um chip pela aba Conexão → criar `gghx_contas` com
`evo_instancia` apontando pra ele e `ativo=true` → definir a política de warmup na própria aba →
sincronizar grupos → gate `revisao-entrega` → primeiro disparo real.

O texto abaixo é o runbook original (histórico / passos que já foram executados p/ agendamento).

---

## 0.3 Painel de Estatisticas (03/09/2026) — a tela saiu do motor proprio

A aba **Estatisticas** parou de ler `gghx_*` e passou a ler o coletor do SendFlow.
Motivo medido: `gghx_mensagens`/`gghx_grupo_movimentos` sem dado desde **13/07** e
`gghx_grupos` desde **11/08**, entao a tela mostrava 60 grupos e 0 entradas enquanto
a operacao real tinha 101 grupos e 70,53% de taxa de entrada.

RPC unica `sendflow_painel(p_dias)`, gate `mod_is_operador()`, 77ms em 90 dias.
Runbook, armadilhas e o jeito certo de testar: **`backend/painel_estatisticas.sql`**.

O motor proprio de DISPARO continua funcionando: o que saiu foi so a leitura de
metrica morta. Consequencia conhecida: hoje nao existe tela no Send que responda
"o disparo de ontem entregou?".

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
