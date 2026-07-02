# Guia rápido · Aba "Ferramentas" (ações em massa nas comunidades)

A aba **Ferramentas** executa ações em massa nos grupos/comunidades pela sua conta conectada (chip).
Diferente do **Disparo** (que só manda mensagem), aqui você **muda os grupos**: nome, descrição, foto,
adiciona gente e mexe em quem é admin.

## O que dá pra fazer (6 ações)

**Editar comunidade** (o chip só precisa estar no grupo)
- **Nome** · troca o nome do grupo
- **Descrição** · troca a descrição
- **Foto** · troca a imagem do grupo (URL da imagem)

**Membros e administradores** (o chip PRECISA ser admin do grupo · ver regra de ouro abaixo)
- **Adicionar membro** · coloca um número no grupo
- **Tornar admin** · promove um número a administrador
- **Remover admin** · rebaixa um administrador a membro comum

## ⭐ Regra de ouro: o chip precisa ser ADMIN do grupo

Pra **tornar admin**, **remover admin** (e em muitos grupos, **adicionar membro**), o número que executa
(o chip conectado) **tem que ser administrador daquele grupo**. Se não for, o WhatsApp recusa em silêncio e
nada acontece.

➡️ **Antes de rodar essas ações, garanta que o chip já está como admin de cada grupo-alvo.**

As ações de **nome/descrição/foto** costumam funcionar mesmo sem ser admin, porque muitos grupos deixam
qualquer membro editar a configuração. Mas isso varia por grupo. Se der erro, é porque aquele grupo restringe
a edição a admins.

## Números: pode digitar do jeito que você tem

O sistema resolve sozinho o **9º dígito** do Brasil (o WhatsApp guarda alguns números sem o 9 extra). Então
tanto faz digitar `55 51 9 9509-4114` ou `55 51 9509-4114` · a ferramenta acha o participante certo dentro do
grupo. Cole um número por linha.

## "Adicionar membro" às vezes vira convite (é normal)

Se a pessoa tem a privacidade "quem pode me adicionar a grupos" restrita, o WhatsApp **não deixa adicionar
direto**. Nesse caso o chip **envia um convite** pra ela entrar. Isso não é erro · é limitação do próprio
WhatsApp. Boa parte das adições em massa acaba virando convite.

## ⏱️ Intervalo (anti-ban) · vá devagar

O campo **Intervalo entre grupos (minutos)** define quanto tempo espera entre um grupo e o próximo. A
**Variação aleatória** soma um tempo aleatório em cima, pra não ficar robótico.

- Padrão: **15 minutos** entre grupos.
- Regra prática da casa: ~1 grupo a cada 15 min, poucos grupos por hora.
- **Quanto mais devagar, menor o risco de banir o chip.** Não tenha pressa nessas ações.

A tela mostra uma estimativa de "grupos/hora" conforme você mexe no intervalo.

## Passo a passo

1. Escolha a **ação** (nome, descrição, foto, add membro, tornar/remover admin).
2. Preencha o **valor** (o texto novo, a URL da foto, ou os números · um por linha).
3. Selecione os **grupos-alvo** (por campanha ou seleção manual).
4. Ajuste o **intervalo em minutos** (padrão 15).
5. Confirme. A ação roda em segundo plano, 1 grupo por vez.
6. Acompanhe em **"Ações recentes"** · dá pra **pausar**, **cancelar** ou **despausar**.

## Se algo falhar

- **"número não está no grupo"** · a pessoa não é participante daquele grupo (ou o número está errado).
- **Ação de admin não aplica** · quase sempre o chip **não é admin** do grupo. Promova o chip primeiro.
- **Chip caiu / erro de conexão** · confira a aba **Conexão**. Se aparecer alerta de ban, o sistema pausa
  sozinho e avisa.

---
_Ferramenta interna Hook Mídia · use chips descartáveis, nunca o número principal._
