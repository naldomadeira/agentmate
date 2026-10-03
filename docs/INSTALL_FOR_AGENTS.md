# Instalar o Agents Bridge como plugin

Este guia instala o plugin híbrido do Agents Bridge no Claude Code ou no Codex. O plugin fornece a skill `delegate` e registra o servidor MCP de jobs (`bridge_start`, `bridge_wait`, `bridge_observe`, `bridge_result`, `bridge_cancel` e `bridge_list`). Quando o MCP não estiver carregado, a skill usa o CLI do pacote npm e mantém o mesmo contrato de jobs.

## Pré-requisitos

- Node.js 18 ou superior;
- Claude Code ou Codex CLI, autenticado;
- acesso ao npm para executar `npx -y agents-bridge-mcp`.

O host que recebe uma delegação também precisa conseguir executar o outro CLI. Por exemplo, para delegar ao Codex a partir do Claude Code, `codex` deve estar no `PATH` do processo do Claude.

## Instalação limpa

### Claude Code

```bash
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge
```

Reinicie o Claude Code. A skill fica disponível como `agents-bridge:delegate`, e o plugin inicia somente o MCP de jobs.

### Codex

```bash
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Reinicie o Codex. A skill `delegate` e as ferramentas `bridge_*` são carregadas pelo plugin. A instalação registra o marketplace pelo CLI; não exige editar `~/.codex/config.toml`.

### Desenvolvimento local

Use a raiz do checkout como marketplace quando estiver validando uma alteração ainda não enviada ao GitHub:

```bash
claude plugin marketplace add /caminho/absoluto/agents-bridge-mcp
claude plugin install agents-bridge@agents-bridge

codex plugin marketplace add /caminho/absoluto/agents-bridge-mcp
codex plugin add agents-bridge@agents-bridge
```

Remova um marketplace local antes de testar o repositório remoto com o mesmo nome.

## Atualização

No Claude Code, atualize o marketplace e o plugin:

```bash
claude plugin marketplace update agents-bridge
claude plugin update agents-bridge@agents-bridge
```

No Codex, atualize o snapshot do marketplace e reinicie:

```bash
codex plugin marketplace upgrade agents-bridge
```

O Codex recarrega o plugin após reiniciar. Confirme a versão ativa com `codex plugin list`; no Claude Code use `claude plugin list`. O CLI publicado também mostra sua versão com `npx -y agents-bridge-mcp --version`.

## Smoke test de leitura

Depois do reinício, delegue uma tarefa curta e sem escrita ao outro CLI. Pelo MCP, inicie o job com `bridge_start` usando `provider` igual a `codex` ou `claude`, `mode` igual a `read-only` e um prompt como `Responda somente OK`. Espere usando `bridge_wait` e entregue o resultado retornado para o mesmo ID.

Quando as ferramentas MCP ainda não estiverem disponíveis, execute o fallback da skill:

```bash
npx -y agents-bridge-mcp jobs start codex "Responda somente OK"
# guarde o ID impresso pelo comando
npx -y agents-bridge-mcp jobs wait <id>
```

`wait` encerra com código `0` quando concluído, `1` se falhar ou for cancelado e `2` quando a espera expira. Código `2` não cancela o job: execute o mesmo `wait` novamente. Use `jobs result <id>` após uma espera interrompida. Chame `bridge_observe` ou `jobs observe <id>` somente quando a pessoa pedir progresso.

O modo padrão é `read-only`. Passe `mode: write` ou `--mode write` apenas quando a tarefa autorizar explicitamente a edição de arquivos.

## Diagnóstico

1. Rode `claude plugin list` ou `codex plugin list` para conferir se `agents-bridge@agents-bridge` está habilitado e qual versão foi instalada.
2. Reinicie o host após instalar ou atualizar; a sessão atual não recarrega skills e ferramentas já registradas.
3. Rode `npx -y agents-bridge-mcp jobs list` para verificar se o fallback CLI está funcional.
4. Se o job falhar, confirme que o CLI de destino está autenticado e disponível no `PATH` do host que iniciou o job.
5. Se MCP estiver ausente mas o CLI funcionar, use o fallback; não registre automaticamente nenhum servidor na configuração pessoal do usuário.

## Migrar instalações antigas de `setup`

`npx agents-bridge-mcp setup` continua sendo suportado para instalações legadas, mas não integra o fluxo principal do plugin. Ele pode ter criado os servidores síncronos antigos e as skills `/codex` e `/claude`.

Antes de remover algo, use `claude mcp list`, `claude plugin list`, `codex plugin list` e abra os arquivos candidatos. Remova somente entradas que apontem exatamente para `agents-bridge-mcp serve codex` ou `agents-bridge-mcp serve claude`:

- Claude Code: `claude mcp remove codex -s user` remove o registro legado com esse nome.
- Codex: apague apenas a seção `[mcp_servers.claude]` que contenha `agents-bridge-mcp serve claude` de `~/.codex/config.toml`.
- Skills e agente antigos: remova somente cópias reconhecidas de `.claude/skills/codex/`, `.claude/agents/codex-teammate.md` e `.agents/skills/claude/` depois de conferir que não foram personalizadas.

Não remova registros com outro nome, outra origem ou conteúdo personalizado. Instale o plugin e reinicie o host antes de limpar registros legados, para manter uma rota de delegação disponível durante a transição.
