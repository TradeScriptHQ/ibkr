import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const RuntimeCredentialSchema = z
  .object({
    credentialId: z.string().trim().min(1).max(512),
    credentialSecret: z.string().trim().min(1).max(4096),
  })
  .strict()
export type RuntimeCredential = z.infer<typeof RuntimeCredentialSchema>

/** Desktop supplies an OS-keychain key; source installs use an owner-only local file. */
export class CredentialStore {
  constructor(
    private readonly path: string,
    private readonly key?: Buffer,
  ) {
    if (key && key.length !== 32) throw new Error('Invalid credential encryption key')
  }
  read(): RuntimeCredential | undefined {
    try {
      const envelope = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!this.key) return RuntimeCredentialSchema.parse(envelope)
      const decrypt = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'))
      decrypt.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return RuntimeCredentialSchema.parse(
        JSON.parse(
          Buffer.concat([
            decrypt.update(Buffer.from(envelope.data, 'base64')),
            decrypt.final(),
          ]).toString('utf8'),
        ),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error(
        'Saved SDK credentials could not be read. Restore access to your credential store.',
      )
    }
  }
  write(value: RuntimeCredential): void {
    const credential = RuntimeCredentialSchema.parse(value)
    let contents = JSON.stringify(credential)
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
}
