import type { EngineInterface, Register } from 'claude-code'

// The work is done by scripts/relatorium.cjs under Node, since transcripts are
// often larger than what $.fs.read takes in one read.
type Summary = {
  file: string
  project: string
  sessions: number
  days: number
  active: string
  agent: string
  tokens: string
  cost: string
  windows: number
  share: string
  prompts: number
}

// Where Node.js usually lives, for when it was just installed and this
// process's PATH does not know it yet.
const NODE_CANDIDATES = [
  'node',
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
]

const NODE_MISSING_PROMPT = [
  'O usuário rodou /relatorium, mas o Node.js não está instalado neste computador, e o Relatorium precisa dele para montar o relatório.',
  'Explique isso em uma frase e pergunte se ele quer que você instale o Node.js (versão LTS) agora.',
  'Se ele aceitar: descubra o sistema operacional e instale pelo gerenciador de pacotes dele',
  '(Windows: `winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements`;',
  'macOS: `brew install node`, ou o instalador de https://nodejs.org se não houver Homebrew;',
  'Linux: o gerenciador da distribuição, por exemplo `sudo apt install nodejs`).',
  'Depois confira com `node --version` (no Windows, se o comando ainda não for achado, use "C:\\Program Files\\nodejs\\node.exe" --version)',
  'e diga para ele digitar /relatorium de novo. Se ele recusar, mostre o link https://nodejs.org para instalar por conta própria.',
  'Responda no idioma do usuário.',
].join(' ')

type Run = Awaited<ReturnType<EngineInterface['process']['run']>>

// Runs the args under the first Node.js that starts; undefined when none does.
async function runWithNode($: EngineInterface, args: string[]): Promise<Run | undefined> {
  for (const node of NODE_CANDIDATES) {
    try {
      return await $.process.run([node, ...args], { timeoutMs: 120_000 })
    } catch (error) {
      // a Node that started and then hung is a real failure, not a missing one
      if (/time|still running/i.test(String(error))) throw error
    }
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relatorium',
      description: 'Relatório gráfico do tempo e dos tokens gastos neste projeto',
    })

    return next(e)
  })

  on('command.run', { command: 'relatorium' }, async $ => {
    const project = await $.session.root()
    const script = `${$.plugin.root}/scripts/relatorium.cjs`
    $.ui.status('Montando o relatório…')
    try {
      const run = await runWithNode($, [script, project])
      if (run === undefined) {
        // No Node.js on this machine: hand it to Claude, who offers to install it.
        // (a prompt can't be submitted from inside the command, so it goes out just after)
        $.clock.after(300, () => {
          $.prompt.submit({ text: NODE_MISSING_PROMPT }).catch(() => undefined)
        })
        return { text: 'O Relatorium precisa do Node.js, que não foi encontrado neste computador.' }
      }
      if (run.exitCode !== 0) {
        return { text: `Não consegui gerar o relatório:\n${run.stderr.slice(0, 1500)}` }
      }
      const s = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as Summary
      return {
        text: [
          `Relatorium de ${s.project} aberto no navegador.`,
          `• ${s.active} de trabalho em ${s.sessions} sessões (${s.days} dias), Claude trabalhando ${s.agent}`,
          `• ${s.tokens} tokens · ≈ ${s.cost} equivalente na API · ${s.share} de todo o seu uso`,
          `• ${s.windows} janelas de uso de 5 h · ${s.prompts} mensagens suas`,
          `Arquivo: ${s.file}`,
        ].join('\n'),
      }
    } catch (error) {
      return { text: `Não consegui gerar o relatório: ${String(error)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
