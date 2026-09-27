import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'

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
