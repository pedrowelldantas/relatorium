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

No Claude Code (terminal), digite:

```
/plugin install relatorium --marketplace pedrowelldantas/relatorium
```

Responda `y` para adicionar o marketplace e escolha o escopo **user** para ter o comando em todos os projetos.

Ou, de um terminal comum:

```bash
claude plugin install relatorium --marketplace pedrowelldantas/relatorium
```

## Usar

Abra uma sessão do Claude Code no projeto e digite `/relatorium`. O relatório abre no navegador e fica salvo em `~/.claude/relatorium/<projeto>.html`.

## Observações

- O custo é uma estimativa pelo preço público da API. Em uma assinatura (Pro/Max) ele não é cobrado: conta como uso do seu limite.
- "Janela de uso" é o período de 5 h que começa na primeira mensagem, como nos limites da assinatura.

## Licença

MIT
