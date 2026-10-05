export const WORKSTATION_STARTUP_STAGES = [
  { id: 'setup', message: 'Checking saved setup…' },
  { id: 'authorization', message: 'Authorizing workstation…' },
  { id: 'connection', message: 'Checking broker connection…' },
  { id: 'sdk', message: 'Loading trading tools…' },
  { id: 'watchlist', message: 'Loading your watchlist…' },
  { id: 'instrument', message: 'Loading your selected instrument…' },
  { id: 'workspace', message: 'Preparing the workspace…' },
  { id: 'account', message: 'Synchronizing your account…' },
] as const

type StartupStage = (typeof WORKSTATION_STARTUP_STAGES)[number]['id']

export interface WorkstationSetupState {
  readonly ready: boolean
  readonly stage: 'setup' | 'authorization'
  readonly error: string
  readonly retry: () => Promise<void>
}

export interface WorkstationLoadingState {
  readonly state: 'loading'
  readonly message: string
  readonly progress: {
    readonly stage: StartupStage
    readonly completed: number
    readonly total: number
  }
}

/** Progress counts completed startup stages; it does not estimate elapsed time. */
export function workstationLoading(stage: StartupStage, message?: string): WorkstationLoadingState {
  const completed = WORKSTATION_STARTUP_STAGES.findIndex((item) => item.id === stage)
  const definition = WORKSTATION_STARTUP_STAGES[completed]
  if (!definition) throw new Error('Unknown workstation startup stage.')
  return {
    state: 'loading',
    message: message ?? definition.message,
    progress: { stage, completed, total: WORKSTATION_STARTUP_STAGES.length },
  }
}
