# AgentMate

[English](../README.md)

**Agentes de IA trabalham melhor juntos.**

O AgentMate conecta agentes de IA de programação para que colaborem, deleguem, revisem e ajudem uns aos outros a concluir tarefas. Dê um parceiro ao seu agente: faça o [Claude Code](https://code.claude.com/) e o [Codex CLI](https://developers.openai.com/codex/cli/) perguntarem, revisarem, pesquisarem, planejarem, implementarem e liderarem trabalho um para o outro como jobs em segundo plano.

![Dois ambientes de desenvolvimento conectados por uma ponte segura.](../assets/illustrations/cli-bridge.png)

## Por que usar o AgentMate

- **Uma segunda opinião de outro modelo.** Pergunte algo ao outro CLI ou peça que ele revise seu diff antes de se comprometer com uma abordagem. Ele lê o repositório; não herda as suposições da sua sessão.
- **Trabalho que não bloqueia você.** Cada tarefa é um job durável em segundo plano, com um ID. A sessão que o iniciou pode terminar e o resultado continua disponível.
- **Papéis em vez de prompts soltos.** `ask`, `review`, `research`, `plan`, `implement` e `teamlead` enviam um prompt ajustado, com formato de saída definido, e rodam com as menores permissões que o papel exige. Jobs são somente leitura, a menos que você diga o contrário.

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

O `doctor` confere o Node.js, se os CLIs `codex` e `claude` estão no `PATH` e respondem a `--version`, o diretório de estado dos jobs, jobs `running` obsoletos (ele lista os IDs) e registros legados, e mostra a correção de cada problema. Ele não verifica a autenticação: se um job falhar logo ao iniciar, faça login você mesmo no CLI de destino. Consulte o [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md) para atualizar, testar localmente e migrar instalações legadas de `setup`.

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
| Operar jobs                  | `/mate:jobs list`, `/mate:jobs result <id>`, `/mate:jobs cancel <id>`                   |

O `implement` edita arquivos; use-o somente quando você autorizar isso. Os demais são somente leitura.

## O que você pode fazer

Seis papéis, cada um disponível como skill, ferramenta MCP e comando de CLI. `<provider>` é `codex` ou `claude`; escolha o que não é o host em que você está.

| Papel       | Skill       | Ferramenta MCP     | CLI                                                 | Modo                                         |
| ----------- | ----------- | ------------------ | --------------------------------------------------- | -------------------------------------------- |
| `ask`       | `ask`       | `mate_ask`       | `jobs ask <provider> "<pergunta>"`                  | somente leitura                              |
| `review`    | `review`    | `mate_review`    | `jobs start <provider> "<prompt>" --role review`    | somente leitura                              |
| `research`  | `research`  | `mate_research`  | `jobs start <provider> "<prompt>" --role research`  | somente leitura (Claude ganha acesso web)    |
| `plan`      | `plan`      | `mate_plan`      | `jobs start <provider> "<prompt>" --role plan`      | somente leitura                              |
| `implement` | `implement` | `mate_implement` | `jobs start <provider> "<prompt>" --role implement` | escrita (sempre)                             |
| `teamlead`  | `teamlead`  | `mate_teamlead`  | `jobs start <provider> "<prompt>" --role teamlead`  | somente leitura por padrão, escrita opcional |

`mate_ask` espera a resposta (até 120 segundos por padrão) e a devolve na mesma chamada. As outras ferramentas de papel retornam o ID do job imediatamente, a menos que você passe `waitSeconds`.

O Codex limita uma chamada de ferramenta MCP a cerca de 60 segundos por padrão. Ao executar dentro do Codex, passe `waitSeconds: 45` para `mate_ask` e continue com `mate_wait` se a resposta ainda não tiver chegado.

Outras quatro skills completam o conjunto:

- `jobs` lista, observa, coleta e cancela jobs.
- `delegate` é o caminho genérico (`mate_start`) para trabalho que não cabe em nenhum papel.
- `codex` e `claude` são atalhos que encaminham um pedido simples ao papel certo, já com o provider definido.

No Claude Code, o plugin também adiciona quatro agentes que usam o Codex: `codex-teammate` (perguntas e delegação geral), `codex-reviewer`, `codex-researcher` e `codex-teamlead`. Eles escrevem o briefing, verificam o que o Codex devolve e reportam a própria conclusão em vez de repassar a saída bruta.

Todo comando da tabela funciona sem MCP. Use o prefixo `npx -y agentmate` nos comandos de CLI.

## Comandos de barra

Sete papéis (`ask`, `review`, `research`, `plan`, `implement`, `teamlead` e `jobs`) podem ser iniciados como comando nos dois hosts. Os dois recebem primeiro o provider e depois o pedido.

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

## Como funciona

O AgentMate trata o trabalho delegado como um job durável em segundo plano:

1. Inicie uma tarefa no `codex` ou no `claude`; a ferramenta retorna um ID imediatamente (ou a resposta, no caso de `mate_ask`).
2. Aguarde o mesmo ID, colete o resultado ou peça progresso quando a pessoa solicitar.
3. Jobs continuam em execução mesmo quando a sessão que os iniciou termina.

![Uma tarefa passa pela fila, worker e resultado.](../assets/illustrations/background-jobs.png)

O servidor MCP de jobs (`npx -y agentmate serve jobs`, registrado pelo plugin) e o CLI `jobs` compartilham o mesmo runtime. O estado fica em `~/.agentmate`. Um worker desacoplado executa o CLI do provider e grava a saída, então uma espera expirada nunca interrompe um job.

| Capacidade               | MCP                                                                                                                    | CLI                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Iniciar trabalho         | `mate_start`, `mate_ask`, `mate_review`, `mate_research`, `mate_plan`, `mate_implement`, `mate_teamlead` | `jobs start`, `jobs ask`             |
| Esperar ou obter a saída | `mate_wait`, `mate_result`                                                                                         | `jobs wait <id>`, `jobs result <id>` |
| Pedir progresso          | `mate_observe`                                                                                                       | `jobs observe <id>`                  |
| Cancelar trabalho        | `mate_cancel`                                                                                                        | `jobs cancel <id>`                   |
| Encontrar jobs           | `mate_list`                                                                                                          | `jobs list [--cwd] [--parent <id>]`  |

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

  A lista de somente leitura é `Read`, `Grep`, `Glob`, `git diff`, `git log`, `git show` e `git status`. A lista do modo de escrita acrescenta `pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add` e `git commit`, para que o worker rode comandos de verificação. Amplie-a com a variável de ambiente `AGENTMATE_CLAUDE_WRITE_TOOLS`, uma lista separada por vírgulas de padrões de permissão do Claude. Um team lead no Claude não pode executar `setup` nem `install`, apenas `agentmate jobs *`.

- **Um team lead no Codex não fica em sandbox.** Ele roda com `--sandbox danger-full-access` nos dois modos, porque precisa iniciar processos worker e gravar o estado dos jobs. "Somente leitura" para um líder Codex significa que o runtime recusa qualquer job filho `write` (um pai somente leitura não pode iniciar filhos de escrita) e que o prompt proíbe edições; isso não restringe o processo do próprio líder. Lidere com o `claude` quando isso importar.
- **Limite de profundidade de delegação igual a 2.** Uma sessão inicia um team lead (profundidade 0), o líder inicia jobs filhos (profundidade 1), e os filhos não podem iniciar jobs. O runtime recusa um terceiro nível e recusa um team lead iniciado por um worker.
- **Um job `write` por worktree por vez.** Dois escritores na mesma árvore colidem. As skills e o prompt do team lead seguem essa regra; use git worktrees separados para edições em paralelo.
- **Quem delegou é quem aceita.** A saída do job é um insumo para o seu julgamento. Verifique as afirmações e rode os testes antes de integrar qualquer coisa produzida por um worker.
- **Sem alterações ocultas de configuração.** O plugin registra o próprio servidor MCP. O fallback executa o CLI e nunca edita a configuração do host. Não coloque segredos em briefings: prompts e resultados ficam em texto simples em `~/.agentmate`, em arquivos criados com permissões exclusivas do dono (`0600` para arquivos e `0700` para diretórios).

## Solução de problemas

Comece por `npx -y agentmate doctor`. Ele imprime `ok`, `warn` ou `fail` para cada verificação, com uma dica, e sai com código `1` se alguma verificação falhar. Funciona sem `codex` ou `claude` instalados e reporta o CLI ausente como aviso. Ele confere se cada CLI responde a `--version`, não se você está autenticado.

| Sintoma                                             | Causa provável e correção                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Ferramentas `mate_*` ou skills não aparecem       | Reinicie o host após instalar; confira `claude plugin list` ou `codex plugin list`.                                          |
| Um job falha imediatamente                          | O CLI de destino não está no `PATH` (o `doctor` reporta) ou não está autenticado (o `doctor` não verifica; faça login nele). |
| `wait` ou `ask` termina com código `2`              | O job continua ativo. Repita `jobs wait <id>`; não inicie um job duplicado.                                                  |
| Um job aparece como `running` mas nada acontece     | O processo worker morreu. O `doctor` lista os IDs desses jobs; `jobs cancel <id>` os encerra.                                |
| `Delegation depth limit reached`                    | Um job iniciado por um worker tentou iniciar outro job (um terceiro nível). Devolva os achados à sessão que iniciou o job.   |
| `Only a top-level session can start a teamlead job` | Um worker tentou iniciar um team lead. Inicie-o a partir da sua própria sessão.                                              |
| Ferramentas duplicadas ou conflitantes              | Uma instalação legada de `setup` ainda está registrada. O `doctor` aponta; veja a seção de migração.                         |

## Requisitos

- Node.js 18 ou superior
- Claude Code e/ou Codex CLI, autenticado
- O CLI de destino disponível no `PATH` do host que inicia o job

## Configuração legada

`npx -y agentmate setup` continua disponível para instalações existentes que usam os servidores síncronos da ponte ou os atalhos legados `/codex` e `/claude`. Novas instalações devem usar o plugin. O [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md#migrar-instalações-antigas-de-setup) explica como remover apenas as entradas legadas que pertencem ao AgentMate.

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
