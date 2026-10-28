import type { Register } from 'claude-code'

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
      const run = await $.process.run(['node', script, project], { timeoutMs: 120_000 })
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
      return { text: `Não consegui gerar o relatório (o Node.js está instalado?): ${String(error)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
