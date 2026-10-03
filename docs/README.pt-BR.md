# Agents Bridge

[English](../README.md)

Delegue trabalho entre o Claude Code e o Codex CLI sem bloquear a sessão que iniciou a tarefa. O Agents Bridge inclui a skill `delegate`, um servidor MCP de jobs em segundo plano e um fallback pelo CLI.

![Dois ambientes de desenvolvimento conectados por uma ponte segura.](../assets/illustrations/cli-bridge.png)

## Instalação

Instale o plugin no host que você usa. Ele adiciona a skill `delegate` e o servidor MCP de jobs sem exigir edição manual dos arquivos de configuração.

```bash
# Claude Code
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge

# Codex
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Reinicie o host depois da instalação. Consulte o [guia de instalação](./INSTALL_FOR_AGENTS.pt-BR.md) para atualizar, testar, diagnosticar e migrar instalações legadas.

## Como funciona

1. Inicie uma tarefa no `codex` ou no `claude`; `bridge_start` retorna um ID imediatamente.
2. Aguarde o mesmo ID, colete o resultado ou peça progresso quando a pessoa solicitar.
3. Jobs continuam em execução mesmo quando a sessão que os iniciou termina.

![Uma tarefa passa pela fila, worker e resultado.](../assets/illustrations/background-jobs.png)

O modo padrão é `read-only`. Use `write` apenas em tarefas que autorizem explicitamente alterações.

## Desenvolvimento

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Licença

[MIT](../LICENSE)
