# Relatorium

Um mod para o Claude Code que adiciona o comando `/relatorium`. Em qualquer projeto, ele lê os históricos de sessão que o Claude Code guarda no seu computador (`~/.claude/projects`) e abre no navegador um relatório gráfico de quanto tempo e quantos tokens você já gastou naquele projeto.

## O que aparece no relatório

- Horas trabalhadas (só os trechos ativos; pausas acima de 30 min não contam) e quanto desse tempo o Claude passou trabalhando
- Linha do tempo de todas as sessões, horas por dia, custo por dia e horário em que você manda mensagens
- Tokens (lidos do cache, gravados no cache, entrada, saída), chamadas à API e custo equivalente na API, por modelo e por subagentes
- Janelas de uso de 5 h usadas e a fatia do projeto em todo o seu uso do Claude Code
- Tabela de sessões, ferramentas mais usadas, commits no período e linhas escritas

Tudo é calculado no seu computador. Nada é enviado para lugar nenhum.

## Instalar

Precisa do [Node.js](https://nodejs.org). Se ele não estiver instalado, ao rodar `/relatorium` o próprio Claude avisa e oferece instalar para você.

### No app do Claude (desktop)

O app não aceita `--marketplace` direto no install. Faça em dois passos, digitando no chat:

```
/plugin marketplace add pedrowelldantas/relatorium
```

```
/plugin install relatorium@relatorium
```

Se o app ainda disser que não encontrou, use a opção **Pelas configurações**, mais abaixo.

### No Claude Code de terminal

```
/plugin install relatorium --marketplace pedrowelldantas/relatorium
```

Responda `y` para adicionar o marketplace. Em seguida o Claude Code pergunta **onde instalar** (use as setas e Enter):

| Escopo | Onde o `/relatorium` funciona |
| --- | --- |
| **user** (global) | Em todos os seus projetos do Claude Code. É o recomendado. |
| **project** | Só no projeto atual, para todos que trabalham nele: fica gravado em `.claude/settings.json` do projeto, que vai junto no git. |
| **local** | Só no projeto atual e só para você: fica em `.claude/settings.local.json`, que não vai para o git. |

Ou, de um terminal comum, escolhendo o escopo com `--scope`:

```bash
# global, para todos os projetos
claude plugin install relatorium --marketplace pedrowelldantas/relatorium --scope user
```

```bash
# só no projeto atual (rode dentro da pasta do projeto)
claude plugin install relatorium --marketplace pedrowelldantas/relatorium --scope local
```

### Pelas configurações (funciona em qualquer lugar)

Acrescente isto ao arquivo de configurações e abra uma sessão nova:

- **global:** `~/.claude/settings.json` (no Windows, `C:\Users\<você>\.claude\settings.json`)
- **só no projeto:** `.claude/settings.local.json` dentro da pasta do projeto

```json
{
  "extraKnownMarketplaces": {
    "relatorium": { "source": { "source": "github", "repo": "pedrowelldantas/relatorium" } }
  },
  "enabledPlugins": { "relatorium@relatorium": true }
}
```

Se o arquivo já tiver conteúdo, junte essas duas chaves às que já existem, em vez de colar um segundo `{ }`.

Para mudar de ideia depois, desinstale (`/plugin`, aba de instalados) e instale de novo no outro escopo.

## Usar

Abra uma sessão do Claude Code no projeto e digite `/relatorium`. O relatório abre no navegador e fica salvo em `~/.claude/relatorium/<projeto>.html`.

## Observações

- O custo é uma estimativa pelo preço público da API. Em uma assinatura (Pro/Max) ele não é cobrado: conta como uso do seu limite.
- "Janela de uso" é o período de 5 h que começa na primeira mensagem, como nos limites da assinatura.

## Licença

MIT
