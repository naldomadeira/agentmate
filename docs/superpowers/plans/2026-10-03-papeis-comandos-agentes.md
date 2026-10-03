# Papéis, comandos e agentes para a ponte Claude <-> Codex — Plano de implementação

> **Para agentes:** use desenvolvimento orientado a testes. Não faça commit; o orquestrador revisa, valida e integra.

**Objetivo:** fechar as lacunas que impedem Claude Code e Codex de trabalharem como parceiros reais: perguntar algo ao outro modelo e receber a resposta na hora, pedir revisão, pesquisa, plano e implementação com prompts especializados, e colocar um dos dois como **team lead** capaz de delegar subtarefas ao outro. Tudo acessível por **skills/comandos** nos dois hosts, por **agentes** no Claude Code, por **ferramentas MCP** e pelo **CLI**. Entregar com acabamento profissional (README de adoção, `doctor`, CHANGELOG, versão 0.2.0).

**Arquitetura:** o runtime de jobs (`src/jobs/*`) continua o núcleo único. Um job ganha `role`, `depth` e `parentJob`. Prompt builders por papel vivem em `src/lib/prompt-builder.ts`. O servidor `serve jobs` expõe ferramentas `bridge_*` por papel (`bridge_ask`, `bridge_review`, `bridge_research`, `bridge_plan`, `bridge_implement`, `bridge_teamlead`) além das genéricas. O team lead é um job cujo worker recebe `AGENTS_BRIDGE_DEPTH=1` e delega ao outro provedor pelo CLI; o guard de profundidade impede recursão. Skills compartilhadas em `skills/` servem aos dois hosts; `agents/` serve ao Claude Code.

**Tecnologias:** Node.js >= 18, TypeScript, Vitest, citty, zod, `@modelcontextprotocol/sdk`, pnpm, oxlint, oxfmt.

---

## Diagnóstico (estado atual)

| Lacuna | Evidência |
| --- | --- |
| Só existe delegação genérica por prompt livre | `src/jobs-server.ts` expõe apenas `bridge_start/wait/observe/result/cancel/list`; nenhum papel. |
| Não há "pergunta rápida" síncrona | `bridge_start` sempre retorna só o id; o usuário precisa de dois passos para uma pergunta simples. |
| Skills e agente apontam para ferramentas que o plugin não publica | `skills/codex`, `skills/claude`, `agents/codex-teammate.md`, `.claude/skills/codex` referenciam `mcp__codex__*` / `mcp__claude__*` dos servidores legados síncronos; o plugin só registra `serve jobs`. |
| Nenhum modo team lead / delegação encadeada | `skills/delegate/SKILL.md` fixa "profundidade 1"; não há propagação de profundidade nem vínculo pai/filho entre jobs. |
| Só um agente (codex-teammate), sem revisor, pesquisador ou team lead | `agents/` tem um arquivo. |
| Pesquisa com Claude não consegue usar web | `READ_ONLY_CLAUDE_TOOLS` em `src/jobs/providers.ts` não inclui `WebSearch`/`WebFetch`. |
| Sem diagnóstico de instalação | Não existe comando `doctor`; o guia manda inspecionar manualmente. |
| Versão fixa em código | `new McpServer({ version: "0.1.0" })` duplicado em três servidores. |

---

## Contrato compartilhado (os dois workstreams dependem disto; não altere sem avisar)

### Tipos (`src/jobs/store.ts`)

```ts
export type JobRole = "custom" | "ask" | "review" | "research" | "plan" | "implement" | "teamlead";
export const JOB_ROLES: readonly JobRole[];
export interface Job {
  // ...campos atuais...
  role: JobRole;        // "custom" = prompt bruto (comportamento atual)
  depth: number;        // 0 = iniciado por uma sessão humana/host; 1 = iniciado por um worker
  parentJob?: string;   // id do job cujo worker iniciou este
}
```

### Profundidade e vínculo (`src/jobs/api.ts`)

- `MAX_DELEGATION_DEPTH = 2`. `startJob` lê `AGENTS_BRIDGE_DEPTH` (padrão `0`) e `AGENTS_BRIDGE_JOB_ID` do ambiente.
  - `depth >= 2` → erro `Delegation depth limit reached (...)`.
  - `role === "teamlead"` com `depth > 0` → erro `Only a top-level session can start a teamlead job`.
  - `parentJob` = `AGENTS_BRIDGE_JOB_ID` quando definido.
- O worker é iniciado com `env: { ...process.env, AGENTS_BRIDGE_DEPTH: String(depth + 1), AGENTS_BRIDGE_JOB_ID: job.id }`.
- Novas funções: `askJob(options, waitMs)` (start + wait, retorna `{ job, text }`), `childJobs(id)`, `listJobs({ cwd, limit, parent })`. `observeJob` passa a incluir `children: Job[]`.
- `StartOptions` ganha `role?: JobRole` (padrão `"custom"`).

### Prompt builders (`src/lib/prompt-builder.ts`)

Todos retornam `string`, em inglês, com formato de saída explícito. Manter `buildExplainCodePrompt` e `buildPlanPerfPrompt`.

| Função | Entrada | Saída pedida ao worker |
| --- | --- | --- |
| `buildAskPrompt({ question, context? })` | pergunta direta | resposta direta, curta, com evidências do código quando aplicável |
| `buildReviewPrompt({ target, focus?, context? })` | diff range, arquivos ou descrição | achados ordenados por severidade com `file:line`, cenário de falha, veredito final (`approve` / `request-changes`) |
| `buildResearchPrompt({ topic, questions?, scope?, context? })` | tema a investigar | achados com evidência, opções comparadas, recomendação, perguntas em aberto |
| `buildPlanPrompt({ goal, constraints?, existingPlan?, context? })` | objetivo; se `existingPlan` presente, critica em vez de criar | plano passo a passo com arquivos, riscos, verificação; ou crítica com lacunas e riscos |
| `buildImplementPrompt({ task, acceptance?, context? })` | tarefa de escrita | implementar, rodar verificações do repositório, não commitar salvo pedido, relatar arquivos alterados e como validou |
| `buildTeamleadPrompt({ objective, provider, otherProvider, canWrite, constraints?, context? })` | objetivo amplo | agir como team lead: decompor, delegar ao `otherProvider` via CLI, rodar em paralelo o que for independente, revisar resultados, integrar; relatório final com seções **Objective, Plan, Delegations (tabela id/provider/role/status), Findings, Decisions, Deliverables, Open questions** |

O prompt de team lead deve conter literalmente os comandos que o worker vai usar:

```bash
npx -y agents-bridge-mcp jobs start <otherProvider> "<briefing completo>" --role <ask|review|research|plan|implement> [--mode write] [--cwd <dir>]
npx -y agents-bridge-mcp jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running (repita)
npx -y agents-bridge-mcp jobs result <id>
npx -y agents-bridge-mcp jobs list
```

Regras no prompt: nunca delegar para o próprio provedor; apenas um job `write` por árvore de trabalho por vez; o worker delegado não pode delegar (o guard impede); não encerre antes de coletar todos os jobs que iniciou; se `canWrite` for falso, não iniciar jobs `write`.

### Flags por provedor e papel (`src/jobs/providers.ts`)

| Provedor | Condição | Flags |
| --- | --- | --- |
| codex | sempre em `exec` (não em `resume`) | `--json --skip-git-repo-check` |
| codex | `mode=read-only` | `--sandbox read-only` |
| codex | `mode=write` | `--sandbox workspace-write` |
| codex | `role=teamlead` (qualquer modo) | `--sandbox danger-full-access` (precisa iniciar processos `node` e gravar em `~/.agents-bridge`; documentar o aviso) |
| claude | `mode=read-only` | `--allowedTools` para `Read, Grep, Glob, Bash(git diff *), Bash(git log *), Bash(git show *), Bash(git status *)` |
| claude | `role=research` | acrescenta `WebSearch`, `WebFetch` |
| claude | `role=teamlead` | acrescenta `Bash(npx -y agents-bridge-mcp *)`, `Bash(npx agents-bridge-mcp *)`, `Bash(agents-bridge-mcp *)` |
| claude | `mode=write` | `--permission-mode acceptEdits` (como hoje) e, se `teamlead`, também os `--allowedTools` do CLI acima |

O worker constrói o prompt final: `role === "custom"` usa `job.prompt` bruto; os demais aplicam o builder do papel sobre os campos guardados. **Decisão:** o prompt já renderizado é gravado em `job.prompt` no `startJob` (o builder roda no processo que inicia o job), e `job.role` fica apenas como metadado. Assim o worker não muda e `jobs result`/`list` mostram o que foi realmente enviado.

### Ferramentas MCP (`src/jobs-server.ts`)

Parâmetros comuns opcionais: `cwd`, `model`, `timeoutMinutes`, `waitSeconds` (0 = retorna só o id; >0 = aguarda até esse limite e devolve o resultado ou "still running, call bridge_wait with id ...").

| Ferramenta | Obrigatórios | Opcionais específicos | Modo | `waitSeconds` padrão |
| --- | --- | --- | --- | --- |
| `bridge_start` | `provider`, `prompt` | `role` (enum `JOB_ROLES`), `mode`, `continue` | conforme `mode` | 0 |
| `bridge_ask` | `provider`, `question` | `context` | read-only | 120 (máx 300) |
| `bridge_review` | `provider`, `target` | `focus`, `context` | read-only | 0 |
| `bridge_research` | `provider`, `topic` | `questions`, `scope`, `context` | read-only | 0 |
| `bridge_plan` | `provider`, `goal` | `constraints`, `existingPlan`, `context` | read-only | 0 |
| `bridge_implement` | `provider`, `task` | `acceptance`, `context` | write | 0 |
| `bridge_teamlead` | `provider`, `objective` | `constraints`, `context`, `mode` (read-only padrão) | conforme `mode` | 0 |
| `bridge_wait`, `bridge_observe`, `bridge_result`, `bridge_cancel` | `id` | — | — | — |
| `bridge_list` | — | `cwd`, `limit`, `parent` | — | — |

Descrições das ferramentas devem dizer **quando** usar cada uma (uma frase) e lembrar que o worker não tem contexto além do briefing. `bridge_observe` de um team lead lista os jobs filhos com status.

### Versão

`src/lib/version.ts` exporta `export const VERSION = "0.2.0";`. Os três servidores MCP usam `VERSION`. `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` e `.agents/plugins/marketplace.json` ficam em `0.2.0`.

### CLI (`src/commands/jobs.ts`, `src/commands/doctor.ts`, `src/cli.ts`)

- `jobs start` ganha `--role <custom|ask|review|research|plan|implement|teamlead>`.
- `jobs ask <provider> "<question>" [--wait 120s] [--cwd] [--model]`: start + wait; imprime a resposta; códigos de saída iguais a `wait`.
- `jobs list [--cwd] [--parent <id>]`: mostra coluna `role`; filhos aparecem indentados sob o pai quando listados sem filtro.
- `jobs observe <id>`: inclui seção `children` quando houver.
- `doctor`: verifica Node >= 18, `codex` e `claude` no `PATH` (com versão quando disponível), diretório de estado gravável, quantidade de jobs e jobs `running` cujo worker morreu, registros legados (`claude mcp list` contendo `agents-bridge-mcp serve codex`, `~/.codex/config.toml` contendo `agents-bridge-mcp serve claude`). Imprime `ok`/`warn`/`fail` por item e uma dica por problema. Sai com `1` se houver `fail`. Deve funcionar sem `claude`/`codex` instalados (reporta `warn`).

### Skills (`skills/<nome>/SKILL.md`, compartilhadas pelos dois hosts)

Frontmatter obrigatório: `name` (igual ao diretório), `description` (uma frase, começa com verbo, diz quando usar), `argument-hint`. Sem `allowed-tools` (os prefixos MCP variam por host). Corpo em inglês, no máximo ~70 linhas: 1) preferir a ferramenta `bridge_*` do papel; 2) fallback CLI literal; 3) como escrever o briefing (o worker não tem contexto); 4) como tratar o resultado (quem avalia é quem delegou); 5) regras do papel.

| Skill | Ferramenta | Argumento |
| --- | --- | --- |
| `ask` | `bridge_ask` | `<codex\|claude> <question>` |
| `review` | `bridge_review` | `<codex\|claude> [target] [focus]` (sem target: `git diff` do trabalho atual) |
| `research` | `bridge_research` | `<codex\|claude> <topic>` |
| `plan` | `bridge_plan` | `<codex\|claude> <goal>` (ou `critique` + plano) |
| `implement` | `bridge_implement` | `<codex\|claude> <task>` (write; exigir autorização explícita) |
| `teamlead` | `bridge_teamlead` | `<codex\|claude> <objective>` (explicar a árvore de jobs, `bridge_observe` para acompanhar, `danger-full-access` no codex) |
| `jobs` | `bridge_list/observe/result/cancel` | `[list\|observe\|result\|cancel] [id]` |
| `delegate` | `bridge_start` com `role` | existente; atualizar: profundidade 2 com team lead, apontar para as skills por papel |
| `codex` | roteia pelo intento para a `bridge_*` certa com `provider=codex` | `<task or question>` (reescrever; remover `mcp__codex__*`) |
| `claude` | idem com `provider=claude` | `<task or question>` (reescrever; remover `mcp__claude__*`) |

### Agentes (`agents/*.md`, Claude Code)

Frontmatter: `name`, `description` (quando acionar; mencionar "Codex"), sem `tools` (herda tudo). Corpo: papel, ferramenta `bridge_*` a usar, como montar o briefing, como sintetizar (não repassar bruto), o que fazer em erro/timeout.

| Agente | Ferramenta principal |
| --- | --- |
| `codex-teammate` | `bridge_ask` / `bridge_start` (reescrever para `bridge_*`) |
| `codex-reviewer` | `bridge_review` |
| `codex-researcher` | `bridge_research` |
| `codex-teamlead` | `bridge_teamlead` com `provider=codex`, acompanha filhos com `bridge_observe` |

---

## Workstream A — Runtime, MCP e CLI (dono: agente A)

Arquivos: `src/jobs/store.ts`, `src/jobs/api.ts`, `src/jobs/providers.ts`, `src/jobs/worker.ts`, `src/jobs/render.ts`, `src/jobs-server.ts`, `src/lib/prompt-builder.ts`, `src/lib/version.ts` (novo), `src/codex-server.ts` e `src/claude-server.ts` (apenas trocar a versão por `VERSION`), `src/commands/jobs.ts`, `src/commands/doctor.ts` (novo), `src/cli.ts`, `test/jobs.test.ts`, `test/prompt-builder.test.ts`, `test/cli.test.ts`, `test/doctor.test.ts` (novo).

- [ ] **Tarefa A1 — Testes que falham primeiro** em `test/jobs.test.ts`: `--skip-git-repo-check` e `--sandbox` por modo/papel; `role` gravado; `AGENTS_BRIDGE_DEPTH`/`AGENTS_BRIDGE_JOB_ID` chegam ao worker (o codex falso imprime `process.env`); job iniciado com `AGENTS_BRIDGE_DEPTH=1` recebe `depth=1` e `parentJob`; `AGENTS_BRIDGE_DEPTH=2` é recusado; `teamlead` em profundidade 1 é recusado; `askJob` devolve texto; `childJobs`/`listJobs({ parent })`.
- [ ] **Tarefa A2 — Store + API**: tipos, guard, env do worker, `askJob`, `childJobs`, `observeJob.children`.
- [ ] **Tarefa A3 — Prompt builders**: seis builders com testes em `test/prompt-builder.test.ts` (cada um contém os títulos de seção exigidos; team lead contém os comandos CLI e o `otherProvider`).
- [ ] **Tarefa A4 — Providers**: tabela de flags acima; `claude` por papel.
- [ ] **Tarefa A5 — Servidor MCP**: ferramentas da tabela; helper único `startAndMaybeWait`; `VERSION`.
- [ ] **Tarefa A6 — CLI**: `--role`, `jobs ask`, `list`/`observe` com filhos, `doctor`; `test/cli.test.ts` cobre `jobs --help` com `ask`, `doctor --help`, e `doctor` rodando sem CLIs instalados (exit 0 ou 1 conforme o ambiente, mas sem exceção).
- [ ] **Tarefa A7 — Verificação**: `pnpm fmt`, `pnpm lint`, `pnpm test`, `pnpm build`.

## Workstream B — Skills, agentes, manifestos e documentação (dono: agente B)

Arquivos: `skills/**`, `agents/**`, `.claude/skills/**`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, `.mcp.json` (sem mudança esperada), `package.json` (versão, descrição, keywords, `repository.url` com `git+`), `README.md`, `docs/README.pt-BR.md`, `docs/INSTALL_FOR_AGENTS.md`, `docs/INSTALL_FOR_AGENTS.pt-BR.md`, `IMPLEMENTATION_PLAN.md`, `CHANGELOG.md` (novo), `test/plugin-package.test.ts`, `test/documentation.test.ts`.

- [ ] **Tarefa B1 — Testes que falham primeiro**: toda `skills/*/SKILL.md` tem frontmatter com `name` igual ao diretório, `description` e `argument-hint`; existem as dez skills da tabela; todo `agents/*.md` tem `name` igual ao arquivo e `description`; existem os quatro agentes; nenhum arquivo em `skills/`, `agents/` ou `.claude/skills/` contém `mcp__codex__` ou `mcp__claude__`; versões `0.2.0` alinhadas incluindo `src/lib/version.ts`; `.claude-plugin/plugin.json` declara `skills: "./skills/"` e `agents: "./agents/"`; README cita `bridge_ask`, `bridge_teamlead`, `doctor` e cada skill; `CHANGELOG.md` tem seção `0.2.0`.
- [ ] **Tarefa B2 — Skills e agentes** conforme as tabelas do contrato.
- [ ] **Tarefa B3 — Manifestos e `package.json`**: versão `0.2.0`; `description` orientada a benefício ("Let Claude Code and Codex CLI ask, review, research, plan, implement and lead each other as background jobs"); keywords ampliadas (`claude-code`, `codex-cli`, `openai`, `anthropic`, `agents`, `delegation`, `multi-agent`, `plugin`); `repository.url` em `git+https://...`. Rodar `claude plugin validate .` e manter `Validation passed`.
- [ ] **Tarefa B4 — README (EN) de adoção**: manter os trechos que `test/documentation.test.ts` exige hoje. Estrutura: título + tagline de uma linha + badges; "Why Agents Bridge" (3 bullets); "60-second quickstart" (instalar nos dois hosts, `/agents-bridge:ask codex ...` e `$ask` no Codex, `doctor`); "What you can do" — matriz **Skill / MCP tool / CLI / Mode** para os seis papéis; "Team lead mode" com diagrama ASCII da árvore de jobs e aviso do sandbox do codex; "How it works" (jobs duráveis); "Usage examples" (manter); "Safety model" (read-only padrão, sandbox por papel, guard de profundidade, um `write` por árvore); "Troubleshooting" (`doctor`, códigos de saída); "Legacy setup"; "Development"; "License". Tom direto, sem superlativos vazios.
- [ ] **Tarefa B5 — pt-BR, guias de instalação, IMPLEMENTATION_PLAN, CHANGELOG**: traduzir a nova estrutura mantendo os trechos exigidos pelos testes; guias de instalação ganham "Smoke test" com `jobs ask` e seção `doctor`; `IMPLEMENTATION_PLAN.md` ganha "v0.2 — Roles, commands and agents" com status; `CHANGELOG.md` no formato Keep a Changelog.
- [ ] **Tarefa B6 — Verificação**: `pnpm fmt`, `pnpm test test/plugin-package.test.ts test/documentation.test.ts`, `claude plugin validate .`.

## Integração (orquestrador)

- [ ] `pnpm fmt && pnpm lint && pnpm fmt:check && pnpm test && pnpm build && pnpm publint && claude plugin validate .`
- [ ] Revisão adversarial do diff (segunda leitura por agente revisor).
- [ ] Commit, push em `claude/zealous-planck-8srxsd`, PR para `main` com matriz de suporte e comandos de validação.
