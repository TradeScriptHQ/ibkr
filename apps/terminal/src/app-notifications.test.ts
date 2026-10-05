import { describe, expect, it } from 'vitest'
import { createAppNotificationStore } from './app-notifications.js'

describe('app notification ownership', () => {
  it('keeps independent app messages in one stack and updates a repeated source in place', () => {
    const store = createAppNotificationStore()
    store.publish('agent', { message: 'Agent settings unavailable.', tone: 'error' })
    store.publish('connection', { message: 'Connection unavailable.', tone: 'error' })
    store.publish('agent', { message: 'Agent settings unavailable.', tone: 'error' })
    expect(store.getSnapshot().map((item) => item.id)).toEqual(['agent', 'connection'])
    store.publish('agent', { message: 'Agent settings restored.', tone: 'success' })
    expect(store.getSnapshot()[0]?.message).toBe('Agent settings restored.')
    store.remove('connection')
    expect(store.getSnapshot()).toHaveLength(1)
  })

  it('keeps dismissed polling failures quiet until the condition resolves or changes', () => {
    const store = createAppNotificationStore()
    const failure = { message: 'Agent settings unavailable.', tone: 'error' as const }
    store.publish('agent', failure)
    store.dismiss('agent')
    store.publish('agent', { ...failure })
    expect(store.getSnapshot()).toEqual([])
    store.publish('agent', { ...failure, message: 'Agent update failed.' })
    expect(store.getSnapshot()).toHaveLength(1)
    store.dismiss('agent')
    store.remove('agent')
    store.publish('agent', failure)
    expect(store.getSnapshot()).toHaveLength(1)
  })

  it('publishes the current action without reviving a dismissed identical message', () => {
    const store = createAppNotificationStore()
    let revision = 0
    const notification = (value: number) => ({
      message: 'Retry connection.',
      tone: 'error' as const,
      action: {
        label: 'Retry',
        onClick: () => {
          revision = value
        },
      },
    })
    store.publish('connection', notification(1))
    store.publish('connection', notification(2))
    store.getSnapshot()[0]?.action?.onClick()
    expect(revision).toBe(2)
    store.dismiss('connection')
    store.publish('connection', notification(3))
    expect(store.getSnapshot()).toEqual([])
  })

  it('shows the same failure again for a new explicit attempt after dismissal', () => {
    const store = createAppNotificationStore()
    const failure = { message: 'Connection failed.', tone: 'error' as const, occurrence: 1 }
    store.publish('connection', failure)
    store.dismiss('connection')
    store.publish('connection', { ...failure, occurrence: 2 })
    expect(store.getSnapshot()).toHaveLength(1)
  })
})
