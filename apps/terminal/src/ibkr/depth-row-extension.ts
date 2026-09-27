import type {
  MarketDepthLevelExtensionContext,
  TradeScriptDomExtension,
} from '@tradescript/pro/sdk'

/** Add coverage information while retaining the SDK's own quote row. */
export function createDepthRowExtension() {
  const coverage = 'Best bid/ask only · Level II unavailable'
  let message = coverage
  let diagnostic = ''
  const notices = new Set<HTMLElement>()
  const extension: TradeScriptDomExtension<MarketDepthLevelExtensionContext> = {
    mount(container, initial) {
      const notice = document.createElement('div')
      notice.className = 'ibkr-depth-coverage'
      notice.setAttribute('role', 'status')
      const row = document.createElement('div')
      container.append(notice, row)
      const content = initial.defaultContent.mount(row)
      notices.add(notice)
      const update = (context: MarketDepthLevelExtensionContext) => {
        notice.hidden =
          context.index !== 0 ||
          (context.bid?.tier !== 'Top of book' && context.ask?.tier !== 'Top of book')
        notice.textContent = message
        notice.title = diagnostic
      }
      update(initial)
      return {
        update,
        destroy() {
          notices.delete(notice)
          content.destroy()
          notice.remove()
          row.remove()
        },
      }
    },
  }
  return {
    extension,
    setMessage(value: string) {
      diagnostic = value
      message = value.startsWith('Best bid/ask only') ? value : coverage
      for (const notice of notices) {
        notice.textContent = message
        notice.title = diagnostic
      }
    },
  }
}
