# AgentMate

[English](../README.md)

**Agentes de IA trabalham melhor juntos.**

O AgentMate conecta agentes de IA de programação para que colaborem, deleguem, revisem e ajudem uns aos outros a concluir tarefas. Dê um parceiro ao seu agente: faça o [Claude Code](https://code.claude.com/) e o [Codex CLI](https://developers.openai.com/codex/cli/) perguntarem, revisarem, pesquisarem, planejarem, implementarem, fazerem revisão cruzada, dividirem tarefas e liderarem trabalho um para o outro como jobs em segundo plano.

![Dois ambientes de desenvolvimento conectados por uma ponte segura.](../assets/illustrations/cli-bridge.png)

## Por que usar o AgentMate

- **Uma segunda opinião de outro modelo.** Pergunte algo ao outro CLI ou peça que ele revise seu diff antes de se comprometer com uma abordagem. Ele lê o repositório; não herda as suposições da sua sessão.
- **Trabalho que não bloqueia você.** Cada tarefa é um job durável em segundo plano, com um ID. A sessão que o iniciou pode terminar e o resultado continua disponível.
- **Papéis em vez de prompts soltos.** `ask`, `review`, `research`, `plan`, `implement` e `teamlead` enviam um prompt ajustado, com formato de saída definido, e rodam com as menores permissões que o papel exige. Jobs são somente leitura, a menos que você diga o contrário. O `crossreview` encadeia dois deles: um agente implementa, o outro revisa, e o ciclo roda sem você repassar nada.

## Início rápido em 60 segundos

### Instalação

Instale o plugin no host que você usa (ou nos dois) e reinicie o host.

```bash
# Claude Code
claude plugin marketplace add naldomadeira/agentmate
claude plugin install mate@agentmate

# Codex
codex plugin marketplace add naldomadeira/agentmate
codex plugin add mate@agentmate
```

O marketplace se chama `agentmate` e o plugin se chama `mate`; por isso o id de instalação é `mate@agentmate` e todo comando começa com `mate:`.

> **Vindo do Agents Bridge (0.3.0 ou anterior)?** O projeto foi renomeado para AgentMate: o pacote npm agora é `agentmate`, o plugin `mate`, as ferramentas `mate_*`, o diretório de estado `~/.agentmate` e as variáveis de ambiente `AGENTMATE_*`.
> Remova o plugin antigo (`claude plugin uninstall bridge@agents-bridge`, ou `agents-bridge@agents-bridge` da 0.2.0) e o marketplace antigo (`claude plugin marketplace remove agents-bridge`); no Codex, remova os dois (use `codex plugin --help` para ver os verbos exatos).
> Depois instale `mate@agentmate` como acima e reinicie o host. Jobs em `~/.agents-bridge` não são migrados.

### Invocar um papel

Digite `/mate:` no Claude Code para ver todos os papéis; no Codex digite `$mate` ou abra `/skills`. Os dois hosts recebem primeiro o provider e depois o pedido:

```text
/mate:ask codex É seguro rodar esta migração duas vezes? Veja db/migrate/0042.sql
$mate:ask claude Este loop de retry em src/queue.ts tem uma condição de corrida?
```

Quer comandos mais curtos (`/ask`, `/prompts:ask`)? Veja [Comandos de barra](#comandos-de-barra). Há mais exemplos em [Casos de uso](#casos-de-uso).

### Verificar a instalação

```bash
npx -y agentmate doctor
```

O `doctor` confere o Node.js, se os CLIs `codex` e `claude` estão no `PATH` e respondem a `--version`, o diretório de estado dos jobs, jobs `running` obsoletos (ele lista os IDs) e registros legados, e mostra a correção de cada problema. Ele não verifica a autenticação: se um job falhar logo ao iniciar, faça login você mesmo no CLI de destino. Consulte o [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md) para atualizar, testar localmente e limpar registros legados que sobraram.

### Para agentes

Cole isto em qualquer agente de código:

```text
Read the raw text of https://raw.githubusercontent.com/naldomadeira/agentmate/main/docs/INSTALL_FOR_AGENTS.md
(curl it - do not work from a summary) and follow it to install and verify the AgentMate plugin
for the host you are running in. Respond in the user's language.
```

### Atualização

O Claude Code e o Codex instalam uma cópia do plugin, então uma versão nova só chega quando você a puxa:

```bash
claude plugin marketplace update agentmate && claude plugin update mate@agentmate
```

```bash
codex plugin marketplace upgrade agentmate && codex plugin add mate@agentmate
```

Os hosts mantêm o plugin em cache por versão; reinicie o Claude Code ou o Codex depois. A correção só chega se a versão do plugin mudou.

## Casos de uso

Os exemplos usam o `/mate:...` do Claude Code; no Codex use `$mate:...`. O provider (`codex` ou `claude`) vem primeiro; escolha o que não é o seu host.

| Caso de uso                  | Invocação                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Segunda opinião rápida       | `/mate:ask codex Esta migração é idempotente?`                                              |
| Revisar a árvore de trabalho | `/mate:review codex Revise a árvore de trabalho atual`                                      |
| Revisar um PR ou diff        | `/mate:review codex Revise o PR #730, com foco em tratamento de erros`                      |
| Desafiar um plano            | `/mate:plan codex critique o plano de migração em docs/plan.md`                             |
| Pesquisar um tema            | `/mate:research claude Como funciona a autenticação neste repo? Compare as opções.`         |
| Implementar uma correção     | `/mate:implement codex Corrija o teste instável em test/queue.test.ts`                      |
| Acionar um team lead         | `/mate:teamlead claude Audite o tratamento de erros e proponha correções; delegue ao codex` |
| Implementar e revisar em cruz | `/mate:crossreview codex Adicione a flag --dry-run ao comando export`                      |
| Dividir um objetivo entre os dois agentes | `/mate:split codex Adicione exportação CSV e JSON ao comando report`          |
| Operar jobs                  | `/mate:jobs list`, `/mate:jobs result <id>`, `/mate:jobs cancel <id>`                   |

O `implement` e o `crossreview` editam arquivos, e o `split` também quando você passa `--mode write`; use-os somente quando você autorizar isso. Os demais são somente leitura.

## O que você pode fazer

Oito papéis, cada um disponível como skill, ferramenta MCP e comando de CLI. `<provider>` é `codex` ou `claude`; escolha o que não é o host em que você está.

| Papel       | Skill       | Ferramenta MCP     | CLI                                                 | Modo                                         |
| ----------- | ----------- | ------------------ | --------------------------------------------------- | -------------------------------------------- |
| `ask`       | `ask`       | `mate_ask`       | `jobs ask <provider> "<pergunta>"`                  | somente leitura                              |
| `review`    | `review`    | `mate_review`    | `jobs start <provider> "<prompt>" --role review`    | somente leitura                              |
| `research`  | `research`  | `mate_research`  | `jobs start <provider> "<prompt>" --role research`  | somente leitura (Claude ganha acesso web)    |
| `plan`      | `plan`      | `mate_plan`      | `jobs start <provider> "<prompt>" --role plan`      | somente leitura                              |
| `implement` | `implement` | `mate_implement` | `jobs start <provider> "<prompt>" --role implement` | escrita (sempre)                             |
| `teamlead`  | `teamlead`  | `mate_teamlead`  | `jobs start <provider> "<prompt>" --role teamlead`  | somente leitura por padrão, escrita opcional |
| `crossreview` | `crossreview` | `mate_crossreview` | `jobs start <provider> "<tarefa>" --role crossreview [--max-rounds N]` | escrita no implementador, revisão somente leitura |
| `split` | `split` | `mate_split` | `jobs start <provider> "<objetivo>" --role split [--max-parts N] [--mode write]` | somente leitura por padrão, escrita opcional (um git worktree por parte) |

`mate_ask` espera a resposta (até 120 segundos por padrão) e a devolve na mesma chamada. As outras ferramentas de papel retornam o ID do job imediatamente, a menos que você passe `waitSeconds`.

O Codex limita uma chamada de ferramenta MCP a cerca de 60 segundos por padrão. Ao executar dentro do Codex, passe `waitSeconds: 45` para `mate_ask` e continue com `mate_wait` se a resposta ainda não tiver chegado.

Outras quatro skills completam o conjunto:

- `jobs` lista, observa, coleta e cancela jobs.
- `delegate` é o caminho genérico (`mate_start`) para trabalho que não cabe em nenhum papel.
- `codex` e `claude` são atalhos que encaminham um pedido simples ao papel certo, já com o provider definido.

No Claude Code, o plugin também adiciona quatro agentes que usam o Codex: `codex-teammate` (perguntas e delegação geral), `codex-reviewer`, `codex-researcher` e `codex-teamlead`. Eles escrevem o briefing, verificam o que o Codex devolve e reportam a própria conclusão em vez de repassar a saída bruta.

Todo comando da tabela funciona sem MCP. Use o prefixo `npx -y agentmate` nos comandos de CLI.

## Comandos de barra

Nove comandos (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `crossreview`, `split` e `jobs`) podem ser iniciados como comando nos dois hosts. Os dois recebem primeiro o provider e depois o pedido.

| Host e estilo       | Como chamar                      | Como obter                                                            |
| ------------------- | -------------------------------- | --------------------------------------------------------------------- |
| Claude Code plugin  | `/mate:ask codex <pergunta>`   | Instalado com o plugin.                                               |
| Claude Code simples | `/ask codex <pergunta>`          | `npx -y agentmate install commands claude --global`           |
| Codex skill         | `$mate:ask claude <pergunta>`  | Instalado com o plugin; ou escolha "Mate: Ask" no menu `/skills`.   |
| Codex barra         | `/prompts:ask claude <pergunta>` | `npx -y agentmate install commands codex` e reinicie o Codex. |

As formas do plugin (`/mate:ask`, `$mate:ask`) não exigem instalação extra. As linhas `/ask` simples e `/prompts:ask` são extras opcionais. Por que dois passos: o Claude Code sempre prefixa as skills de plugin com o nome do plugin, então um `/ask` simples exige um arquivo de comando no nível do usuário. Plugins do Codex trazem skills, mas não comandos de barra; por isso `/prompts:<nome>` vem de um custom prompt em `$CODEX_HOME/prompts/` (padrão `~/.codex/prompts/`).

`npx -y agentmate install commands [claude|codex|both] [--global|--local]` copia os modelos do pacote (`templates/claude-commands/` e `templates/codex-prompts/`) e imprime os nomes dos comandos instalados. O alvo padrão é `both`. O comando pergunta antes de sobrescrever um arquivo existente. `--local` instala os comandos do Claude Code em `./.claude/commands/`; os custom prompts do Codex são somente no nível do usuário, então sempre são instalados globalmente.

> **Os custom prompts do Codex estão obsoletos (deprecated).** A OpenAI os marca como obsoletos em favor das skills. Eles ainda funcionam hoje, e a skill `$mate:ask` não exige instalação extra; use o que preferir. Reinicie o Codex depois de instalar os prompts.

Cada comando chama a mesma ferramenta `mate_*` da skill, usa o CLI `npx -y agentmate jobs ...` quando o MCP não está carregado e aponta para a skill para as regras completas. O `jobs` recebe um verbo em vez de um provider: `/jobs list`, `/jobs observe <id>`, `/jobs result <id>`, `/jobs cancel <id>`.

## Modo team lead

Um team lead é um job cujo worker planeja um objetivo amplo, delega partes ao outro provider pelo CLI, revisa os resultados e escreve um relatório. Você o inicia com `mate_teamlead` ou com a skill `teamlead` e o acompanha com `mate_observe`.

```text
sua sessão
  `-- job teamlead (profundidade 0, iniciado por você)   líder codex: danger-full-access
        |-- job research (claude)                         profundidade 1, não inicia jobs
        |-- job review (claude)                           profundidade 1, não inicia jobs
        `-- job implement (claude)                        profundidade 1, escrita, um por worktree
```

O `depth` gravado é 0 para um job iniciado por uma sessão e 1 para um job iniciado por um worker. O limite é de dois níveis: uma sessão inicia um team lead, o líder inicia jobs filhos, e os filhos não podem iniciar jobs.

O relatório final tem as seções Objective, Plan, Delegations (id, provider, role, status), Findings, Decisions, Deliverables e Open questions. `jobs observe <id>` mostra a saída do líder com seus filhos; `jobs list --parent <id>` lista apenas os filhos.

> **Aviso sobre o sandbox do Codex.** Um team lead no Codex roda com `--sandbox danger-full-access`, seja `mode` somente leitura ou escrita. Ele precisa iniciar processos worker e gravar o estado dos jobs em `~/.agentmate`, então o sandbox não pode ser mais restrito. No modo somente leitura, o runtime recusa qualquer job filho `write` e o prompt proíbe edições, mas o próprio líder não fica em sandbox. Trate-o como qualquer sessão do Codex com acesso total ao sistema de arquivos, ou lidere com o `claude`, cujas permissões são uma lista explícita de ferramentas, com negação explícita de `Edit`, `Write` e `NotebookEdit` no modo somente leitura.

O team lead chama o CLI fixado na versão instalada (`npx -y agentmate@<versão> jobs ...`); por isso, um checkout local não publicado no npm precisa ser publicado ou vinculado para o modo team lead funcionar.

Use team lead somente quando o trabalho tiver várias partes independentes. Uma pergunta ou uma revisão custa menos com `ask` ou `review`.

## Revisão cruzada

A revisão cruzada deixa um agente implementar e o outro revisar, sem você copiar um diff entre sessões. É um job de workflow: o worker não chama um CLI por conta própria, ele executa os passos como jobs filhos. O `provider` implementa; o outro agente revisa. Inicie com `mate_crossreview` ou com a skill `crossreview` (`/mate:crossreview codex <tarefa>`) e acompanhe com `mate_observe`.

```text
implement (provider, escrita)  ->  review (outro agente, somente leitura)  ->  veredito
        ^                                                                       |
        |              Verdict: request-changes, ainda há rodadas               |
        `---- implement --continue com os achados  <----------------------------'
                                                      |
                              Verdict: approve  ->  done
```

Cada rodada tem dois jobs filhos no mesmo diretório de trabalho (`depth` 1, `parentJob` = o id do workflow). O implementador roda em modo de escrita; a partir da rodada 2 ele continua a própria sessão com os achados do revisor. O revisor lê, somente leitura, o `git diff` não commitado (e `git status` para arquivos novos), com o relatório do implementador como contexto, e deve terminar a revisão com a linha `Verdict: approve` ou `Verdict: request-changes`.

Regras de parada:

- `Verdict: approve` encerra o workflow como `done`.
- `Verdict: request-changes` abre outra rodada enquanto houver rodadas (`maxRounds`, de 1 a 5, padrão 2). Esgotado o limite, o workflow termina como `done` e o relatório avisa; as últimas edições ficam na árvore de trabalho.
- Sem veredito claro, o workflow encerra na hora como `done` com uma seção `## Needs human`; ele nunca itera às cegas.
- Um filho que termina em `error`, `timeout` ou `canceled` encerra o workflow como `error`, com o id e o erro desse filho. O `--timeout` do próprio workflow é o prazo total, e `jobs cancel <id>` no workflow também cancela o filho em execução.

O relatório (`jobs result <id>`) tem `## Task`, `## Rounds` (rodada, job de implementação, job de revisão, veredito), `## Final review`, `## Changes`, `## Needs human` quando se aplica e `## Next steps` com os comandos `jobs result <id-do-filho>`. `jobs events <id>` lista um evento `important` por passo, como `round 1: review verdict approve`.

```bash
npx -y agentmate jobs start codex "Adicione a flag --dry-run ao comando export" --role crossreview --max-rounds 3
```

Ele edita arquivos; inicie-o somente quando você autorizar isso e mantenha um job de escrita por worktree. Somente uma sessão de nível superior pode iniciá-lo, como o team lead. `--model` vale só para o implementador.

## Divisão de tarefas

A divisão de tarefas parte um objetivo amplo em partes independentes, executa as partes em paralelo nos dois agentes e faz o outro agente revisar cada uma, sem você repassar resultados entre sessões. Como a revisão cruzada, é um job de workflow: o worker não chama um CLI por conta própria, ele executa os passos como jobs filhos (`depth` 1, `parentJob` = o id do workflow) que compartilham uma [sessão](#sessões). O `provider` planeja; cada parte vai para o `codex` ou para o `claude`. Inicie com `mate_split` ou com a skill `split` (`/mate:split codex <objetivo>`) e acompanhe com `mate_observe`.

```text
objetivo -> plano (provider, somente leitura)
              |  1..maxParts partes: interfaces fechadas, sem arquivos em comum, um agente cada
              v
            partes em paralelo ---- somente leitura: um job research por parte, no diretório de trabalho
              |                     escrita:         um git worktree + branch por parte, um job implement em cada
              v
            revisão cruzada (o outro agente de cada parte, somente leitura, Verdict: approve | request-changes)
              |
              v
            relatório de integração (tabela de partes, ordem de merge, o que precisa de uma pessoa)
```

1. **Plano.** Um job `plan` no `provider` devolve um bloco `json` delimitado, `{ "parts": [{ "id", "title", "briefing", "files", "agent" }] }`, com 1 a `maxParts` partes (de 2 a 4, padrão 3). O worker usa o último bloco assim e o valida: ids únicos (`a-z`, `0-9`, `-`) e agentes conhecidos (agente ausente ou desconhecido alterna, começando pelo outro agente). Se o bloco for inválido, o workflow termina em `error` apontando para `jobs result <job-do-plano>`. O plano vai para as notas da sessão, então toda parte o enxerga.
2. **Partes, em paralelo.** Somente leitura (padrão): um job `research` por parte, no agente da parte, no diretório de trabalho. Escrita (`--mode write`, exige um repositório git com ao menos um commit): para cada parte o worker executa `git worktree add -b agentmate/<id-do-split>/<id-da-parte> ~/.agentmate/worktrees/<id-do-split>/<id-da-parte> HEAD` e um job `implement` trabalha nesse worktree, então sua árvore de trabalho não é tocada. Quando o implementador termina, o AgentMate faz o commit do que ele deixou na branch da parte.
3. **Revisão cruzada.** Cada parte concluída é revisada, somente leitura, pelo outro agente: em modo de escrita no worktree da parte, contra o commit de onde a branch partiu (`git diff <commit-base>`); em somente leitura, sobre o resultado da pesquisa. A revisão termina com `Verdict: approve` ou `Verdict: request-changes`.
4. **Relatório.** `jobs result <id>` tem `## Goal`, `## Parts` (parte, título, agente, job da parte, job de revisão, veredito, branch), `## Integration`, `## Needs human` quando se aplica e `## Next steps` com os comandos `jobs result <id-do-filho>`. Em modo de escrita, `## Integration` lista os comandos `git merge agentmate/<id-do-split>/<id-da-parte>` em ordem e a limpeza com `git worktree remove <caminho>`; em somente leitura, reúne os resultados das pesquisas. `jobs events <id>` lista um evento `important` por passo.

Uma parte que falha não interrompe as outras: elas rodam até o fim (e são revisadas), e então o workflow termina em `error` citando a parte que falhou. `request-changes` ou ausência de veredito vão para `## Needs human`. O `--timeout` do próprio workflow é o prazo total, e `jobs cancel <id>` nele também cancela os filhos em execução.

O que **não** é automático: o AgentMate nunca faz merge, push, rebase nem apaga branches por você, e conflitos de merge entre partes não são resolvidos automaticamente. Execute os merges do relatório você mesmo, resolva os conflitos, rode os testes e depois remova os worktrees. Não há segunda rodada: uma parte com `request-changes` fica para você (ou para um job de acompanhamento) corrigir.

```bash
npx -y agentmate jobs start codex "Adicione exportação CSV e JSON ao comando report" --role split --max-parts 3
npx -y agentmate jobs start codex "Adicione exportação CSV e JSON ao comando report" --role split --mode write
```

O modo de escrita edita arquivos (nos worktrees); inicie-o somente quando você autorizar isso. Somente uma sessão de nível superior pode iniciá-lo, como o team lead. `--model` vale para o planejador e para as partes executadas pelo mesmo agente.

## Como funciona

O AgentMate trata o trabalho delegado como um job durável em segundo plano:

1. Inicie uma tarefa no `codex` ou no `claude`; a ferramenta retorna um ID imediatamente (ou a resposta, no caso de `mate_ask`).
2. Aguarde o mesmo ID, colete o resultado ou peça progresso quando a pessoa solicitar.
3. Jobs continuam em execução mesmo quando a sessão que os iniciou termina.

![Uma tarefa passa pela fila, worker e resultado.](../assets/illustrations/background-jobs.png)

O servidor MCP de jobs (`npx -y agentmate serve jobs`, registrado pelo plugin) e o CLI `jobs` compartilham o mesmo runtime. O estado fica em `~/.agentmate`. Um worker desacoplado executa o CLI do provider e grava a saída, então uma espera expirada nunca interrompe um job.

Cada job também grava um log de eventos append-only (`events.jsonl`). Os eventos têm um de três níveis: `important` (mensagens do agente, erros, início e fim), `status` (arquivos alterados) e `fyi` (comandos executados). `mate_observe` e `jobs observe` mostram apenas eventos `important` e `status`, então verificar o progresso custa pouco contexto; peça `fyi` com `levels` / `--level`, leia o log completo com `mate_events` / `jobs events <id>` e traga os trechos brutos de stdout/stderr só quando necessário com `raw` / `--raw`. Veja [docs/ARCHITECTURE.md](./ARCHITECTURE.md) (em inglês) para o runtime, os adapters e o modelo de eventos.

| Capacidade               | MCP                                                                                                                    | CLI                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Iniciar trabalho         | `mate_start`, `mate_ask`, `mate_review`, `mate_research`, `mate_plan`, `mate_implement`, `mate_teamlead`, `mate_crossreview`, `mate_split` | `jobs start`, `jobs ask`             |
| Esperar ou obter a saída | `mate_wait`, `mate_result`                                                                                         | `jobs wait <id>`, `jobs result <id>` |
| Pedir progresso          | `mate_observe`                                                                                                       | `jobs observe <id> [--raw]`          |
| Ler eventos do job       | `mate_events`                                                                                                        | `jobs events <id> [--follow]`        |
| Cancelar trabalho        | `mate_cancel`                                                                                                        | `jobs cancel <id>`                   |
| Encontrar jobs           | `mate_list`                                                                                                          | `jobs list [--cwd] [--parent <id>]`  |
| Sessões                  | `mate_session_start`, `mate_session_show`, `mate_session_notes`, `mate_session_list`                                 | `sessions start/show/notes/list`, `jobs start --session <id>` |

### Sessões

Uma sessão é contexto compartilhado entre jobs e agentes. `mate_session_start(title, cwd?)` cria uma em `~/.agentmate/sessions/<id>/` (`session.json` mais `notes.md`); passe o id como `session` a qualquer ferramenta de papel ou ao `mate_start` (CLI: `jobs start ... --session <id>`) e o job fica registrado nela. `mate_session_notes(id, text, author?)` acrescenta uma nota, `mate_session_show(id)` mostra o final das notas e os jobs da sessão, e `mate_session_list(cwd?, limit?)` lista as sessões. Quando a sessão tem notas, todo worker iniciado nela recebe os últimos 4000 caracteres antes do briefing, sob `## Shared session notes`, qualquer que seja o papel; por isso mantenha as notas curtas e factuais: decisões, restrições, locais de arquivos. Os jobs que um workflow inicia (`crossreview`, `split`) herdam a sessão do workflow, e o `split` cria uma sessão própria quando você não passa nenhuma e grava o plano nas notas. As notas são texto simples em `~/.agentmate`; não coloque segredos nelas.

As skills preferem as ferramentas `mate_*`. Se o host não carregou o MCP, elas executam o mesmo contrato de jobs por `npx -y agentmate`; nunca alteram a configuração do host como fallback.

O modo padrão é `read-only`, exceto em `implement`, que sempre roda em modo de escrita. Use `write` apenas em tarefas que autorizem explicitamente alterações.

## Exemplos de uso

### Fazer uma pergunta rápida

```bash
npx -y agentmate jobs ask codex "Por que src/jobs/store.ts poderia perder uma escrita com workers concorrentes?" --wait 120s
```

A resposta é impressa quando chega. Se a espera expirar, o job continua: `jobs wait <id>` o coleta.

### Revisar uma alteração

Comece com uma solicitação somente de leitura. Dê ao outro CLI o objetivo, os arquivos ou diff relevantes e o formato esperado da resposta.

```bash
npx -y agentmate jobs start codex "Revise o diff atual e reporte apenas achados acionáveis." --role review
# guarde o ID impresso pelo comando
npx -y agentmate jobs wait <job-id>
```

Depois de reiniciar o plugin, você também pode pedir a mesma tarefa pela skill `review` ou pela skill `delegate`. Elas escolhem MCP quando está disponível e usam o CLI como fallback.

### Delegar uma edição autorizada

O modo padrão é `read-only`, exceto em `implement`, que sempre roda em modo de escrita e rejeita `read-only`. Use-o somente quando a tarefa puder alterar arquivos. Mantenha apenas um job de escrita por worktree. A flag `--mode write` é redundante em `implement`, mas deixa a intenção explícita.

```bash
npx -y agentmate jobs start claude "Adicione um teste de regressão focado para o parser." --role implement --mode write --cwd .
npx -y agentmate jobs wait <job-id>
```

### Executar um team lead

```bash
npx -y agentmate jobs start claude "Audite o CLI em busca de tratamento de erros inconsistente e proponha correções. Delegue áreas independentes ao codex." --role teamlead
npx -y agentmate jobs observe <job-id>
npx -y agentmate jobs wait <job-id> --timeout 10m
```

### Revisar em cruz uma alteração

```bash
npx -y agentmate jobs start codex "Adicione a flag --dry-run ao comando export" --role crossreview --max-rounds 3
npx -y agentmate jobs wait <job-id> --timeout 10m
npx -y agentmate jobs result <job-id>
```

O Codex implementa, o Claude revisa o diff não commitado e o relatório lista as rodadas. Use `jobs events <job-id>` para o log passo a passo.

### Dividir um objetivo entre os dois agentes

```bash
sid=$(npx -y agentmate sessions start "Exportação CSV e JSON")
npx -y agentmate sessions notes "$sid" "Mantenha as flags da CLI estáveis; os formatadores ficam em src/export/."
npx -y agentmate jobs start codex "Adicione exportação CSV e JSON ao comando report" --role split --session "$sid"
npx -y agentmate jobs wait <job-id> --timeout 10m
npx -y agentmate jobs result <job-id>
npx -y agentmate sessions show "$sid"
```

O Codex planeja as partes, os dois agentes as pesquisam em paralelo e o relatório reúne os achados. Acrescente `--mode write` para implementar cada parte no próprio worktree e branch.

### Continuar, observar ou cancelar

Uma espera expirada não interrompe o job. Repita `wait` para o mesmo ID, consulte o progresso quando solicitado ou obtenha o resultado salvo depois de uma sessão de terminal interrompida.

```bash
npx -y agentmate jobs observe <job-id>
npx -y agentmate jobs result <job-id>
npx -y agentmate jobs cancel <job-id>
```

Um job finalizado com sessão salva pode continuar no mesmo provider:

```bash
npx -y agentmate jobs start codex "Resolva o achado de maior prioridade." --continue <job-id>
```

| Código de saída de `wait` | Significado                             | Próxima ação                                      |
| ------------------------- | --------------------------------------- | ------------------------------------------------- |
| `0`                       | Job concluído                           | Leia e avalie o resultado retornado.              |
| `1`                       | Job falhou ou foi cancelado             | Use `result` para obter a saída e o erro retidos. |
| `2`                       | A espera expirou e o job continua ativo | Repita `wait`; não crie um job duplicado.         |

`jobs ask` usa os mesmos códigos de saída. Não encadeie `wait` ou `ask` em um pipe: o pipe descarta o código de saída.

`jobs wait --timeout` (por exemplo `10m` ou `90s`) limita apenas quanto tempo o comando espera. Para limitar quanto tempo um job pode rodar, use `jobs start --timeout <minutos>`: um número positivo de minutos, no máximo 120.

## Modelo de segurança

- **Somente leitura por padrão.** `ask`, `review`, `plan` e `research` sempre rodam em modo somente leitura, e `teamlead` é somente leitura, a menos que você passe `mode: write`. `implement` sempre roda em modo de escrita: `--role implement` e `mate_implement` usam escrita por padrão e rejeitam `read-only`. Use-o somente depois que a pessoa autorizar edições.
- **Permissões por papel.** O sandbox ou a lista de ferramentas acompanha o papel e o modo:

  | Papel e modo                                                  | Sandbox do Codex     | Permissões do Claude                                                                         |
  | ------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
  | somente leitura (`ask`, `review`, `plan`, `teamlead` leitura) | `read-only`          | lista (abaixo) e negação explícita de `Edit`, `Write` e `NotebookEdit`                       |
  | `research`                                                    | `read-only`          | a lista de somente leitura mais `WebSearch` e `WebFetch`, com a mesma negação explícita      |
  | `implement`, `teamlead` em escrita                            | `workspace-write`    | modo de permissão `acceptEdits` mais a lista de verificação (abaixo)                         |
  | `teamlead` (líder Codex, leitura ou escrita)                  | `danger-full-access` | não se aplica                                                                                |
  | `teamlead` (líder Claude)                                     | não se aplica        | as linhas acima, mais acesso ao CLI limitado a `agentmate jobs *` (versão instalada) |

  A lista de somente leitura é `Read`, `Grep`, `Glob`, `git diff`, `git log`, `git show` e `git status`. A lista do modo de escrita acrescenta `pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add` e `git commit`, para que o worker rode comandos de verificação. Amplie-a com a variável de ambiente `AGENTMATE_CLAUDE_WRITE_TOOLS`, uma lista separada por vírgulas de padrões de permissão do Claude. Um team lead no Claude não pode executar `install`, apenas `agentmate jobs *`.

- **Um team lead no Codex não fica em sandbox.** Ele roda com `--sandbox danger-full-access` nos dois modos, porque precisa iniciar processos worker e gravar o estado dos jobs. "Somente leitura" para um líder Codex significa que o runtime recusa qualquer job filho `write` (um pai somente leitura não pode iniciar filhos de escrita) e que o prompt proíbe edições; isso não restringe o processo do próprio líder. Lidere com o `claude` quando isso importar.
- **Limite de profundidade de delegação igual a 2.** Uma sessão inicia um team lead (profundidade 0), o líder inicia jobs filhos (profundidade 1), e os filhos não podem iniciar jobs. O runtime recusa um terceiro nível e recusa um team lead, uma revisão cruzada ou um split iniciados por um worker.
- **A revisão cruzada só escreve pelo implementador.** O passo `implement` recebe as permissões de `implement` acima; o passo `review` é somente leitura. O job de workflow em si não chama nenhum CLI.
- **O split só escreve dentro dos próprios worktrees.** Em modo de escrita, o job `implement` de cada parte roda no próprio git worktree, na própria branch (`agentmate/<id-do-split>/<id-da-parte>`); o planejador e os revisores são somente leitura, e nada é integrado à sua branch por você.
- **Um job `write` por worktree por vez.** Dois escritores na mesma árvore colidem. As skills e o prompt do team lead seguem essa regra; use git worktrees separados para edições em paralelo (o `split` faz isso para as suas partes).
- **Quem delegou é quem aceita.** A saída do job é um insumo para o seu julgamento. Verifique as afirmações e rode os testes antes de integrar qualquer coisa produzida por um worker.
- **Sem alterações ocultas de configuração.** O plugin registra o próprio servidor MCP. O fallback executa o CLI e nunca edita a configuração do host. Não coloque segredos em briefings: prompts e resultados ficam em texto simples em `~/.agentmate`, em arquivos criados com permissões exclusivas do dono (`0600` para arquivos e `0700` para diretórios).

## Solução de problemas

Comece por `npx -y agentmate doctor`. Ele imprime `ok`, `warn` ou `fail` para cada verificação, com uma dica, e sai com código `1` se alguma verificação falhar. Funciona sem `codex` ou `claude` instalados e reporta o CLI ausente como aviso. Ele confere se cada CLI responde a `--version`, não se você está autenticado.

| Sintoma                                             | Causa provável e correção                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Ferramentas `mate_*` ou skills não aparecem         | Reinicie o host após instalar; confira `claude plugin list` ou `codex plugin list`.                                               |
| Um job falha imediatamente                          | O CLI de destino não está no `PATH` (o `doctor` reporta) ou não está autenticado (o `doctor` não verifica; faça login nele).      |
| `wait` ou `ask` termina com código `2`              | O job continua ativo. Repita `jobs wait <id>`; não inicie um job duplicado.                                                       |
| Um job aparece como `running` mas nada acontece     | O processo worker morreu. O `doctor` lista os IDs desses jobs; `jobs cancel <id>` os encerra.                                     |
| `Delegation depth limit reached`                    | Um job iniciado por um worker tentou iniciar outro job (um terceiro nível). Devolva os achados à sessão que iniciou o job.        |
| `Only a top-level session can start a teamlead job` | Um worker tentou iniciar um team lead (ou uma revisão cruzada ou um split: `... a crossreview job`, `... a split job`). Inicie-o a partir da sua própria sessão. |
| Ferramentas duplicadas ou conflitantes              | Um registro legado (`serve codex` / `serve claude`) ainda existe. O `doctor` aponta; veja "Removido na 0.6.0".                    |

## Requisitos

- Node.js 18 ou superior
- Claude Code e/ou Codex CLI, autenticado
- O CLI de destino disponível no `PATH` do host que inicia o job

## Removido na 0.6.0

Os servidores síncronos descontinuados (`serve codex`, `serve claude`), o comando `setup`, os binários `agentmate-codex` / `agentmate-claude` e a skill legada `setup` foram removidos; o plugin e as ferramentas de job `mate_*` os substituem.
Para remover um registro que sobrou, rode `claude mcp remove codex -s user` no Claude Code ou apague a seção `[mcp_servers.claude]` de `~/.codex/config.toml` no Codex.
`npx -y agentmate doctor` aponta os dois casos. Veja o [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md#removido-na-060-instalações-legadas-de-setup).

## Desenvolvimento

```bash
git clone https://github.com/naldomadeira/agentmate.git
cd agentmate
pnpm install
pnpm build
pnpm test
pnpm lint
```

Notas de versão estão no [changelog](../CHANGELOG.md).

## Licença

[MIT](../LICENSE)
