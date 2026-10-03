# AgentMate — Evolução incremental do runtime (Delegation + Collaboration)

> **Para agentes:** TDD. Não faça commit; o orquestrador revisa, valida e integra. Preserve tudo que funciona em jobs.

**Origem:** direção de arquitetura "AgentMate — Direção de Arquitetura" (seções 7 a 10): um único `Agent Runtime` com `Jobs`, `Events` e `Sessions` sobre `Agent Adapters` (Claude, Codex, depois Gemini). Preservar a camada de delegação (papéis, jobs duráveis, `wait/observe/result/cancel/list`, MCP, CLI, skills, permissões por papel) e evoluir incrementalmente para a camada de colaboração (cross-review, task splitting, mensagens filtradas, sessões).

## Análise da arquitetura atual (main, 0.4.0)

| Camada | Hoje | Limite |
| --- | --- | --- |
| Adapters | `src/jobs/providers.ts`: `buildInvocation()` e `parseOutcome()` com `if (provider === "codex")`; `Provider = "codex" \| "claude"` em `store.ts`; enums zod repetidos em `jobs-server.ts` e validação em `commands/jobs.ts`; `doctor` conhece os dois nomes. | Adicionar Gemini exige tocar seis arquivos. Não há contrato explícito de capacidades (sandbox, write, web, resume). |
| Jobs | `store.ts` (job.json atômico 0600, logs, result.md), `api.ts` (start, depth, parent, wait, observe, cancel, list, ask), `worker.ts` (processo destacado, `execCommand`, parse ao final). | `observe` devolve cauda bruta de stdout/stderr (JSONL do codex, JSON do claude): caro em contexto e ilegível. `cancel` mata só o PID do worker; filhos do CLI podem sobreviver. `isAlive` não confere reuso de PID. `AGENTMATE_HOME=""` é aceito como caminho. |
| Events | Não existem. O único sinal entre agentes é o `result.md` final. | Sem base para cross-review, split, inbox ou sessões. |
| Sessions | `sessionId` por job (thread do codex / sessão do claude) e `continue`. | Nenhum agrupamento de jobs com contexto compartilhado; o team lead só vê filhos via `parentJob`. |
| Collaboration | `teamlead` delega pelo CLI; skills guiam o host. | Cross-review e split dependem do host conduzir cada passo manualmente. |

## Decisões fechadas com o usuário (grill, 2026-10-03)

- Fase 1 (0.5.0) inclui adapters, eventos, lifecycle **e o papel `crossreview`**; task splitting fica na Fase 2.
- Cross-review é coordenado pelo worker do AgentMate como job de workflow (depth 0, passos como filhos depth 1; só sessão top-level inicia, como o team lead).
- Papéis: `provider` implementa, `otherAgent(provider)` revisa; máximo de 2 rodadas por padrão (`maxRounds`).
- O revisor roda na mesma árvore, read-only, revisando o `git diff` não commitado do implementador. Um job write por vez continua valendo.
- Parada: linha explícita `Verdict: approve` encerra como `done`; `Verdict: request-changes` abre nova rodada (`implement --continue` no implementador com os achados); sem veredito claro encerra com `needs-human` no relatório, sem iterar às cegas.
- Superfície: papel `crossreview` em `JOB_ROLES`, ferramenta `mate_crossreview(provider, task, acceptance?, maxRounds?, cwd?, model?, timeoutMinutes?, waitSeconds?)`, skill `crossreview` (`/mate:crossreview codex <tarefa>`), `jobs start --role crossreview`, templates de comando.
- Contexto entre passos por pai/filho e `result.md`; Sessions chegam na Fase 2.
- Claude passa a `--output-format stream-json` na Fase 2.
- Live mode (Fase 3): inbox em arquivo + hooks, sem daemon. Gemini na Fase 3, ativado só se o binário existir.
- Servidores síncronos legados (`serve codex`, `serve claude`, `setup`): aviso de depreciação em 0.5.0, remoção em 0.6.0.

## Princípios

1. Um runtime. Jobs, Events e Sessions compartilham `~/.agentmate` e o mesmo worker.
2. Adapters definem **como** falar com um agente; o runtime não contém `if (provider === ...)` fora deles.
3. Filtragem de contexto: o que cruza entre agentes é a conclusão (`important`), um resumo de progresso (`status`) e nunca o ruído de ferramentas (`fyi`, só sob demanda).
4. Segurança como está: read-only por padrão, permissões por papel, guard de profundidade. Nada de permissões máximas por padrão.
5. Cada fase entrega valor sozinha e mantém os 162+ testes verdes.

---

## Fase 1 — Adapters, Events, lifecycle e cross-review (este PR, 0.5.0)

### 1A. Agent adapters

Novo diretório `src/agents/`:

```ts
// src/agents/types.ts
export type AgentId = "codex" | "claude";           // Fase 3 acrescenta "gemini"
export interface AgentCapabilities {
  write: boolean;            // suporta modo write
  web: boolean;              // pode pesquisar na web em read-only
  resume: boolean;           // suporta continuar sessão
  streaming: "jsonl" | "none"; // emite eventos durante a execução
}
export interface AgentAdapter {
  id: AgentId;
  displayName: string;       // "Codex CLI", "Claude Code"
  binary(): string;          // honra AGENTMATE_<ID>_BIN
  capabilities: AgentCapabilities;
  buildInvocation(job: Job, resumeSessionId?: string): Invocation;
  parseOutcome(stdout: string, stderr: string, exitCode: number): Outcome;
  /** Converte uma linha/chunk de stdout em eventos filtrados; vazio quando não há streaming. */
  parseStreamLine?(line: string): JobEvent[];
  versionArgs: string[];     // ["--version"] para o doctor
}
```

- `src/agents/codex.ts` e `src/agents/claude.ts` recebem o conteúdo de `providers.ts` (flags por papel e modo exatamente como hoje; testes atuais continuam valendo).
- `src/agents/registry.ts`: `AGENTS: Record<AgentId, AgentAdapter>`, `AGENT_IDS` (tupla para zod), `getAgent(id)`, `otherAgent(id)` (usado pelo team lead), `isAgentId(x)`.
- `src/jobs/providers.ts` passa a reexportar `buildInvocation`, `parseOutcome`, `binary` delegando ao registry (compatibilidade), ou é removido com os imports atualizados. `Provider` vira alias de `AgentId`.
- `jobs-server.ts`, `commands/jobs.ts`, `commands/doctor.ts`, `prompt-builder.ts` deixam de listar nomes literalmente: usam `AGENT_IDS` e `getAgent`.
- Testes: `test/agents.test.ts` (registry completo, `otherAgent`, `buildInvocation` por adapter cobrindo as combinações papel × modo já testadas em `jobs.test.ts`).

### 1B. Job events e filtragem de contexto

Arquivo append-only `events.jsonl` por job (`~/.agentmate/jobs/<id>/events.jsonl`, 0600):

```ts
export type EventLevel = "important" | "status" | "fyi";
export interface JobEvent {
  ts: string;                // ISO
  job: string;
  level: EventLevel;
  kind: "queued" | "started" | "message" | "file" | "command" | "finished" | "error";
  text: string;              // uma linha legível, truncada em 500 chars
  data?: Record<string, unknown>; // ex.: { path, kind } ou { command, exitCode }
}
```

- `store.ts`: `eventsFile(id)`, `appendEvent(id, event)`, `readEvents(id, { since?, levels? })`.
- `worker.ts` emite `started`/`finished`/`error` (level `important`) e, para adapters com `streaming: "jsonl"`, alimenta `parseStreamLine` com um buffer de linhas parciais (padrão já existente em `codex-server.ts`). Mapeamento codex: `item.completed` + `agent_message` → `message` (`important`); `file_change` → `file` (`status`); `command_execution` → `command` (`fyi`, inclui exit code); `turn.failed`/`error` → `error` (`important`). Claude em `-p --output-format json` não tem stream: ao final, um único `message` (`important`) com as primeiras 500 chars do resultado. (Fase 2 avalia `--output-format stream-json`.)
- `api.ts`: `observeJob` passa a devolver `events` (padrão: níveis `important` e `status`, últimos 30) e só inclui `stdoutTail`/`stderrTail` quando `raw: true`. `renderObservation` imprime eventos como `HH:MM:SS  level  kind  text`.
- MCP: `mate_observe` ganha `raw?: boolean` e `levels?: EventLevel[]`; novo `mate_events(id, since?, levels?)`. CLI: `jobs observe <id> [--raw]`, novo `jobs events <id> [--since <ts>] [--level important,status,fyi] [--follow]` (follow faz polling de 1 s até terminal).
- Testes: codex falso emite `command_execution` e `file_change` além de `agent_message`; asserts no `events.jsonl`, nos níveis padrão de `observe` e no `--raw`.

### 1C. Lifecycle e robustez

- `isAlive(pid)` confere também que a linha de comando do PID contém `worker <id>` (Linux `/proc/<pid>/cmdline`; macOS `ps -o command= -p`); se não conseguir ler, mantém o comportamento atual.
- `cancelJob`: como o worker é `detached` (líder de grupo), enviar `SIGTERM` a `-pid` (grupo) e depois `SIGKILL` a `-pid`; fallback para o PID quando `-pid` falhar.
- `homeDir()`: `AGENTMATE_HOME` vazio conta como não definido.
- Nome do arquivo temporário em `writeJob` inclui `randomBytes(3)` além do PID.
- Toda mensagem de erro de job termina com o próximo comando (`jobs result <id>`, `agentmate doctor`).
- Testes: cancel mata o grupo (codex falso que gera um neto `sleep` e registra o PID num arquivo; após cancel, o neto não pode estar vivo); `AGENTMATE_HOME=""`.

### 1D. Docs

- `docs/ARCHITECTURE.md` (novo, EN): runtime, adapters, jobs, events, níveis, sessões (futuro), diagrama. README: link em "How it works". pt-BR: uma frase e o link.
- `skills/jobs/SKILL.md` e `templates/*/jobs.md`: `events` e `observe --raw`.
- `CHANGELOG.md`: `## [0.5.0] - Unreleased` com Added/Changed. Versão `0.5.0` em `package.json`, `src/lib/version.ts` e manifestos.

### Critérios de aceite da Fase 1

`pnpm lint && pnpm fmt:check && pnpm test && pnpm build && pnpm publint && claude plugin validate .` verdes; smoke com codex falso mostrando `jobs events <id>` com níveis; smoke real `jobs ask claude "reply pong"` continua funcionando; nenhum comportamento de flags alterado (diff dos args por papel × modo igual ao de 0.4.0).

---

## Fase 2 — Sessions e workflows de colaboração (0.6.0)

- **Sessions**: `~/.agentmate/sessions/<id>/session.json` + `notes.md` (contexto compartilhado curto, escrito pelo host e lido pelos workers via prompt). Jobs ganham `sessionId`. `mate_session_start/add/notes/list`; `continue` entre agentes diferentes passa a ser "nova conversa com as notas da sessão".
- **Split**: `plan` produz partes com interfaces fechadas → jobs paralelos (um `write` por worktree; o workflow cria worktrees `git worktree add` quando `mode: write`) → `review` cruzado → relatório de integração.
- **Lifecycle**: status `quota_exhausted` com detecção empírica das mensagens do `codex exec` e `claude -p` (429 transitório continua sendo retry); dica de handoff para o outro agente.
- **Hook SessionStart** (plugin Claude): "N jobs terminaram enquanto você esteve fora", fail-open, cooldown 120 s.
- Release: `scripts/smoke-pack.mjs`, `scripts/bump-version.mjs`, verificação pós-publish no registry.

## Fase 3 — Live mode e mais agentes (0.7.0)

- **Inbox**: eventos `important` de todos os jobs ativos agregados em `~/.agentmate/inbox.jsonl`; `mate_inbox` e hook para o host. Codex sem push: polling pelo skill.
- **Gemini adapter** (`gemini -p --output-format json`, `--sandbox`, `--yolo` nunca por padrão), ativado só quando o binário existe.
- **`agentmate init`**: bloco marcado idempotente em `AGENTS.md`/`CLAUDE.md` com as regras de colaboração (curto: quando delegar, não commitar sem pedido, formato de relatório).
- Avaliar adapter opcional para Codex app-server (modo live real) só se o protocolo estabilizar.

## O que não fazer

Daemon obrigatório, portas e WebSocket na instalação padrão; permissões máximas por padrão; bundles compilados no git; prosa de governança longa injetada em arquivos de instrução; reescrever o runtime de jobs.

---

## Fase 2 — Contrato de implementação (0.6.0, PR encadeado sobre a Fase 1)

### 2A. Remoção dos legados (workstream C)

Remover `src/codex-server.ts`, `src/claude-server.ts`, `src/commands/setup.ts`, `src/lib/deprecation.ts`, `.claude/skills/setup/`; `serve` fica só com `jobs`; `installer.ts` perde `setupClaude`/`setupCodex`; `cli.ts` perde `setup`; `tsdown.config.ts` e `package.json` (`bin` só `agentmate`, versão `0.6.0`) ajustados; `prompt-builder.ts` perde `buildExplainCodePrompt`/`buildPlanPerfPrompt`; `types.ts` perde `CODEX_MODELS`/`CLAUDE_MODELS`. `doctor` mantém a detecção de registros legados (`agents-bridge-mcp serve`, `agentmate serve codex|claude`) com dica de remoção. Docs: seção "Legacy setup" vira "Removed in 0.6.0" curta; guias de instalação idem; CHANGELOG `## [0.6.0] - Unreleased` com `### Removed`. Testes de CLI atualizados.

### 2B. Hook SessionStart, scripts de release e CI (workstream B)

- `hooks/hooks.json` (plugin Claude; `hooks: "./hooks/hooks.json"` no manifesto; `hooks` em `files`): `SessionStart` → `node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs`. Script sem dependências, fail-open (qualquer erro → exit 0 sem saída), cooldown de 120 s por `cwd` via stamp em `~/.agentmate/hooks/<hash-do-cwd>.stamp`, lê `~/.agentmate/jobs/*/job.json`, e imprime `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentMate: N jobs finished since your last session in this directory: <id> done (ask, codex, 2m ago) … · M running · K stale. Run `agentmate jobs list`."}}` apenas quando houver algo a dizer. Honra `AGENTMATE_HOME` e `AGENTMATE_HOOK_QUIET=1`. Testes com `AGENTMATE_HOME` temporário executando o script como processo.
- `scripts/smoke-pack.mjs`: `npm pack --dry-run --json` e asserts: todo `bin` existe no tarball e é executável, `files` cobre `dist`, `skills`, `agents`, `templates`, `hooks`, `assets`; sem `test/` nem `src/`. `scripts/smoke-built-cli.mjs`: roda `dist/cli.mjs --version`, `--help`, `doctor` e um `jobs ask` com binário falso em `HOME`/`AGENTMATE_HOME` temporários. `scripts/bump-version.mjs <x.y.z>`: atualiza `package.json`, `src/lib/version.ts`, os dois manifestos e `.agents/plugins/marketplace.json`; `--check` falha se divergirem. `package.json`: scripts `smoke:pack`, `smoke:cli`, `version:bump`, `version:check`; `release` passa a `node scripts/bump-version.mjs`. `ci.yml` roda `smoke:pack` e `smoke:cli` após o build; `release.yml` roda `version:check` e os smokes antes do publish e, depois, confere no registry `npm view agentmate@<v> version` com até 5 tentativas. Testes: `test/release-scripts.test.ts` (bump e check em cópia temporária).

### 2C. Sessions e split (workstream A1, após C)

- Sessão: `~/.agentmate/sessions/<sid>/session.json` `{ id, title, cwd, createdAt, updatedAt, jobs: string[] }` + `notes.md` (entradas `### <ISO> · <author>` + texto). `Job.sessionId?`. `startJob({ sessionId })` registra o job na sessão e prefixa o prompt com `## Shared session notes` (até 4000 chars das notas) para qualquer papel. Filhos de workflows herdam `sessionId`. API `src/jobs/sessions.ts`: `createSession`, `getSession`, `listSessions({ cwd })`, `appendNotes(sid, text, author)`, `sessionJobs(sid)`. MCP: `mate_session_start(title, cwd?)`, `mate_session_show(id)`, `mate_session_notes(id, text, author?)`, `mate_session_list(cwd?)`; todas as ferramentas de papel ganham `session?`. CLI: `agentmate sessions start|show|notes|list`, `jobs start --session <id>`. Skill `jobs` documenta.
- Split (`split` em `JOB_ROLES`, só top-level, `mode` read-only padrão): `mate_split(provider, goal, acceptance?, maxParts? (2..4, padrão 3), mode?, cwd?, session?)`. Passo 1: job `plan` no `provider` com `buildSplitPlanPrompt`, exigindo um bloco ```json com `{ "parts": [{ "id", "title", "briefing", "files": [], "agent": "codex"|"claude" }] }` com interfaces fechadas e sem sobreposição de arquivos; o worker valida (ids únicos, 1..maxParts, agentes conhecidos; agente ausente → alterna). Passo 2: partes em paralelo. Read-only: jobs `research` no mesmo `cwd`. Write: para cada parte `git worktree add -b agentmate/<split-id>/<part> <~/.agentmate/worktrees/<split-id>/<part>> HEAD` e job `implement` com `cwd` = worktree. Passo 3: `review` cruzado (o outro agente da parte) read-only no worktree da parte (diff contra `HEAD` de origem). Passo 4: relatório: `## Goal`, `## Parts` (tabela id/agent/implement/review/verdict/branch), `## Integration` (comandos `git merge agentmate/<split-id>/<part>` na ordem, aviso de que conflitos não são resolvidos automaticamente, `git worktree remove` para limpar), `## Needs human`. Eventos `important` por passo. Falha de parte → `error` com a parte identificada; as demais continuam até terminar. Split cria uma sessão automaticamente se não receber uma e grava o plano nas notas.

### 2D. Claude stream-json, quota e cancel em cascata (workstream A2, após A1)

- Adapter claude passa a `-p --output-format stream-json --verbose` (`streaming: "jsonl"`). Capturar o formato real com o CLI instalado antes de codificar. `parseStreamLine`: `assistant` com `text` → `message` (`important`, 500 chars); `tool_use` `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `file` (`status`, `input.file_path`); `tool_use` `Bash` → `command` (`fyi`, `input.command`); outros tool_use → `fyi` `command` com o nome da ferramenta; `result` → ignorado (o worker emite `finished`). `parseOutcome` extrai o último evento `result` (`result`, `session_id`, `is_error`). `claude-output-parser.ts` aceita os dois formatos.
- `JobStatus` ganha `quota_exhausted` (terminal). Detecção após as tentativas do `exec-runner`: padrões `/usage limit|hit your limit|quota|insufficient_quota|exceeded your current quota|out of credits|rate limit.*(reset|try again at)/i` sobre stderr e erros parseados, extensível por `AGENTMATE_QUOTA_PATTERNS` (alternativas separadas por `|`). `error` = `"<provider> quota exhausted: <linha>. Retry after the reset or start the job on <outro agente>."`. `wait`/`ask` saem com 1; `render` mostra a dica. Workflows: filho `quota_exhausted` → workflow `error` com a mesma dica.
- `cancelJob` cancela os filhos (`childJobs`) antes do pai, para que um workflow morto por SIGKILL não deixe órfãos.

### Ordem e versões

C e B em paralelo; depois A1; depois A2. Versão `0.6.0` em tudo; CHANGELOG `## [0.6.0] - Unreleased` com Added/Changed/Removed. PR encadeado com base em `claude/agentmate-runtime-phase1`.
