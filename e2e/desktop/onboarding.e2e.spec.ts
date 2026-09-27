import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import WebSocket from 'ws'

let child: ChildProcess
let dataDir: string
let runtimeOrigin: string
let runtime: string
const credentialKey = randomBytes(32).toString('base64')

test.beforeAll(async () => {
  test.setTimeout(90_000)
  dataDir = await mkdtemp(join(tmpdir(), 'terminal-desktop-e2e-'))
  runtime = join(dataDir, 'runtime')
  await promisify(execFile)(
    process.execPath,
    ['scripts/desktop/prepare.mjs', '--runtime-only', '--output-dir', runtime],
    { timeout: 60_000 },
  )
  await launchRuntime()
})

async function launchRuntime(uiPort = 0) {
  child = spawn(process.execPath, [join(runtime, 'runtime.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const ready = new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
      const match = output.match(/TERMINAL_READY (http:\/\/127\.0\.0\.1:\d+)/u)
      if (match?.[1]) {
        runtimeOrigin = match[1]
        resolve()
      }
    })
    child.once('exit', () => reject(new Error('Desktop runtime exited before ready')))
    child.once('error', reject)
  })
  child.stdin?.write(
    `${JSON.stringify({ dataDir: join(dataDir, 'state'), credentialKey, uiPort })}\n`,
  )
  await Promise.race([
    ready,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Desktop runtime did not become ready within 20 seconds')),
        20_000,
      )
      timer.unref()
    }),
  ])
}
test.afterAll(async () => {
  if (child?.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.stdin?.end()
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          resolve()
        }, 5000)
        timer.unref()
      }),
    ])
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})
test('fresh packaged onboarding, activation failure and connection discovery UI', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(runtimeOrigin)
  await expect(page.getByText('Welcome to TradeScript')).toBeVisible()
  await expect(page.getByLabel('Credential ID', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Activate SDK' })).toBeDisabled()
  // Test gateway validation without contacting the licensing service or any TWS.
  const result = await page.evaluate(async () => {
    const session = await (
      await fetch('/api/v1/session/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tradescript-client': 'terminal-v1' },
        body: '{}',
      })
    ).json()
    const response = await fetch('/api/v1/setup/sdk', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-tradescript-client': 'terminal-v1',
        'x-tradescript-csrf': session.csrfToken,
      },
      body: '{}',
    })
    return response.status
  })
  expect(result).toBe(400)
  await page.route('**/api/v1/setup/sdk', (route) =>
    route.fulfill({ status: 400, json: { error: { message: 'Invalid SDK credentials.' } } }),
  )
  await page.getByLabel('Credential ID', { exact: true }).fill('test-id')
  await page.getByLabel('SDK secret', { exact: true }).fill('test-secret')
  await page.getByRole('button', { name: 'Activate SDK' }).click()
  await expect(page.getByRole('alert')).toHaveText('Invalid SDK credentials.')
  await page.unroute('**/api/v1/setup/sdk')
  await page.route('**/api/v1/setup/sdk', (route) =>
    route.fulfill({ json: { configured: true, ready: true } }),
  )
  await page.getByRole('button', { name: 'Activate SDK' }).click()
  await expect(page.getByText('SDK credentials saved · Activated')).toBeVisible()
  await page.getByRole('button', { name: 'Connection', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connection', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply and connect' })).toBeDisabled()
  await expect(page.getByText('Allowed accounts', { exact: true })).toHaveCount(0)
  // Deliberately intercepted: no TWS connection or order mutation is made by this UI test.
  await page.route('**/api/v1/connection/test', (route) =>
    route.fulfill({ json: { testId: 'fixture', accounts: ['DU-FIXTURE'] } }),
  )
  await page.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(page.getByText('Connection successful')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply and connect' })).toBeEnabled()
  await page.getByRole('button', { name: 'Close', exact: true }).last().click()
  await page.screenshot({ path: test.info().outputPath('desktop-onboarding.png'), fullPage: true })
  expect(errors).toEqual([])
})

test('stops packaged services, releases their ports and reopens the workstation', async ({
  page,
}) => {
  await page.goto(runtimeOrigin)
  const response = await page.request.post(`${runtimeOrigin}/mcp-local/browser-session`)
  expect(response.ok()).toBe(true)
  const session = (await response.json()) as {
    sessionId: string
    bridgeToken: string
    bridgeUrl: string
    mcpUrl: string
  }
  const bridge = new WebSocket(session.bridgeUrl, { origin: runtimeOrigin })
  await once(bridge, 'open')
  bridge.send(
    JSON.stringify({
      type: 'attach',
      sessionId: session.sessionId,
      token: session.bridgeToken,
      title: 'Desktop lifecycle test',
      surfaces: [],
    }),
  )
  await once(bridge, 'message')
  const socketClosed = once(bridge, 'close')
  const exited = once(child, 'exit')
  child.stdin?.write('stop\n')
  const [code] = await exited
  expect(code).toBe(0)
  await socketClosed
  for (const url of [runtimeOrigin, session.mcpUrl, session.bridgeUrl]) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number(new URL(url).port), '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await launchRuntime(Number(new URL(runtimeOrigin).port))
  await page.goto(runtimeOrigin)
  await expect(page.getByText('Welcome to TradeScript')).toBeVisible()
})
