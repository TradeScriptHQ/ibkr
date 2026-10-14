import type { WidgetLayoutState } from '@tradescript/pro/sdk/trading'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceLayoutController } from './workspace-presets.js'
import { WORKSPACE_PROFILES_STORAGE_KEY, WorkspaceProfiles } from './workspace-profiles.js'

vi.mock('./workspace-presets.js', async (loadOriginal) => {
  const actual = await loadOriginal<typeof import('./workspace-presets.js')>()
  return {
    ...actual,
    arrangeWorkspacePreset: (
      _id: string,
      _layout: unknown,
      _host: unknown,
      _available: unknown,
      complete: () => void,
    ) => {
      let stopped = false
      queueMicrotask(() => {
        if (!stopped) complete()
      })
      return () => {
        stopped = true
      }
    },
  }
})

function harness(initial?: string) {
  const values = new Map<string, string>(initial ? [[WORKSPACE_PROFILES_STORAGE_KEY, initial]] : [])
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
  let current: WidgetLayoutState = { version: 1, dockview: { fixture: 'initial' } }
  const layout: WorkspaceLayoutController = {
    listPanels: () => [],
    addWidget: () => undefined,
    closePanel: () => true,
    restorePanel: () => true,
    movePanel: () => true,
    resizePanel: () => true,
    activatePanel: () => true,
    savePanelArrangement: () => current,
    loadPanelArrangement: vi.fn((state) => {
      current = state
      return true
    }),
  }
  let id = 0
  const profiles = new WorkspaceProfiles(storage, () => String(++id))
  const connect = async () => {
    const disconnect = profiles.connect(layout, { clientWidth: 1_728, clientHeight: 1_080 })
    await Promise.resolve()
    return disconnect
  }
  const edit = (value: string) => {
    current = { version: 1, dockview: { fixture: value } }
    profiles.capture()
  }
  return { storage, values, layout, profiles, connect, edit, current: () => current }
}

describe('workspace profiles', () => {
  beforeEach(() => {
    let frame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      // A deterministic completed layout pass; browser tests exercise real animation frames.
      callback(++frame)
      return frame
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => vi.unstubAllGlobals())
  it('saves the actual panel arrangement and reopens the selected custom layout after reload', async () => {
    const app = harness()
    await app.connect()
    app.edit('resized-with-extra-tabs')
    expect(app.profiles.saveAs(' My desk ')).toBe(true)
    expect(app.profiles.getSnapshot()).toMatchObject({
      selectedId: 'custom:1',
      dirty: false,
      custom: [{ name: 'My desk' }],
    })
    const restored = harness(app.values.get(WORKSPACE_PROFILES_STORAGE_KEY))
    await restored.connect()
    expect(restored.current()).toEqual(app.current())
    expect(restored.profiles.getSnapshot()).toMatchObject({
      selectedId: 'custom:1',
      dirty: false,
      ready: true,
    })
  })

  it('keeps unsaved edits while switching and only persists them on Save changes', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    const saved = app.values.get(WORKSPACE_PROFILES_STORAGE_KEY)
    app.edit('unsaved-split')
    expect(app.profiles.getSnapshot().dirty).toBe(true)
    app.profiles.select('options')
    await Promise.resolve()
    app.profiles.select('custom:1')
    expect(app.current().dockview).toEqual({ fixture: 'unsaved-split' })
    expect(app.profiles.getSnapshot().dirty).toBe(true)
    expect(app.values.get(WORKSPACE_PROFILES_STORAGE_KEY)).toBe(saved)
    expect(app.profiles.save()).toBe(true)
    expect(app.profiles.getSnapshot().dirty).toBe(false)
    const restored = harness(app.values.get(WORKSPACE_PROFILES_STORAGE_KEY))
    await restored.connect()
    expect(restored.current().dockview).toEqual({ fixture: 'unsaved-split' })
  })

  it('restores the last explicitly saved version of a custom layout', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    app.edit('unsaved')
    app.profiles.reset()
    expect(app.current().dockview).toEqual({ fixture: 'initial' })
    expect(app.profiles.getSnapshot().dirty).toBe(false)
  })

  it('treats engine normalization during restore as the clean baseline', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    const restored = harness(app.values.get(WORKSPACE_PROFILES_STORAGE_KEY))
    const load = restored.layout.loadPanelArrangement
    vi.mocked(load).mockImplementation((state) => {
      restored.layout.savePanelArrangement = () => ({
        ...state,
        dockview: { normalizedFixture: true },
      })
      return true
    })
    await restored.connect()
    restored.profiles.capture()
    expect(restored.profiles.getSnapshot().dirty).toBe(false)
  })

  it('renames without losing the arrangement or current unsaved edits', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    app.edit('draft')
    expect(app.profiles.rename('Swing desk')).toBe(true)
    expect(app.profiles.getSnapshot()).toMatchObject({
      dirty: true,
      custom: [{ name: 'Swing desk', arrangement: { dockview: { fixture: 'initial' } } }],
    })
    expect(app.current().dockview).toEqual({ fixture: 'draft' })
  })

  it('removes only the selected custom profile and returns to Stocks', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('First')
    app.profiles.saveAs('Second')
    expect(app.profiles.deleteCurrent()).toBe(true)
    await Promise.resolve()
    expect(app.profiles.getSnapshot()).toMatchObject({
      selectedId: 'stocks',
      custom: [{ name: 'First' }],
    })
    expect(app.profiles.deleteCurrent()).toBe(false)
  })

  it.each(['', '   ', 'x'.repeat(61), 'Options', ' stocks '])(
    'rejects invalid or reserved names: %j',
    async (name) => {
      const app = harness()
      await app.connect()
      expect(app.profiles.saveAs(name)).toBe(false)
      expect(app.profiles.getSnapshot().custom).toEqual([])
      expect(app.profiles.getSnapshot().error).not.toBe('')
    },
  )

  it('rejects duplicate names case-insensitively, including renames', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    expect(app.profiles.saveAs(' desk ')).toBe(false)
    app.profiles.saveAs('Other')
    expect(app.profiles.rename('DESK')).toBe(false)
    expect(app.profiles.rename('Other')).toBe(true)
  })

  it.each([
    '{broken',
    '{"version":2,"selectedId":"stocks","custom":[]}',
    '{"version":1,"selectedId":"stocks","custom":[{"id":"custom:1","name":"Desk","arrangement":{"version":1,"dockview":null}}]}',
  ])('recovers from unsupported or corrupted storage', (saved) => {
    const app = harness(saved)
    expect(app.profiles.getSnapshot()).toMatchObject({
      selectedId: 'stocks',
      custom: [],
      ready: false,
    })
    expect(app.profiles.getSnapshot().error).toContain('could not be read')
  })

  it('does not pretend a quota-failed save, rename, or delete succeeded', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    app.edit('draft')
    app.storage.setItem.mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    expect(app.profiles.save()).toBe(false)
    expect(app.profiles.saveAs('New desk')).toBe(false)
    expect(app.profiles.rename('Renamed')).toBe(false)
    expect(app.profiles.deleteCurrent()).toBe(false)
    expect(app.profiles.getSnapshot()).toMatchObject({
      selectedId: 'custom:1',
      dirty: true,
      custom: [{ name: 'Desk' }],
    })
    expect(app.profiles.getSnapshot().error).toContain('could not be saved')
  })

  it('keeps the current layout and selection if the SDK rejects a saved arrangement', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    app.profiles.select('options')
    await Promise.resolve()
    vi.mocked(app.layout.loadPanelArrangement).mockReturnValueOnce(false)
    app.profiles.select('custom:1')
    expect(app.profiles.getSnapshot()).toMatchObject({
      selectedId: 'options',
      ready: true,
      busy: false,
    })
    expect(app.profiles.getSnapshot().error).toContain('could not be opened')
  })

  it('cancels pending arrangement work and disables actions after disconnect', async () => {
    const app = harness()
    const stop = app.profiles.connect(app.layout, { clientWidth: 1_728, clientHeight: 1_080 })
    stop()
    await Promise.resolve()
    expect(app.profiles.getSnapshot()).toMatchObject({ ready: false, busy: false })
    expect(app.profiles.saveAs('Desk')).toBe(false)
    app.profiles.select('options')
    expect(app.profiles.getSnapshot().selectedId).toBe('stocks')
  })

  it('captures a fresh arrangement before switching even when the SDK callback is still debounced', async () => {
    const app = harness()
    await app.connect()
    app.profiles.saveAs('Desk')
    vi.mocked(app.layout.loadPanelArrangement)({
      version: 1,
      dockview: { fixture: 'last-second-resize' },
    })
    app.profiles.select('portfolio')
    await Promise.resolve()
    app.profiles.select('custom:1')
    expect(app.current().dockview).toEqual({ fixture: 'last-second-resize' })
  })
})
