import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { AppModal } from './appearance-ui.js'
import { WORKSPACE_PRESETS } from './workspace-presets.js'
import type { WorkspaceProfiles } from './workspace-profiles.js'

function LayoutIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="16" height="14" rx="2" />
      <path d="M7 3v14M14 3v14M7 12h7" />
    </svg>
  )
}

export function WorkspacePicker({ profiles }: { readonly profiles: WorkspaceProfiles }) {
  const state = useSyncExternalStore(profiles.subscribe, profiles.getSnapshot, profiles.getSnapshot)
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'save' | 'rename' | 'delete' | 'reset'>()
  const [name, setName] = useState('')
  const [dialogError, setDialogError] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const menuId = useId()
  const nameId = useId()
  const selectedCustom = state.custom.find((item) => item.id === state.selectedId)
  const selectedName =
    selectedCustom?.name ??
    WORKSPACE_PRESETS.find((item) => item.id === state.selectedId)?.name ??
    'Stocks'

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    if (dialog === 'save' || dialog === 'rename') {
      nameInput.current?.focus()
      nameInput.current?.select()
    }
  }, [dialog])

  const closeMenu = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const openDialog = (kind: NonNullable<typeof dialog>) => {
    closeMenu()
    setDialogError('')
    setName(kind === 'rename' ? selectedName : `${selectedName} custom`)
    setDialog(kind)
  }
  const submit = () => {
    const succeeded = dialog === 'rename' ? profiles.rename(name) : profiles.saveAs(name)
    if (succeeded) setDialog(undefined)
    else setDialogError(profiles.getSnapshot().error || 'The layout could not be saved.')
  }

  return (
    <>
      <div ref={container} className="workspace-picker">
        <button
          ref={trigger}
          type="button"
          className="workspace-picker-trigger"
          aria-label={`Layouts: ${selectedName}${state.dirty ? ', unsaved changes' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={!state.ready || state.busy}
          title="Switch or save your workspace layout"
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          <LayoutIcon />
          <span className="workspace-picker-name">{selectedName}</span>
          {state.dirty && <span className="workspace-dirty" aria-hidden="true" />}
          <span aria-hidden="true" className="workspace-chevron">
            ⌄
          </span>
        </button>
        {open && (
          <div
            ref={menu}
            id={menuId}
            className="workspace-picker-menu"
            role="dialog"
            aria-label="Layouts"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeMenu()
              }
            }}
          >
            <div className="workspace-picker-heading">
              <strong>Workspace layouts</strong>
              <span>Presets</span>
            </div>
            <div className="workspace-profile-list">
              {WORKSPACE_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className="workspace-profile-option"
                  aria-label={preset.name}
                  aria-pressed={state.selectedId === preset.id}
                  onClick={() => {
                    profiles.select(preset.id)
                    closeMenu()
                  }}
                >
                  <span className={`workspace-mini workspace-mini-${preset.id}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="workspace-profile-copy">
                    <strong>{preset.name}</strong>
                    <span>{preset.description}</span>
                  </span>
                  <span className="workspace-profile-check" aria-hidden="true">
                    {state.selectedId === preset.id ? '✓' : ''}
                  </span>
                </button>
              ))}
            </div>
            {state.custom.length > 0 && (
              <>
                <div className="workspace-picker-heading">
                  <span>My layouts</span>
                </div>
                <div className="workspace-profile-list workspace-custom-list">
                  {state.custom.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className="workspace-profile-option workspace-custom-option"
                      aria-label={item.name}
                      aria-pressed={state.selectedId === item.id}
                      onClick={() => {
                        profiles.select(item.id)
                        closeMenu()
                      }}
                    >
                      <LayoutIcon />
                      <span className="workspace-profile-copy">
                        <strong>{item.name}</strong>
                      </span>
                      <span className="workspace-profile-check" aria-hidden="true">
                        {state.selectedId === item.id ? '✓' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="workspace-profile-actions">
              <button type="button" onClick={() => openDialog('save')}>
                Save as new layout…
              </button>
              {selectedCustom && (
                <button
                  type="button"
                  disabled={!state.dirty}
                  onClick={() => {
                    profiles.save()
                    closeMenu()
                  }}
                >
                  Save changes
                </button>
              )}
              <button type="button" onClick={() => openDialog('reset')}>
                {selectedCustom ? 'Restore saved layout…' : 'Reset preset…'}
              </button>
              {selectedCustom && (
                <div className="workspace-profile-management">
                  <button type="button" onClick={() => openDialog('rename')}>
                    Rename…
                  </button>
                  <button type="button" onClick={() => openDialog('delete')}>
                    Delete…
                  </button>
                </div>
              )}
            </div>
            <p className="workspace-picker-hint">
              Drag tabs, resize panels, or use + to add tools. Save a copy to keep your arrangement
              on this device.
            </p>
          </div>
        )}
      </div>
      {state.error && !dialog && (
        <div className="workspace-profile-error" role="alert">
          {state.error}
        </div>
      )}
      <AppModal
        open={dialog !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setDialog(undefined)
            trigger.current?.focus()
          }
        }}
        title={
          dialog === 'rename'
            ? 'Rename layout'
            : dialog === 'delete'
              ? 'Delete layout'
              : dialog === 'reset'
                ? selectedCustom
                  ? 'Restore saved layout'
                  : 'Reset preset'
                : 'Save layout'
        }
        width="420px"
        boundary="viewport"
        contentClassName="workspace-layout-dialog"
        closeLabel="Close layout dialog"
        headerDensity="compact"
      >
        {dialog === 'save' || dialog === 'rename' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <p>
              {dialog === 'save'
                ? 'Save the current panels, tabs, and sizes as your own layout.'
                : 'Give this layout a new name.'}
            </p>
            <label htmlFor={nameId}>Layout name</label>
            <input
              ref={nameInput}
              id={nameId}
              value={name}
              maxLength={60}
              onChange={(event) => {
                setName(event.target.value)
                setDialogError('')
              }}
              autoComplete="off"
            />
            {dialogError && (
              <p className="workspace-dialog-error" role="alert">
                {dialogError}
              </p>
            )}
            <p className="workspace-dialog-note">
              Saved on this device. Session edits are kept while you switch layouts; use Save
              changes to keep them for next time.
            </p>
            <div className="workspace-dialog-actions">
              <button type="button" onClick={() => setDialog(undefined)}>
                Cancel
              </button>
              <button type="submit" className="workspace-primary" disabled={!name.trim()}>
                {dialog === 'rename' ? 'Rename' : 'Save layout'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <p>
              {dialog === 'delete'
                ? `Delete “${selectedName}”? You’ll return to the Stocks layout.`
                : selectedCustom
                  ? `Restore the last saved arrangement for “${selectedName}”? Current edits to this layout will be replaced.`
                  : `Reset “${selectedName}” to its original panels and sizes? Current edits to this preset will be replaced.`}
            </p>
            {dialogError && (
              <p className="workspace-dialog-error" role="alert">
                {dialogError}
              </p>
            )}
            <div className="workspace-dialog-actions">
              <button type="button" onClick={() => setDialog(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                className="workspace-primary"
                onClick={() => {
                  if (dialog === 'delete' && !profiles.deleteCurrent()) {
                    setDialogError(profiles.getSnapshot().error)
                    return
                  }
                  if (dialog === 'reset') profiles.reset()
                  setDialog(undefined)
                }}
              >
                {dialog === 'delete'
                  ? 'Delete layout'
                  : selectedCustom
                    ? 'Restore layout'
                    : 'Reset preset'}
              </button>
            </div>
          </>
        )}
      </AppModal>
    </>
  )
}
