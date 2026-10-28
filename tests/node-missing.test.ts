import { expect, test } from 'claude-code/testing'

test('without Node.js, Claude is asked to offer installing it', async ($, on) => {
  const tried: string[] = []
  const prompts: string[] = []
  on('command.register', () => ({ value: { command: 'relatorium' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/projeto' }))
  on('ui.status', () => ({ value: {} }))
  on('process.run', (_, e) => {
    tried.push(e.argv[0] ?? '')
    return { deny: 'spawn ENOENT' }
  })
  on('clock.after', () => ({ value: {} }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/projeto', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({ command: 'relatorium' })

  expect(result.text).toContain('Node.js')
  expect(tried[0]).toBe('node')
  expect(tried.length).toBe(6)
  // the prompt is queued without waiting for it
  await new Promise(resolve => setTimeout(resolve, 600))
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('instale o Node.js')
})

test('with Node.js, the summary comes back', async ($, on) => {
  on('command.register', () => ({ value: { command: 'relatorium' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/projeto' }))
  on('ui.status', () => ({ value: {} }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        file: '/r.html', project: 'projeto', sessions: 2, days: 1, active: '1 h', agent: '30 min',
        tokens: '1 M', cost: '$1.00', windows: 1, share: '10 %', prompts: 5,
      }),
    },
  }))

  await $.session.start({ cwd: '/projeto', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({ command: 'relatorium' })

  expect(result.text).toContain('Relatorium de projeto')
})
