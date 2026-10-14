import type { WidgetLayoutState } from '@tradescript/pro/sdk/trading'
import {
  arrangeWorkspacePreset,
  isWorkspacePresetId,
  WORKSPACE_PRESETS,
  type WorkspaceLayoutController,
} from './workspace-presets.js'

export const WORKSPACE_PROFILES_STORAGE_KEY = 'ibkr-terminal.workspace-profiles.v1'
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
export interface SavedWorkspaceProfile {
  readonly id: string
  readonly name: string
  readonly arrangement: WidgetLayoutState
}
export interface WorkspaceProfilesSnapshot {
  readonly selectedId: string
  readonly custom: readonly SavedWorkspaceProfile[]
  readonly ready: boolean
  readonly busy: boolean
  readonly dirty: boolean
  readonly error: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function arrangement(value: unknown): value is WidgetLayoutState {
  return (
    record(value) &&
    value.version === 1 &&
    record(value.dockview) &&
    (value.containerHeight === undefined ||
      (typeof value.containerHeight === 'number' && Number.isFinite(value.containerHeight)))
  )
}
function profile(value: unknown): value is SavedWorkspaceProfile {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    value.id.startsWith('custom:') &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 60 &&
    arrangement(value.arrangement)
  )
}
function clone(state: WidgetLayoutState): WidgetLayoutState {
  const result: unknown = JSON.parse(JSON.stringify(state))
  if (!arrangement(result)) throw new Error('The panel arrangement could not be saved.')
  return result
}

/** App-owned profiles. The broker and terminal lifetime never change when selecting a layout. */
export class WorkspaceProfiles {
  private snapshot: WorkspaceProfilesSnapshot = {
    selectedId: 'stocks',
    custom: [],
    ready: false,
    busy: false,
    dirty: false,
    error: '',
  }
  private readonly listeners = new Set<() => void>()
  private readonly drafts = new Map<string, WidgetLayoutState>()
  private readonly baselines = new Map<string, WidgetLayoutState>()
  private readonly editedDrafts = new Set<string>()
  private layout: WorkspaceLayoutController | undefined
  private host: Pick<HTMLDivElement, 'clientWidth' | 'clientHeight'> | undefined
  private availableWidgets: string[] = []
  private cancelArrangement?: () => void

  constructor(
    private readonly storage?: StoragePort,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    try {
      const raw = storage?.getItem(WORKSPACE_PROFILES_STORAGE_KEY)
      if (!raw) return
      const saved: unknown = JSON.parse(raw)
      if (
        !record(saved) ||
        saved.version !== 1 ||
        !Array.isArray(saved.custom) ||
        !saved.custom.every(profile) ||
        typeof saved.selectedId !== 'string'
      )
        throw new Error('Invalid saved layouts')
      const ids = new Set(saved.custom.map((item) => item.id))
      const names = new Set(saved.custom.map((item) => item.name.toLocaleLowerCase()))
      if (ids.size !== saved.custom.length || names.size !== saved.custom.length)
        throw new Error('Duplicate saved layouts')
      const selectedId =
        isWorkspacePresetId(saved.selectedId) || ids.has(saved.selectedId)
          ? saved.selectedId
          : 'stocks'
      this.snapshot = { ...this.snapshot, selectedId, custom: saved.custom }
    } catch {
      this.snapshot = {
        ...this.snapshot,
        error: 'Saved layouts could not be read. The Stocks preset is available.',
      }
    }
  }

  getSnapshot = (): WorkspaceProfilesSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(patch: Partial<WorkspaceProfilesSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  private persist(selectedId: string, custom = this.snapshot.custom): boolean {
    try {
      if (!this.storage) throw new Error('Storage is unavailable')
      this.storage.setItem(
        WORKSPACE_PROFILES_STORAGE_KEY,
        JSON.stringify({ version: 1, selectedId, custom }),
      )
      return true
    } catch {
      this.publish({
        error: 'Layouts could not be saved on this device. Free some storage and try again.',
      })
      return false
    }
  }

  connect(
    layout: WorkspaceLayoutController,
    host: Pick<HTMLDivElement, 'clientWidth' | 'clientHeight'>,
  ): () => void {
    this.cancelArrangement?.()
    this.layout = layout
    this.host = host
    this.availableWidgets = [...new Set(layout.listPanels().map((item) => item.widgetType))]
    this.apply(this.snapshot.selectedId)
    return () => {
      if (this.layout !== layout) return
      this.capture()
      this.cancelArrangement?.()
      this.layout = undefined
      this.host = undefined
      this.publish({ ready: false, busy: false })
    }
  }

  /** Called by the public SDK layout-change callback, including native splitter resizing. */
  capture = (): void => {
    if (!this.layout || this.snapshot.busy || !this.snapshot.ready) return
    const current = this.layout.savePanelArrangement()
    if (!current) return
    const baseline =
      this.baselines.get(this.snapshot.selectedId) ??
      this.snapshot.custom.find((item) => item.id === this.snapshot.selectedId)?.arrangement
    this.drafts.set(this.snapshot.selectedId, clone(current))
    const dirty = baseline !== undefined && JSON.stringify(current) !== JSON.stringify(baseline)
    if (dirty) this.editedDrafts.add(this.snapshot.selectedId)
    else this.editedDrafts.delete(this.snapshot.selectedId)
    if (dirty !== this.snapshot.dirty) this.publish({ dirty })
  }

  select = (id: string): void => {
    if (!this.layout || this.snapshot.busy || id === this.snapshot.selectedId) return
    if (!isWorkspacePresetId(id) && !this.snapshot.custom.some((item) => item.id === id)) return
    this.capture()
    this.apply(id)
  }

  private apply(id: string, reset = false) {
    const layout = this.layout
    const host = this.host
    if (!layout || !host) return
    const previous = layout.savePanelArrangement()
    const previousId = this.snapshot.selectedId
    this.cancelArrangement?.()
    this.publish({ busy: true })
    const custom = this.snapshot.custom.find((item) => item.id === id)
    const saved = (!reset ? this.drafts.get(id) : undefined) ?? custom?.arrangement
    const cleanSaved = custom !== undefined && (reset || !this.editedDrafts.has(id))
    const complete = () => {
      const current = layout.savePanelArrangement()
      // Restoring a saved arrangement lets the engine adapt it to the current viewport.
      // Its settled serialization becomes the comparison baseline without editing the payload.
      if (current && (cleanSaved || (!custom && (reset || !this.baselines.has(id)))))
        this.baselines.set(id, clone(current))
      this.publish({ selectedId: id, ready: true, busy: false })
      this.capture()
      if (this.persist(id)) this.publish({ error: '' })
    }
    try {
      if (saved) {
        if (!layout.loadPanelArrangement(clone(saved))) throw new Error('Layout rejected')
        const frames = new Set<number>()
        let stopped = false
        const settle = (remaining: number) => {
          let frame: number | undefined
          frame = requestAnimationFrame(() => {
            if (frame !== undefined) frames.delete(frame)
            if (stopped) return
            if (remaining > 0) settle(remaining - 1)
            else complete()
          })
          frames.add(frame)
        }
        this.cancelArrangement = () => {
          stopped = true
          for (const frame of frames) cancelAnimationFrame(frame)
        }
        settle(2)
      } else if (isWorkspacePresetId(id)) {
        this.cancelArrangement = arrangeWorkspacePreset(
          id,
          layout,
          host,
          this.availableWidgets,
          complete,
        )
      }
    } catch {
      if (previous) layout.loadPanelArrangement(previous)
      this.publish({
        selectedId: previousId,
        ready: true,
        busy: false,
        error: 'This layout could not be opened. Choose a preset or restore the saved layout.',
      })
    }
  }

  private validName(name: string, exceptId?: string): string | undefined {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 60) {
      this.publish({ error: 'Enter a layout name between 1 and 60 characters.' })
      return
    }
    const lower = trimmed.toLocaleLowerCase()
    if (
      WORKSPACE_PRESETS.some((item) => item.name.toLocaleLowerCase() === lower) ||
      this.snapshot.custom.some(
        (item) => item.id !== exceptId && item.name.toLocaleLowerCase() === lower,
      )
    ) {
      this.publish({ error: 'A layout already has that name. Choose another name.' })
      return
    }
    return trimmed
  }

  saveAs = (name: string): boolean => {
    if (!this.layout || !this.snapshot.ready || this.snapshot.busy) return false
    const valid = this.validName(name)
    const state = this.layout.savePanelArrangement()
    if (!valid || !state) return false
    const item = { id: `custom:${this.newId()}`, name: valid, arrangement: clone(state) }
    const custom = [...this.snapshot.custom, item]
    if (!this.persist(item.id, custom)) return false
    this.drafts.set(item.id, item.arrangement)
    this.baselines.set(item.id, item.arrangement)
    this.editedDrafts.delete(item.id)
    this.publish({ selectedId: item.id, custom, dirty: false, error: '' })
    return true
  }
  save = (): boolean => {
    if (!this.layout || this.snapshot.busy) return false
    const current = this.snapshot.custom.find((item) => item.id === this.snapshot.selectedId)
    const state = this.layout.savePanelArrangement()
    if (!current || !state) return false
    const custom = this.snapshot.custom.map((item) =>
      item.id === current.id ? { ...item, arrangement: clone(state) } : item,
    )
    if (!this.persist(current.id, custom)) return false
    this.baselines.set(current.id, clone(state))
    this.editedDrafts.delete(current.id)
    this.publish({ custom, dirty: false, error: '' })
    return true
  }
  rename = (name: string): boolean => {
    const current = this.snapshot.custom.find((item) => item.id === this.snapshot.selectedId)
    if (!current || this.snapshot.busy) return false
    const valid = this.validName(name, current.id)
    if (!valid) return false
    const custom = this.snapshot.custom.map((item) =>
      item.id === current.id ? { ...item, name: valid } : item,
    )
    if (!this.persist(current.id, custom)) return false
    this.publish({ custom, error: '' })
    return true
  }
  reset = (): void => {
    if (!this.layout || this.snapshot.busy) return
    this.drafts.delete(this.snapshot.selectedId)
    this.editedDrafts.delete(this.snapshot.selectedId)
    this.apply(this.snapshot.selectedId, true)
  }
  deleteCurrent = (): boolean => {
    const id = this.snapshot.selectedId
    if (!this.snapshot.custom.some((item) => item.id === id) || this.snapshot.busy || !this.layout)
      return false
    const custom = this.snapshot.custom.filter((item) => item.id !== id)
    if (!this.persist('stocks', custom)) return false
    this.drafts.delete(id)
    this.publish({ custom, error: '' })
    this.apply('stocks')
    return true
  }
}

export function createWorkspaceProfiles(): WorkspaceProfiles {
  try {
    return new WorkspaceProfiles(localStorage)
  } catch {
    return new WorkspaceProfiles()
  }
}
