import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'

async function failureOutput(start: string, shutdown = false) {
  const entry = new URL('../src/index.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { runService } from ${JSON.stringify(entry)};
    await runService(${start});
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString()
  })
  const exited = once(child, 'exit')
  try {
    if (shutdown) {
      await once(child.stdout, 'data')
      child.kill('SIGTERM')
    }
    const [code] = await exited
    return { code, output, errors }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

it.each([
  [
    'address-in-use',
    `Object.assign(new Error('private URL and credential=dummy-secret'), { code: 'EADDRINUSE' })`,
    'port is already in use',
  ],
  [
    'origin-port-mismatch',
    `new Error('TRADESCRIPT_REQUESTED_ORIGIN port must equal UI_PORT')`,
    'configured UI_PORT',
  ],
  [
    'root-launch-required',
    `new Error('Start the workstation with the root npm run dev command')`,
    'root npm run dev command',
  ],
  [
    'agent-settings-incomplete',
    `new Error('Agent paper trading is enabled but required limits are missing: AGENT_MAX_DAILY_LOSS')`,
    'required risk limit',
  ],
])(
  'reports safe actionable startup guidance for %s without printing the original error',
  async (code, error, guidance) => {
    const result = await failureOutput(`async () => { throw ${error}; }`)
    expect(result.code).toBe(1)
    expect(result.errors).toContain(`TERMINAL_SERVICE_FAILURE startup:${code}`)
    expect(result.errors).toContain(guidance)
    expect(result.errors).not.toContain('dummy-secret')
    expect(result.errors).not.toContain(' at ')
  },
)

it('captures synchronous startup exceptions without exposing private messages', async () => {
  const result = await failureOutput(
    `() => { throw new Error('credential=dummy-secret; account=dummy-account'); }`,
  )
  expect(result.code).toBe(1)
  expect(result.errors).toContain('TERMINAL_SERVICE_FAILURE startup:unknown-error')
  expect(result.errors).not.toMatch(/dummy-secret|dummy-account| at /u)
})

it('prints only approved missing setting names and suppresses values disguised as configuration diagnostics', async () => {
  const trusted = await failureOutput(
    `async () => { throw new Error('Agent paper trading is enabled but required limits are missing: AGENT_MAX_DAILY_LOSS, IBKR_ALLOWED_ACCOUNT_IDS'); }`,
  )
  expect(trusted.errors).toContain(
    'Missing settings: AGENT_MAX_DAILY_LOSS, IBKR_ALLOWED_ACCOUNT_IDS.',
  )
  const privateValue = await failureOutput(
    `async () => { throw new Error('Agent paper trading is enabled but required limits are missing: credential=dummy-secret'); }`,
  )
  expect(privateValue.errors).toContain('startup:agent-settings-incomplete')
  expect(privateValue.errors).not.toContain('dummy-secret')
})

it.skipIf(process.platform === 'win32')(
  'reports bounded shutdown diagnostics without echoing private values',
  async () => {
    const result = await failureOutput(
      `async () => {
    setInterval(() => {}, 1000);
    process.stdout.write('ready\\n');
    return { async close() { throw Object.assign(new Error('credential=dummy-secret'), { code: 'EACCES' }); } };
  }`,
      true,
    )
    expect(result.code).toBe(1)
    expect(result.errors).toContain('TERMINAL_SERVICE_FAILURE shutdown:permission-denied')
    expect(result.errors).not.toContain('dummy-secret')
  },
)

// Windows terminates CLI processes on SIGTERM; desktop uses the tested worker protocol.
it.skipIf(process.platform === 'win32')(
  'runs asynchronous service cleanup before a CLI signal exits',
  async () => {
    const entry = new URL('../src/index.ts', import.meta.url).href
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
    import { runService } from ${JSON.stringify(entry)};
    await runService(async () => {
      const timer = setInterval(() => {}, 1000);
      process.stdout.write('ready\\n');
      return { async close() {
        await new Promise(r => setTimeout(r, 30));
        clearInterval(timer);
        process.stdout.write('cleaned\\n');
      } };
    });
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    const exited = once(child, 'exit')
    try {
      await once(child.stdout, 'data')
      child.kill('SIGTERM')
      expect((await exited)[0]).toBe(0)
      expect(output).toContain('cleaned')
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  },
)
