import { z } from 'zod'
import { PrivateStore } from './private-store.js'

export const RuntimeCredentialSchema = z
  .object({
    credentialId: z.string().trim().min(1).max(512),
    credentialSecret: z.string().trim().min(1).max(4096),
  })
  .strict()
export type RuntimeCredential = z.infer<typeof RuntimeCredentialSchema>

/** Desktop supplies an OS-keychain key; source installs use an owner-only local file. */
export class CredentialStore {
  private readonly store: PrivateStore<RuntimeCredential | { signedOut: true }>
  constructor(path: string, key?: Buffer) {
    this.store = new PrivateStore(
      path,
      z.union([RuntimeCredentialSchema, z.object({ signedOut: z.literal(true) }).strict()]),
      key,
    )
  }
  read(): RuntimeCredential | undefined {
    try {
      const value = this.store.read()
      return value && !('signedOut' in value) ? value : undefined
    } catch {
      throw new Error(
        'Saved SDK credentials could not be read. Restore access to your credential store.',
      )
    }
  }
  isSignedOut(): boolean {
    const value = this.store.read()
    return value !== undefined && 'signedOut' in value
  }
  write(value: RuntimeCredential): void {
    this.store.write(RuntimeCredentialSchema.parse(value))
  }
  clear(): void {
    // An explicit local credential clear must also suppress source-install environment credentials on restart.
    this.store.write({ signedOut: true })
  }
}

/** Retire the obsolete console session at its explicit app-owned path. SDK credentials are separate. */
export function clearRetiredAccountSession(path: string): void {
  new PrivateStore(path, z.unknown()).clear()
}
