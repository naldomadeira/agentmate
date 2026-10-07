# Plano: melhorias do plugin mate (AgentMate)

**Data:** 2026-10-07
**Origem:** uso real do mate na spec `curadoria-da-vitrine` do genius-store-bot (revisão da branch
`feat/curadoria-vitrine` com o Codex `gpt-6.1-sol`).
**Onde fica o código:** este repositório — o plugin **AgentMate** (pacote `agentmate`, remote
`naldomadeira/agentmate`, comando `mate`); a pasta local ainda tem o nome antigo `agents-bridge-mcp`.
A cópia instalada fica em `~/.claude/plugins/marketplaces/agentmate`.

## Contexto

Pedi uma revisão "Codex `gpt-6.1-sol`, esforço high" pelo `mate_review`. O modelo foi aceito, mas
**não há como pedir esforço**: nenhuma Ferramenta `mate_*` tem esse parâmetro e nenhum adaptador o
repassa à CLI. Conferido no código:

- `src/agents/codex.ts`, `buildInvocation`: só `--model`, `--sandbox` e o prompt. Não monta
  `-c model_reasoning_effort=...`, então a revisão herdou o esforço do `config.toml` da conta.
- `src/agents/claude.ts` (~L122), `src/agents/agy.ts` (~L165), `src/agents/gemini.ts`: só `--model`.
- `src/jobs-server.ts`: o schema das Ferramentas tem `model` (~L100, ~L336, ~L376) e nada de
  esforço.

Para o Codex, o esforço é o que separa uma revisão rasa de uma profunda, e é o principal controle de
custo. Sem ele, "use o sol em high para revisar" não tem como ser cumprido: **é essencial**.

## Pendências

### P0. Parâmetro de esforço em toda Ferramenta que inicia job

- **Schema:** `effort?: "low" | "medium" | "high" | "xhigh"` em `mate_review`, `mate_ask`,
  `mate_research`, `mate_plan`, `mate_implement`, `mate_teamlead`, `mate_split`, `mate_crossreview`
  e `mate_start`, ao lado de `model`. Em `split`/`teamlead`, separar o do planejador e o dos filhos,
  como já é feito com `model`.
- **Persistência:** o job guarda `effort` em `jobs/store.ts`, e `continue`/`resume` o herdam.
- **Mapeamento por adaptador:**

| Provider | Como aplicar                                                                                                          | Observação                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| codex    | `-c model_reasoning_effort=<effort>` em `exec` e em `exec resume`                                                     | É o que o `codex-dispatch` já faz. `xhigh` só se o modelo aceitar.                   |
| claude   | Conferir no `claude --help` da versão instalada se há flag de esforço/thinking; senão, via `--settings` ou env        | Não presumir: verificar antes de implementar.                                        |
| agy      | O esforço faz parte do id (`gemini-3.1-pro-high`, `gemini-3.8-flash-medium`); a companion do agy já aceita `--effort` | Mapear `model` + `effort` para o id final, ou repassar `--effort` se a CLI aceitar.  |
| gemini   | Sem esforço na CLI headless                                                                                           | Recusar com erro claro ou ignorar com aviso no resultado. Nunca ignorar em silêncio. |

- **Padrão:** sem `effort`, usar o da configuração do agente, como hoje. Opcionalmente, um padrão por
  Ferramenta em config (ex.: `review` em `high`).
- **Transparência:** o cabeçalho do resultado (`mate_result`/`mate_wait`) e o `mate_list` mostram o
  modelo **e o esforço efetivos**.
- **Testes:** um por adaptador, cobrindo argv com e sem `effort`, `resume` e a recusa do gemini.

### P1. Conta/perfil do Codex por job

Hoje o mate usa sempre o `CODEX_HOME` padrão, a conta principal. O pool pessoal tem outras
(`zeus`, `kratos`, com `CODEX_HOME` próprio em `~/.codex-profiles/<nome>`), e o `limites --json`
sugere a de mais folga.

- **Schema:** `account?: string` nas Ferramentas, mapeado para `CODEX_HOME` no `exec-runner`.
- **Opcional:** `account: "auto"`, que consulta o `limites --json` (campo `suggestion`).
- **Resultado:** registrar a conta usada.

### P1. Validar o id do modelo antes de despachar

Um id inexistente já fez o storebot cair no fallback sem aviso (PR #120 do genius-store-bot:
`agy/claude-opus-4-6-thinking-medium` não existia).

- **Nova Ferramenta `mate_models`:** lista modelos por provider (`agy models`, catálogo do Codex
  quando houver).
- **Na hora de iniciar o job:** se a lista estiver disponível e o id não estiver nela, falhar cedo,
  com sugestões.

### P1. Modelo efetivo, uso e custo no resultado

- **Modelo efetivo:** extrair do stream JSON do Codex e do Claude o modelo que respondeu, os tokens
  (entrada, saída, reasoning) e a duração.
- **Onde mostrar:** no cabeçalho do resultado, como a companion do agy já faz com a linha `Usage:`.
- **Para quê:** saber o que cada revisão custou e confirmar que o esforço pedido foi usado.

### P2. Revisão que precisa rodar testes

O `mate_review` roda o Codex em `read-only`. Nesse modo o worker não escreve cache do vitest nem
abre conexão com o Postgres local, então "rode os testes de integração para confirmar" pode falhar
por sandbox, não por bug.

- **Opção explícita:** `allowCommands: true` (ou `sandbox: "workspace-write"`) no review. O prompt
  continua proibindo editar arquivos, e o resultado avisa que o sandbox foi ampliado.
- **No resultado:** distinguir "não verifiquei por sandbox" de "verifiquei e passou".

### P2. Contexto de sessão reaproveitável

Para revisões longas, o coordenador escreve um `context` enorme a cada despacho. Integrar com
`mate_session_start` e `mate_session_notes`: o `context` fixo da spec vai para a sessão uma vez e
cada job só acrescenta o foco.

## Feedback de uso (Claude Opus 5.5, como coordenador, 2026-10-07)

Contexto: numa sessão longa, fui o coordenador de 12 tasks. Usei três caminhos para chamar outros
agentes: o `codex-dispatch` (skill codex-pool), a companion do agy (`agy-companion.mjs review`) e o
mate (`mate_review`). Comparar os três ajuda a enxergar o que falta no mate.

**O que funcionou bem no mate**

- **Inbox no hook `UserPromptSubmit`:** as mensagens intermediárias do worker ("vou revisar…",
  "identifiquei uma falha…") chegaram sozinhas, sem eu fazer polling. Foi o melhor recurso do mate
  nesta sessão: eu sabia que o job andava sem gastar tool calls.
- **Contrato do `mate_review`:** `target`, `focus` e `context` separados forçaram um briefing
  organizado, e o modo só leitura deu a segurança de revisar sem risco de edição.
- **Arranque:** com `waitSeconds: 0` o despacho voltou na hora e o resto do trabalho seguiu.
- **Qualidade do resultado:** em 152 s, o `gpt-6.1-sol` (mesmo sem esforço explícito) devolveu
  9 achados reais, com arquivo e linha, cenário de falha e correção sugerida. Eram condições de
  corrida entre ler a evidência e aplicar a Proposta, e lacunas nas decisões V12/V14. Duas revisões
  anteriores com Gemini, uma delas aprovada sem achados, não tinham pegado nada disso. O formato
  (Findings → Suggested fixes → Verdict → o que não foi verificado) virou uma task de correção quase
  sem reescrita.

**O que atrapalhou**

- **Sem esforço:** o pedido do usuário ("sol, esforço high") não pôde ser cumprido, e eu tive de
  avisar que a revisão rodaria no esforço padrão. Com o `codex-dispatch` isso é um argumento
  (`--effort high`), e a companion do agy tem `--model` e `--effort`. O mate fica atrás dos dois
  justamente no controle que mais pesa em revisão.
- **Sem confirmação do modelo:** mandei `gpt-6.1-sol` sem saber se o id existia (vi esse nome no
  `limites`). Se não existisse, só descobriria no fim. Falta `mate_models` e o modelo efetivo no
  resultado.
- **Sem escolha de conta:** o `codex-dispatch` escolhe a conta pelo `limites` (principal, zeus,
  kratos); o mate sempre usa a principal, que estava com 27 % de folga semanal. Numa rodada de
  revisões, isso consome a conta errada.
- **`context` repetido:** escrevi cerca de 2 KB de contexto (spec, decisões, o que já foi feito,
  revisões anteriores, como rodar a integração). Em revisões seguintes da mesma branch eu
  reescreveria tudo. A sessão (`mate_session_*`) poderia guardar isso, mas não há caminho óbvio
  para dizer "use o contexto da sessão X".
- **Sandbox de revisão:** pedi "rode só testes alvo, se quiser", mas no `read-only` do Codex isso
  provavelmente falha (cache do vitest, socket do Postgres). O resultado precisa dizer se não
  verificou por causa do sandbox.
- **Descoberta:** as Ferramentas `mate_*` vêm diferidas e precisei de `ToolSearch` antes de usar.
  Isso não é culpa do mate, mas as descrições curtas e boas ajudaram a achar a certa de primeira.

**Resumo:** para revisão, o mate tem o melhor desenho (contrato, inbox, só leitura). Para controle de
execução, ainda perde do `codex-dispatch`: esforço, conta, modelo efetivo e custo. Com o P0 e os P1
deste plano, o mate passa a substituir o `codex-dispatch` no uso diário, em vez de conviver com ele.

## Ordem sugerida

1. **P0 esforço.** É pequeno: schema, persistência, um mapeamento por adaptador e testes.
2. **P1 modelo efetivo e uso**, para conferir o P0 na prática.
3. **P1 validação de modelo.**
4. **P1 conta do Codex.**
5. **P2.**

## Como validar

- Despachar `mate_review` com `provider: codex`, `model: gpt-6.1-sol` e `effort: high`.
- Conferir no processo (`ps`) o `-c model_reasoning_effort=high`.
- Conferir que o cabeçalho do resultado mostra `gpt-6.1-sol · high`.
- Repetir com o gemini: deve recusar ou avisar, nunca ignorar em silêncio.
