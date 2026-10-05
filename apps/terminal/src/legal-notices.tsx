import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { AppNotification } from './app-notifications.js'
import { AppModal } from './appearance-ui.js'
import { APP_LOGO, APP_NAME } from './branding.js'
import { LEGAL_DOCUMENTS } from './legal-documents.js'

const OPEN_ABOUT = 'terminal:about'

export function AboutDialog() {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState<string>()
  const [document, setDocument] = useState<{
    title: string
    file: string
    contents: string
    requestId: number
    error?: string
  }>()
  const documentRequest = useRef(0)
  const desktop = isTauri()
  useEffect(() => {
    if (!desktop) return
    let active = true
    void getVersion()
      .then((value) => {
        if (active) setVersion(value)
      })
      .catch(() => console.warn('The application version could not be read.'))
    const show = () => {
      setDocument(undefined)
      setOpen(true)
    }
    window.addEventListener(OPEN_ABOUT, show)
    return () => {
      active = false
      window.removeEventListener(OPEN_ABOUT, show)
    }
  }, [desktop])
  if (!desktop) return null

  const readDocument = async (title: string, file: string) => {
    const requestId = ++documentRequest.current
    setDocument({ title, file, contents: 'Loading…', requestId })
    let result: { contents: string; error?: string }
    try {
      const response = await fetch(`/legal/${file}`)
      if (!response.ok) throw new Error('missing')
      result = { contents: await response.text() }
    } catch {
      result = { contents: '', error: 'This document is unavailable in this build.' }
    }
    setDocument((current) =>
      current?.requestId === requestId ? { ...current, ...result } : current,
    )
  }

  return (
    <>
      <AppNotification message={document?.error ?? ''} occurrence={document?.requestId} />
      <AppModal
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) setDocument(undefined)
        }}
        title={document?.title ?? `About ${APP_NAME}`}
        width="700px"
        boundary="viewport"
        contentClassName="about-dialog-body"
        closeLabel="Close About"
        headerDensity="compact"
      >
        {document ? (
          <>
            <button className="about-back" type="button" onClick={() => setDocument(undefined)}>
              Back to About
            </button>
            {!document.error && <pre className="legal-document">{document.contents}</pre>}
          </>
        ) : (
          <>
            <div className="about-app">
              <img className="brand-mark" src={APP_LOGO} alt="" />
              <div>
                <strong>{APP_NAME}</strong>
                {version && <span className="about-version">Version {version}</span>}
              </div>
            </div>
            <section className="about-notices" aria-label="Licences">
              <h4>Licences</h4>
              {LEGAL_DOCUMENTS.map(([title, file]) => (
                <button type="button" key={file} onClick={() => void readDocument(title, file)}>
                  {title}
                </button>
              ))}
            </section>
          </>
        )}
      </AppModal>
    </>
  )
}
