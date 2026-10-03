# Agents Bridge

[English](../README.md)

Faça o [Claude Code](https://code.claude.com/) e o [Codex CLI](https://developers.openai.com/codex/cli/) perguntarem, revisarem, pesquisarem, planejarem, implementarem e liderarem trabalho um para o outro como jobs em segundo plano.

![Dois ambientes de desenvolvimento conectados por uma ponte segura.](../assets/illustrations/cli-bridge.png)

## Por que usar o Agents Bridge

- **Uma segunda opinião de outro modelo.** Pergunte algo ao outro CLI ou peça que ele revise seu diff antes de se comprometer com uma abordagem. Ele lê o repositório; não herda as suposições da sua sessão.
- **Trabalho que não bloqueia você.** Cada tarefa é um job durável em segundo plano, com um ID. A sessão que o iniciou pode terminar e o resultado continua disponível.
- **Papéis em vez de prompts soltos.** `ask`, `review`, `research`, `plan`, `implement` e `teamlead` enviam um prompt ajustado, com formato de saída definido, e rodam com as menores permissões que o papel exige. Jobs são somente leitura, a menos que você diga o contrário.

## Início rápido em 60 segundos

Instale o plugin no host que você usa (ou nos dois) e reinicie o host.

```bash
# Claude Code
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge

# Codex
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Pergunte algo ao outro modelo. No Claude Code, as skills de plugin têm namespace; no Codex você cita a skill com `$` ou a escolhe no menu de skills:

```text
/agents-bridge:ask codex É seguro rodar esta migração duas vezes? Veja db/migrate/0042.sql
$ask claude Este loop de retry em src/queue.ts tem uma condição de corrida?
```

Verifique a instalação:

```bash
npx -y agents-bridge-mcp doctor
```

O `doctor` confere o Node.js, se os CLIs `codex` e `claude` estão no `PATH` e respondem a `--version`, o diretório de estado dos jobs, jobs `running` obsoletos (ele lista os IDs) e registros legados, e mostra a correção de cada problema. Ele não verifica a autenticação: se um job falhar logo ao iniciar, faça login você mesmo no CLI de destino. Consulte o [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md) para atualizar, testar localmente e migrar instalações legadas de `setup`.

## O que você pode fazer

Seis papéis, cada um disponível como skill, ferramenta MCP e comando de CLI. `<provider>` é `codex` ou `claude`; escolha o que não é o host em que você está.

| Papel       | Skill       | Ferramenta MCP     | CLI                                                 | Modo                                         |
| ----------- | ----------- | ------------------ | --------------------------------------------------- | -------------------------------------------- |
| `ask`       | `ask`       | `bridge_ask`       | `jobs ask <provider> "<pergunta>"`                  | somente leitura                              |
| `review`    | `review`    | `bridge_review`    | `jobs start <provider> "<prompt>" --role review`    | somente leitura                              |
| `research`  | `research`  | `bridge_research`  | `jobs start <provider> "<prompt>" --role research`  | somente leitura (Claude ganha acesso web)    |
| `plan`      | `plan`      | `bridge_plan`      | `jobs start <provider> "<prompt>" --role plan`      | somente leitura                              |
| `implement` | `implement` | `bridge_implement` | `jobs start <provider> "<prompt>" --role implement` | escrita (sempre)                             |
| `teamlead`  | `teamlead`  | `bridge_teamlead`  | `jobs start <provider> "<prompt>" --role teamlead`  | somente leitura por padrão, escrita opcional |

`bridge_ask` espera a resposta (até 120 segundos por padrão) e a devolve na mesma chamada. As outras ferramentas de papel retornam o ID do job imediatamente, a menos que você passe `waitSeconds`.

O Codex limita uma chamada de ferramenta MCP a cerca de 60 segundos por padrão. Ao executar dentro do Codex, passe `waitSeconds: 45` para `bridge_ask` e continue com `bridge_wait` se a resposta ainda não tiver chegado.

Outras quatro skills completam o conjunto:

- `jobs` lista, observa, coleta e cancela jobs.
- `delegate` é o caminho genérico (`bridge_start`) para trabalho que não cabe em nenhum papel.
- `codex` e `claude` são atalhos que encaminham um pedido simples ao papel certo, já com o provider definido.

No Claude Code, o plugin também adiciona quatro agentes que usam o Codex: `codex-teammate` (perguntas e delegação geral), `codex-reviewer`, `codex-researcher` e `codex-teamlead`. Eles escrevem o briefing, verificam o que o Codex devolve e reportam a própria conclusão em vez de repassar a saída bruta.

Todo comando da tabela funciona sem MCP. Use o prefixo `npx -y agents-bridge-mcp` nos comandos de CLI.

## Modo team lead

Um team lead é um job cujo worker planeja um objetivo amplo, delega partes ao outro provider pelo CLI, revisa os resultados e escreve um relatório. Você o inicia com `bridge_teamlead` ou com a skill `teamlead` e o acompanha com `bridge_observe`.

```text
sua sessão
  `-- job teamlead (profundidade 0, iniciado por você)   líder codex: danger-full-access
        |-- job research (claude)                         profundidade 1, não inicia jobs
        |-- job review (claude)                           profundidade 1, não inicia jobs
        `-- job implement (claude)                        profundidade 1, escrita, um por worktree
```

O `depth` gravado é 0 para um job iniciado por uma sessão e 1 para um job iniciado por um worker. O limite é de dois níveis: uma sessão inicia um team lead, o líder inicia jobs filhos, e os filhos não podem iniciar jobs.

O relatório final tem as seções Objective, Plan, Delegations (id, provider, role, status), Findings, Decisions, Deliverables e Open questions. `jobs observe <id>` mostra a saída do líder com seus filhos; `jobs list --parent <id>` lista apenas os filhos.

> **Aviso sobre o sandbox do Codex.** Um team lead no Codex roda com `--sandbox danger-full-access`, seja `mode` somente leitura ou escrita. Ele precisa iniciar processos worker e gravar o estado dos jobs em `~/.agents-bridge`, então o sandbox não pode ser mais restrito. No modo somente leitura, o runtime recusa qualquer job filho `write` e o prompt proíbe edições, mas o próprio líder não fica em sandbox. Trate-o como qualquer sessão do Codex com acesso total ao sistema de arquivos, ou lidere com o `claude`, cujas permissões são uma lista explícita de ferramentas, com negação explícita de `Edit`, `Write` e `NotebookEdit` no modo somente leitura.

O team lead chama o CLI fixado na versão instalada (`npx -y agents-bridge-mcp@<versão> jobs ...`); por isso, um checkout local não publicado no npm precisa ser publicado ou vinculado para o modo team lead funcionar.

Use team lead somente quando o trabalho tiver várias partes independentes. Uma pergunta ou uma revisão custa menos com `ask` ou `review`.

## Como funciona

O Agents Bridge trata o trabalho delegado como um job durável em segundo plano:

1. Inicie uma tarefa no `codex` ou no `claude`; a ferramenta retorna um ID imediatamente (ou a resposta, no caso de `bridge_ask`).
2. Aguarde o mesmo ID, colete o resultado ou peça progresso quando a pessoa solicitar.
3. Jobs continuam em execução mesmo quando a sessão que os iniciou termina.

![Uma tarefa passa pela fila, worker e resultado.](../assets/illustrations/background-jobs.png)

O servidor MCP de jobs (`npx -y agents-bridge-mcp serve jobs`, registrado pelo plugin) e o CLI `jobs` compartilham o mesmo runtime. O estado fica em `~/.agents-bridge`. Um worker desacoplado executa o CLI do provider e grava a saída, então uma espera expirada nunca interrompe um job.

| Capacidade               | MCP                                                                                                                    | CLI                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Iniciar trabalho         | `bridge_start`, `bridge_ask`, `bridge_review`, `bridge_research`, `bridge_plan`, `bridge_implement`, `bridge_teamlead` | `jobs start`, `jobs ask`             |
| Esperar ou obter a saída | `bridge_wait`, `bridge_result`                                                                                         | `jobs wait <id>`, `jobs result <id>` |
| Pedir progresso          | `bridge_observe`                                                                                                       | `jobs observe <id>`                  |
| Cancelar trabalho        | `bridge_cancel`                                                                                                        | `jobs cancel <id>`                   |
| Encontrar jobs           | `bridge_list`                                                                                                          | `jobs list [--cwd] [--parent <id>]`  |

As skills preferem as ferramentas `bridge_*`. Se o host não carregou o MCP, elas executam o mesmo contrato de jobs por `npx -y agents-bridge-mcp`; nunca alteram a configuração do host como fallback.

O modo padrão é `read-only`, exceto em `implement`, que sempre roda em modo de escrita. Use `write` apenas em tarefas que autorizem explicitamente alterações.

## Exemplos de uso

### Fazer uma pergunta rápida

```bash
npx -y agents-bridge-mcp jobs ask codex "Por que src/jobs/store.ts poderia perder uma escrita com workers concorrentes?" --wait 120s
```

A resposta é impressa quando chega. Se a espera expirar, o job continua: `jobs wait <id>` o coleta.

### Revisar uma alteração

Comece com uma solicitação somente de leitura. Dê ao outro CLI o objetivo, os arquivos ou diff relevantes e o formato esperado da resposta.

```bash
npx -y agents-bridge-mcp jobs start codex "Revise o diff atual e reporte apenas achados acionáveis." --role review
# guarde o ID impresso pelo comando
npx -y agents-bridge-mcp jobs wait <job-id>
```

Depois de reiniciar o plugin, você também pode pedir a mesma tarefa pela skill `review` ou pela skill `delegate`. Elas escolhem MCP quando está disponível e usam o CLI como fallback.

### Delegar uma edição autorizada

O modo padrão é `read-only`, exceto em `implement`, que sempre roda em modo de escrita e rejeita `read-only`. Use-o somente quando a tarefa puder alterar arquivos. Mantenha apenas um job de escrita por worktree. A flag `--mode write` é redundante em `implement`, mas deixa a intenção explícita.

```bash
npx -y agents-bridge-mcp jobs start claude "Adicione um teste de regressão focado para o parser." --role implement --mode write --cwd .
npx -y agents-bridge-mcp jobs wait <job-id>
```

### Executar um team lead

```bash
npx -y agents-bridge-mcp jobs start claude "Audite o CLI em busca de tratamento de erros inconsistente e proponha correções. Delegue áreas independentes ao codex." --role teamlead
npx -y agents-bridge-mcp jobs observe <job-id>
npx -y agents-bridge-mcp jobs wait <job-id> --timeout 10m
```

### Continuar, observar ou cancelar

Uma espera expirada não interrompe o job. Repita `wait` para o mesmo ID, consulte o progresso quando solicitado ou obtenha o resultado salvo depois de uma sessão de terminal interrompida.

```bash
npx -y agents-bridge-mcp jobs observe <job-id>
npx -y agents-bridge-mcp jobs result <job-id>
npx -y agents-bridge-mcp jobs cancel <job-id>
```

Um job finalizado com sessão salva pode continuar no mesmo provider:

```bash
npx -y agents-bridge-mcp jobs start codex "Resolva o achado de maior prioridade." --continue <job-id>
```

| Código de saída de `wait` | Significado                             | Próxima ação                                      |
| ------------------------- | --------------------------------------- | ------------------------------------------------- |
| `0`                       | Job concluído                           | Leia e avalie o resultado retornado.              |
| `1`                       | Job falhou ou foi cancelado             | Use `result` para obter a saída e o erro retidos. |
| `2`                       | A espera expirou e o job continua ativo | Repita `wait`; não crie um job duplicado.         |

`jobs ask` usa os mesmos códigos de saída. Não encadeie `wait` ou `ask` em um pipe: o pipe descarta o código de saída.

`jobs wait --timeout` (por exemplo `10m` ou `90s`) limita apenas quanto tempo o comando espera. Para limitar quanto tempo um job pode rodar, use `jobs start --timeout <minutos>`: um número positivo de minutos, no máximo 120.

## Modelo de segurança

- **Somente leitura por padrão.** `ask`, `review`, `plan` e `research` sempre rodam em modo somente leitura, e `teamlead` é somente leitura, a menos que você passe `mode: write`. `implement` sempre roda em modo de escrita: `--role implement` e `bridge_implement` usam escrita por padrão e rejeitam `read-only`. Use-o somente depois que a pessoa autorizar edições.
- **Permissões por papel.** O sandbox ou a lista de ferramentas acompanha o papel e o modo:

  | Papel e modo                                                  | Sandbox do Codex     | Permissões do Claude                                                                         |
  | ------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
  | somente leitura (`ask`, `review`, `plan`, `teamlead` leitura) | `read-only`          | lista (abaixo) e negação explícita de `Edit`, `Write` e `NotebookEdit`                       |
  | `research`                                                    | `read-only`          | a lista de somente leitura mais `WebSearch` e `WebFetch`, com a mesma negação explícita      |
  | `implement`, `teamlead` em escrita                            | `workspace-write`    | modo de permissão `acceptEdits` mais a lista de verificação (abaixo)                         |
  | `teamlead` (líder Codex, leitura ou escrita)                  | `danger-full-access` | não se aplica                                                                                |
  | `teamlead` (líder Claude)                                     | não se aplica        | as linhas acima, mais acesso ao CLI limitado a `agents-bridge-mcp jobs *` (versão instalada) |

  A lista de somente leitura é `Read`, `Grep`, `Glob`, `git diff`, `git log`, `git show` e `git status`. A lista do modo de escrita acrescenta `pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add` e `git commit`, para que o worker rode comandos de verificação. Amplie-a com a variável de ambiente `AGENTS_BRIDGE_CLAUDE_WRITE_TOOLS`, uma lista separada por vírgulas de padrões de permissão do Claude. Um team lead no Claude não pode executar `setup` nem `install`, apenas `agents-bridge-mcp jobs *`.

- **Um team lead no Codex não fica em sandbox.** Ele roda com `--sandbox danger-full-access` nos dois modos, porque precisa iniciar processos worker e gravar o estado dos jobs. "Somente leitura" para um líder Codex significa que o runtime recusa qualquer job filho `write` (um pai somente leitura não pode iniciar filhos de escrita) e que o prompt proíbe edições; isso não restringe o processo do próprio líder. Lidere com o `claude` quando isso importar.
- **Limite de profundidade de delegação igual a 2.** Uma sessão inicia um team lead (profundidade 0), o líder inicia jobs filhos (profundidade 1), e os filhos não podem iniciar jobs. O runtime recusa um terceiro nível e recusa um team lead iniciado por um worker.
- **Um job `write` por worktree por vez.** Dois escritores na mesma árvore colidem. As skills e o prompt do team lead seguem essa regra; use git worktrees separados para edições em paralelo.
- **Quem delegou é quem aceita.** A saída do job é um insumo para o seu julgamento. Verifique as afirmações e rode os testes antes de integrar qualquer coisa produzida por um worker.
- **Sem alterações ocultas de configuração.** O plugin registra o próprio servidor MCP. O fallback executa o CLI e nunca edita a configuração do host. Não coloque segredos em briefings: prompts e resultados ficam em texto simples em `~/.agents-bridge`, em arquivos criados com permissões exclusivas do dono (`0600` para arquivos e `0700` para diretórios).

## Solução de problemas

Comece por `npx -y agents-bridge-mcp doctor`. Ele imprime `ok`, `warn` ou `fail` para cada verificação, com uma dica, e sai com código `1` se alguma verificação falhar. Funciona sem `codex` ou `claude` instalados e reporta o CLI ausente como aviso. Ele confere se cada CLI responde a `--version`, não se você está autenticado.

| Sintoma                                             | Causa provável e correção                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Ferramentas `bridge_*` ou skills não aparecem       | Reinicie o host após instalar; confira `claude plugin list` ou `codex plugin list`.                                          |
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

`npx -y agents-bridge-mcp setup` continua disponível para instalações existentes que usam os servidores síncronos da ponte ou os atalhos legados `/codex` e `/claude`. Novas instalações devem usar o plugin. O [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md#migrar-instalações-antigas-de-setup) explica como remover apenas as entradas legadas que pertencem ao Agents Bridge.

## Desenvolvimento

```bash
git clone https://github.com/naldomadeira/agents-bridge-mcp.git
cd agents-bridge-mcp
pnpm install
pnpm build
pnpm test
pnpm lint
```

Notas de versão estão no [changelog](../CHANGELOG.md).

## Licença

[MIT](../LICENSE)
