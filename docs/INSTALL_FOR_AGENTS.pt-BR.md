# Instale o Agents Bridge como plugin

[English](./INSTALL_FOR_AGENTS.md)

Este guia instala o plugin híbrido do Agents Bridge no Claude Code ou no Codex. O plugin fornece dez skills (`ask`, `review`, `research`, `plan`, `implement`, `teamlead`, `jobs`, `delegate`, `codex` e `claude`), quatro agentes que usam o Codex no Claude Code (`codex-teammate`, `codex-reviewer`, `codex-researcher` e `codex-teamlead`) e registra o servidor MCP de jobs (`bridge_start`, `bridge_ask`, `bridge_review`, `bridge_research`, `bridge_plan`, `bridge_implement`, `bridge_teamlead`, `bridge_wait`, `bridge_observe`, `bridge_result`, `bridge_cancel` e `bridge_list`). Quando o MCP não estiver carregado, as skills usam o CLI do pacote npm e mantêm o mesmo contrato de jobs.

## Pré-requisitos

- Node.js 18 ou superior;
- Claude Code ou Codex CLI, autenticado;
- acesso ao npm para executar `npx -y agents-bridge-mcp`.

O host que recebe uma delegação também precisa conseguir executar o outro CLI. Por exemplo, para delegar ao Codex a partir do Claude Code, `codex` deve estar no `PATH` do processo do Claude.

## Instalação limpa

### Claude Code

```bash
claude plugin marketplace add naldomadeira/agents-bridge-mcp
claude plugin install bridge@agents-bridge
```

Reinicie o Claude Code. As skills ficam disponíveis como `/bridge:ask`, `/bridge:review` e assim por diante, os quatro agentes são adicionados, e o plugin inicia somente o MCP de jobs.

### Codex

```bash
codex plugin marketplace add naldomadeira/agents-bridge-mcp
codex plugin add bridge@agents-bridge
```

Reinicie o Codex. As skills (digite `$bridge:ask`, ou `$bridge` para filtrar todas, ou escolha uma no menu `/skills`) e as ferramentas `bridge_*` são carregadas pelo plugin. A instalação registra o marketplace pelo CLI; não exige editar `~/.codex/config.toml`.

### Migrando da 0.2.0

O plugin foi renomeado de `agents-bridge` para `bridge`, então o id de instalação mudou. Remova o plugin antigo: `claude plugin uninstall agents-bridge@agents-bridge`; no Codex, remova o plugin `agents-bridge@agents-bridge` (use `codex plugin --help` para ver o verbo exato).
Depois instale `bridge@agents-bridge` como acima e reinicie o host.
Os comandos agora são `/bridge:ask` no Claude Code e `$bridge:ask` no Codex.

### Opcional: comandos de barra

No Claude Code as skills de plugin sempre têm namespace, e os plugins do Codex não trazem comandos de barra. Para ter comandos mais curtos, instale os modelos de comando que acompanham o pacote npm:

```bash
# Claude Code: /ask, /review, /research, /plan, /implement, /teamlead e /jobs simples
npx -y agents-bridge-mcp install commands claude --global

# Codex: /prompts:ask, /prompts:review, ... (reinicie o Codex depois)
npx -y agents-bridge-mcp install commands codex

# Os dois hosts
npx -y agents-bridge-mcp install commands both --global
```

Os comandos do Claude Code vão para `~/.claude/commands/` (`--local`: `./.claude/commands/`); os prompts do Codex vão para `$CODEX_HOME/prompts/` (padrão `~/.codex/prompts/`) e são sempre no nível do usuário. O instalador pergunta antes de sobrescrever um arquivo existente e imprime os nomes dos comandos instalados. A OpenAI marca os custom prompts do Codex como obsoletos em favor das skills; eles ainda funcionam, e a skill `$bridge:ask` não exige instalação extra.

### Desenvolvimento local

Use a raiz do checkout como marketplace quando estiver validando uma alteração ainda não enviada ao GitHub:

```bash
claude plugin marketplace add /caminho/absoluto/agents-bridge-mcp
claude plugin install bridge@agents-bridge

codex plugin marketplace add /caminho/absoluto/agents-bridge-mcp
codex plugin add bridge@agents-bridge
```

Remova um marketplace local antes de testar o repositório remoto com o mesmo nome. O modo team lead executa o CLI fixado na versão instalada (`npx -y agents-bridge-mcp@<versão> jobs ...`); por isso, um checkout local não publicado precisa ser publicado ou vinculado para os jobs de team lead funcionarem.

## Atualização

No Claude Code, atualize o marketplace e o plugin:

```bash
claude plugin marketplace update agents-bridge && claude plugin update bridge@agents-bridge
```

No Codex, atualize o snapshot do marketplace e reinicie:

```bash
codex plugin marketplace upgrade agents-bridge && codex plugin add bridge@agents-bridge
```

O Codex recarrega o plugin após reiniciar. Confirme a versão ativa com `codex plugin list`; no Claude Code use `claude plugin list`. O CLI publicado também mostra sua versão com `npx -y agents-bridge-mcp --version`. Os hosts mantêm o plugin em cache por versão, então a versão nova só aparece depois do reinício. Veja o [changelog](../CHANGELOG.md) para o que mudou.

## Smoke test de leitura

Depois do reinício, faça uma pergunta curta e sem escrita ao outro CLI. Pelo MCP, chame `bridge_ask` com `provider` igual a `codex` ou `claude` e uma pergunta como `Responda somente OK`. A ferramenta espera a resposta e a devolve na mesma chamada.

Quando as ferramentas MCP ainda não estiverem disponíveis, execute o fallback pelo CLI:

```bash
npx -y agents-bridge-mcp jobs ask codex "Responda somente OK" --wait 120s
```

`jobs ask` imprime a resposta. Se a espera expirar, imprime o ID do job e o deixa em execução; colete-o com `jobs wait <id>`.

Para exercitar também o caminho genérico de jobs, inicie e espere explicitamente. Pelo MCP, chame `bridge_start` com `mode` igual a `read-only` e depois `bridge_wait` com o mesmo ID. Sem MCP:

```bash
npx -y agents-bridge-mcp jobs start codex "Responda somente OK"
# guarde o ID impresso pelo comando
npx -y agents-bridge-mcp jobs wait <id>
```

`wait` e `ask` encerram com código `0` quando concluídos, `1` se falharem ou forem cancelados e `2` quando a espera expira. Código `2` não cancela o job: execute o mesmo `wait` novamente. Use `jobs result <id>` após uma espera interrompida. Chame `bridge_observe` ou `jobs observe <id>` somente quando a pessoa pedir progresso.

O modo padrão é `read-only`. A skill `implement` e `bridge_implement` sempre rodam em modo de escrita (`read-only` é rejeitado), então use-as apenas em uma tarefa de edição explicitamente autorizada. Em qualquer outro papel, passe `mode: write` ou `--mode write` apenas quando a tarefa autorizar explicitamente a edição de arquivos.

## Rodar o doctor

```bash
npx -y agents-bridge-mcp doctor
```

O `doctor` verifica se o Node.js é 18 ou superior, se `codex` e `claude` estão no `PATH` e respondem a `--version`, se o diretório de estado dos jobs é gravável, quantos jobs existem e quais jobs `running` perderam o worker (ele lista os IDs), e se ainda há um registro legado de `setup`. Cada item é reportado como `ok`, `warn` ou `fail`, com uma dica. Ele sai com código `1` se algum item falhar e funciona quando `codex` ou `claude` não estão instalados (reportado como aviso). Ele não verifica a autenticação: se um job falhar logo ao iniciar, faça login você mesmo no CLI de destino.

## Diagnóstico

1. Rode `npx -y agents-bridge-mcp doctor` e siga as dicas.
2. Rode `claude plugin list` ou `codex plugin list` para conferir se `bridge@agents-bridge` está habilitado e qual versão foi instalada.
3. Reinicie o host após instalar ou atualizar; a sessão atual não recarrega skills e ferramentas já registradas.
4. Rode `npx -y agents-bridge-mcp jobs list` para verificar se o fallback CLI está funcional.
5. Se o job falhar, confirme que o CLI de destino está disponível no `PATH` do host que iniciou o job (o `doctor` verifica) e autenticado (o `doctor` não verifica).
6. Se MCP estiver ausente mas o CLI funcionar, use o fallback; não registre automaticamente nenhum servidor na configuração pessoal do usuário.

## Migrar instalações antigas de `setup`

`npx agents-bridge-mcp setup` continua sendo suportado para instalações legadas, mas não integra o fluxo principal do plugin. Ele pode ter criado os servidores síncronos antigos e as skills `/codex` e `/claude`; o `doctor` reporta esses registros como avisos.

Antes de remover algo, use `claude mcp list`, `claude plugin list`, `codex plugin list` e abra os arquivos candidatos. Remova somente entradas que apontem exatamente para `agents-bridge-mcp serve codex` ou `agents-bridge-mcp serve claude`:

- Claude Code: `claude mcp remove codex -s user` remove o registro legado com esse nome.
- Codex: apague apenas a seção `[mcp_servers.claude]` que contenha `agents-bridge-mcp serve claude` de `~/.codex/config.toml`.
- Skills e agente antigos: remova somente cópias reconhecidas de `.claude/skills/codex/`, `.claude/agents/codex-teammate.md` e `.agents/skills/claude/` depois de conferir que não foram personalizadas.

Não remova registros com outro nome, outra origem ou conteúdo personalizado. Instale o plugin e reinicie o host antes de limpar registros legados, para manter uma rota de delegação disponível durante a transição.
