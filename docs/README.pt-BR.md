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

## Exemplos de uso

### Revisar uma alteração

Comece com uma solicitação somente de leitura. Dê ao outro CLI o objetivo, os arquivos ou diff relevantes e o formato esperado da resposta.

```bash
npx -y agents-bridge-mcp jobs start codex "Revise o diff atual e reporte apenas achados acionáveis."
# guarde o ID impresso pelo comando
npx -y agents-bridge-mcp jobs wait <job-id>
```

Depois de reiniciar o plugin, você também pode pedir a mesma tarefa pela skill `delegate`. Ela escolhe MCP quando está disponível e usa o CLI como fallback.

### Delegar uma edição autorizada

Use `write` somente quando a tarefa puder alterar arquivos. Mantenha apenas um job de escrita por worktree.

```bash
npx -y agents-bridge-mcp jobs start claude "Adicione um teste de regressão focado para o parser." --mode write --cwd .
npx -y agents-bridge-mcp jobs wait <job-id>
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

## Desenvolvimento

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Licença

[MIT](../LICENSE)
