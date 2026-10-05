import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'

interface NotificationContent {
  readonly message: string
  /** New explicit attempts can report the same result after an earlier dismissal. */
  readonly occurrence?: number | undefined
  readonly title?: string | undefined
  readonly tone: 'error' | 'warning' | 'success' | 'info'
  readonly action?:
    | {
        readonly label: string
        readonly onClick: () => void
        readonly disabled?: boolean
      }
    | undefined
}
interface AppNotificationEntry extends NotificationContent {
  readonly id: string
}

/** One owner for app feedback; SDK notifications retain their own public contract. */
export function createAppNotificationStore() {
  let entries: readonly AppNotificationEntry[] = []
  const dismissed = new Map<string, string>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const signature = (content: NotificationContent) =>
    JSON.stringify([content.tone, content.title, content.message, content.occurrence])
  const removeEntry = (id: string) => {
    const next = entries.filter((entry) => entry.id !== id)
    if (next.length === entries.length) return
    entries = next
    emit()
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => entries,
    publish(id: string, content: NotificationContent) {
      if (dismissed.get(id) === signature(content)) return
      dismissed.delete(id)
      const entry = { ...content, id }
      const index = entries.findIndex((item) => item.id === id)
      entries =
        index < 0 ? [...entries, entry] : entries.map((item, i) => (i === index ? entry : item))
      emit()
    },
    remove(id: string) {
      dismissed.delete(id)
      removeEntry(id)
    },
    dismiss(id: string) {
      const entry = entries.find((item) => item.id === id)
      if (entry) dismissed.set(id, signature(entry))
      removeEntry(id)
    },
  }
}

type AppNotificationStore = ReturnType<typeof createAppNotificationStore>
const NotificationContext = createContext<AppNotificationStore | undefined>(undefined)

function useNotificationStore(): AppNotificationStore {
  const store = useContext(NotificationContext)
  if (!store) throw new Error('The app notification provider is missing.')
  return store
}

/** Feedback stays in the viewport even when its originating dialog closes. */
export function AppNotification({
  message,
  title,
  tone = 'error',
  action,
  occurrence,
}: Omit<NotificationContent, 'tone'> & { readonly tone?: NotificationContent['tone'] }) {
  const store = useNotificationStore()
  const id = useId()
  useEffect(() => {
    if (message) store.publish(id, { message, title, tone, action, occurrence })
    else store.remove(id)
  }, [store, id, message, title, tone, action, occurrence])
  useEffect(() => () => store.remove(id), [store, id])
  return null
}

function AppNotificationViewport() {
  const store = useNotificationStore()
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return createPortal(
    <section className="app-notifications" aria-label="Notifications" tabIndex={-1}>
      {entries.map((entry) => (
        <div className="app-notification" data-tone={entry.tone} key={entry.id}>
          <div
            role={entry.tone === 'error' || entry.tone === 'warning' ? 'alert' : 'status'}
            aria-atomic="true"
          >
            {entry.title && <strong>{entry.title}</strong>}
            <p>{entry.message}</p>
          </div>
          <button
            className="app-notification-dismiss"
            type="button"
            aria-label="Dismiss notification"
            onClick={() => store.dismiss(entry.id)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
          {entry.action && (
            <button
              className="app-notification-action"
              type="button"
              disabled={entry.action.disabled}
              onClick={entry.action.onClick}
            >
              {entry.action.label}
            </button>
          )}
        </div>
      ))}
    </section>,
    document.body,
  )
}

export function AppNotificationsProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createAppNotificationStore)
  return (
    <NotificationContext.Provider value={store}>
      {children}
      <AppNotificationViewport />
    </NotificationContext.Provider>
  )
}
