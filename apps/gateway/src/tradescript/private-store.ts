import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { z } from 'zod'

/** The desktop encryption key comes from the OS keychain, never from the browser. */
export class PrivateStore<T> {
  constructor(
    private readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly key?: Buffer,
  ) {
    if (key && key.length !== 32) throw new Error('Invalid credential encryption key')
  }

  read(): T | undefined {
    try {
      const envelope = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!this.key) return this.schema.parse(envelope)
      const decrypt = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'))
      decrypt.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return this.schema.parse(
        JSON.parse(
          Buffer.concat([
            decrypt.update(Buffer.from(envelope.data, 'base64')),
            decrypt.final(),
          ]).toString('utf8'),
        ),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Saved TradeScript access could not be read. Log in again to restore access.')
    }
  }

  write(value: T): void {
    let contents = JSON.stringify(this.schema.parse(value))
    if (this.key) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.key, iv)
      const data = Buffer.concat([cipher.update(contents, 'utf8'), cipher.final()])
      contents = JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      })
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.tmp`, contents, { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
  }

  clear(): void {
    rmSync(this.path, { force: true })
    rmSync(`${this.path}.tmp`, { force: true })
  }
}
