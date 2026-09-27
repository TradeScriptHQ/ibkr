import { isTauri } from '@tauri-apps/api/core'
import { StandardModal } from '@tradescript/pro/react/ui'
import { useState } from 'react'

const documents = [
  ['Software licences', 'DISTRIBUTION.md'],
  ['Data and services', 'DATA.md'],
  ['Terminal licence', 'TERMINAL-LICENSE.txt'],
  ['SDK licence', 'SDK-LICENSE'],
  ['SDK third-party notices', 'SDK-THIRD_PARTY_NOTICES.md'],
  ['Runtime third-party notices', 'THIRD-PARTY-NOTICES.txt'],
  ['Node licence', 'NODE-LICENSE.txt'],
] as const
export function LegalNotices() {
  const [document, setDocument] = useState<{ title: string; contents: string }>()
  if (!isTauri()) return null
  const open = async (title: string, file: string) => {
    setDocument({ title, contents: 'Loading…' })
    try {
      const response = await fetch(`/legal/${file}`)
      if (!response.ok) throw new Error('missing')
      setDocument({ title, contents: await response.text() })
    } catch {
      setDocument({ title, contents: 'This document is unavailable in this build.' })
    }
  }
  return (
    <>
      <details className="setup-notices">
        <summary>Licences and data information</summary>
        {documents.map(([title, file]) => (
          <button type="button" key={file} onClick={() => void open(title, file)}>
            {title}
          </button>
        ))}
      </details>
      <StandardModal
        open={!!document}
        onOpenChange={(value) => {
          if (!value) setDocument(undefined)
        }}
        title={document?.title ?? 'Legal notices'}
        width="700px"
        headerDensity="compact"
      >
        <pre className="legal-document">{document?.contents}</pre>
      </StandardModal>
    </>
  )
}
