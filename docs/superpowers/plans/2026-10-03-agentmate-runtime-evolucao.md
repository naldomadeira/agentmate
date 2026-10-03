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
