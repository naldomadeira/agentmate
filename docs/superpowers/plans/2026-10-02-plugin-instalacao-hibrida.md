# Instalação híbrida do Agents Bridge — Plano de implementação

> **Para agentes:** use desenvolvimento orientado a testes. As etapas usam checkboxes para registrar o andamento.

**Objetivo:** distribuir o Agents Bridge como plugin instalável em Claude Code e Codex, com MCP de jobs e fallback de CLI pela skill `delegate`.

**Arquitetura:** os dois hosts compartilham `skills/delegate/SKILL.md` e o runtime `src/jobs/api.ts`. Os manifestos só registram `serve jobs`; o MCP usa `bridge_*` e a skill usa o executável npm quando as ferramentas não foram carregadas. Marketplaces separados publicam a mesma raiz do repositório.

**Tecnologias:** Node.js, TypeScript, Vitest, pnpm, manifestos JSON de plugins Claude Code e Codex.

---

## Arquivos envolvidos

- Criar: `.codex-plugin/plugin.json`, `.mcp.json`, `.agents/plugins/marketplace.json`, `docs/INSTALL_FOR_AGENTS.md`, `test/plugin-package.test.ts`.
- Modificar: `.claude-plugin/plugin.json`, `README.md`, `package.json`, `skills/delegate/SKILL.md`.
- Não alterar: `src/jobs/api.ts`; ele já é o núcleo único para o CLI e MCP.

### Tarefa 1: Fixar os contratos de distribuição

- [ ] **Passo 1: Escrever testes de manifesto e empacotamento que falham.**

```ts
it("declara o mesmo servidor jobs no plugin Codex", () => {
  expect(codexManifest.mcpServers).toBe("./.mcp.json");
  expect(codexMcp.mcpServers["agents-bridge"].args).toEqual([
    "-y", "agents-bridge-mcp", "serve", "jobs",
  ]);
});

it("inclui artefatos necessários no pacote npm", () => {
  expect(pkg.files).toEqual(expect.arrayContaining(["dist", "skills", "agents"]));
});
```

- [ ] **Passo 2: Rodar o teste e confirmar a falha por manifestos ausentes.**

Executar: `pnpm vitest run test/plugin-package.test.ts`.

Resultado esperado: falha ao abrir `.codex-plugin/plugin.json` e `.mcp.json`.

- [ ] **Passo 3: Criar os manifestos Codex e o marketplace.**

```json
{
  "name": "agents-bridge",
  "version": "0.1.0",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

```json
{
  "mcpServers": {
    "agents-bridge": {
      "command": "npx",
      "args": ["-y", "agents-bridge-mcp", "serve", "jobs"]
    }
  }
}
```

- [ ] **Passo 4: Rodar o teste e confirmar que passa.**

Executar: `pnpm vitest run test/plugin-package.test.ts`.

Resultado esperado: todos os testes desse arquivo passam.

### Tarefa 2: Consolidar a skill e o plugin Claude

- [ ] **Passo 1: Escrever teste que fixa a declaração de jobs do Claude.**

```ts
it("registra somente o servidor de jobs no plugin Claude", () => {
  expect(claudeManifest.mcpServers).toEqual({
    "agents-bridge": {
      command: "npx",
      args: ["-y", "agents-bridge-mcp", "serve", "jobs"],
    },
  });
});
```

- [ ] **Passo 2: Rodar o teste e confirmar a falha pela forma anterior.**

Executar: `pnpm vitest run test/plugin-package.test.ts`.

Resultado esperado: falha porque a declaração ainda não possui `-y` e o teste de skill ainda não foi incluído.

- [ ] **Passo 3: Ajustar `.claude-plugin/plugin.json` e `skills/delegate/SKILL.md`.**

A skill deve especificar: iniciar, aguardar e buscar o resultado do mesmo ID; `bridge_observe` somente quando progresso for pedido; `read-only` por padrão; `write` somente com autorização da tarefa; e os comandos CLI completos com `npx -y agents-bridge-mcp jobs`.

- [ ] **Passo 4: Rodar o teste de manifesto.**

Executar: `pnpm vitest run test/plugin-package.test.ts`.

Resultado esperado: todos os testes passam.

### Tarefa 3: Documentar instalação, atualização e migração

- [ ] **Passo 1: Escrever o guia para agentes.**

Criar `docs/INSTALL_FOR_AGENTS.md` com pré-requisitos, instalação e atualização em ambos os hosts, reinício, smoke test de leitura, fallback CLI, diagnóstico da versão ativa e remoção manual, segura e explícita dos registros legados criados por `setup`.

- [ ] **Passo 2: Atualizar o caminho rápido do README.**

Apontar a instalação por plugin e o guia completo como recomendados. Manter `setup` como caminho legado/manual sem removê-lo.

- [ ] **Passo 3: Validar o manifesto Claude.**

Executar: `claude plugin validate .`.

Resultado esperado: `Validation passed`.

### Tarefa 4: Validar entrega e preparar PR

- [ ] **Passo 1: Formatar e rodar a suíte.**

Executar: `pnpm fmt`, `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm fmt:check` e `pnpm publint`.

Resultado esperado: todos os comandos encerram com código zero.

- [ ] **Passo 2: Validar o pacote publicado localmente.**

Executar: `pnpm pack --pack-destination <diretório-temporário>` e inspecionar o tarball.

Resultado esperado: contém `dist/`, `skills/` e `agents/`; os manifestos e a documentação permanecem no checkout Git para instalação por marketplace.

- [ ] **Passo 3: Revisar diff, criar commit, enviar branch e abrir PR.**

Executar: `git diff --check`, `git status --short`, `git add`, `git commit`, `git push -u origin feat/hybrid-plugin-installation`, `gh pr create --base main --head feat/hybrid-plugin-installation`.

Resultado esperado: PR aberto com a matriz de suporte e os comandos de validação no corpo.
