import type {
  SymbolInfo,
  TradingOrderDuration,
  TradingOrderTypeRule,
  TradingTicketSettings,
} from '@tradescript/pro/sdk'

export const SUPPORTED_ORDER_RULES: TradingOrderTypeRule[] = [
  { type: 'market', label: 'MKT' },
  { type: 'limit', label: 'LMT', requiresLimitPrice: true },
  { type: 'midprice', label: 'MIDPRICE', requiresLimitPrice: true },
  { type: 'market-to-limit', label: 'MTL' },
  { type: 'stop', label: 'STP', requiresStopPrice: true },
  { type: 'stop-limit', label: 'STP LMT', requiresLimitPrice: true, requiresStopPrice: true },
  { type: 'trailing-stop', label: 'TRAIL', requiresStopPrice: true, requiresTrailPercent: true },
  {
    type: 'trailing-stop-limit',
    label: 'TRAIL LIMIT',
    requiresLimitPrice: true,
    requiresStopPrice: true,
    requiresTrailPercent: true,
    limitPriceLabel: 'Limit Offset',
  },
  { type: 'peg-mid', label: 'PEG MID', requiresLimitPrice: true },
  { type: 'market-on-close', label: 'MOC' },
  { type: 'limit-on-close', label: 'LOC', requiresLimitPrice: true },
  { type: 'adaptive', label: 'Adaptive (IBALGO)', requiresLimitPrice: true },
  { type: 'ib-algo', label: 'IBALGO', requiresLimitPrice: true },
]

export const OPTION_ORDER_RULES: TradingOrderTypeRule[] = [
  { type: 'market', label: 'MKT' },
  { type: 'limit', label: 'LMT', requiresLimitPrice: true },
]

/** IBKR's crypto order matrix differs by side: market buys use cashQty; market sells use units. */
export const CRYPTO_ORDER_RULES: TradingOrderTypeRule[] = [
  { type: 'market', label: 'MKT' },
  { type: 'limit', label: 'LMT', requiresLimitPrice: true },
]

export const CRYPTO_DURATIONS: TradingOrderDuration[] = [
  { type: 'day', label: 'DAY', supportedOrderTypes: ['limit'] },
  { type: 'gtc', label: 'GTC', supportedOrderTypes: ['limit'] },
  { type: 'ioc', label: 'IOC', supportedOrderTypes: ['market', 'limit'] },
]

export const ALPACA_ORDER_RULES: TradingOrderTypeRule[] = [
  { type: 'market', label: 'MKT' },
  { type: 'limit', label: 'LMT', requiresLimitPrice: true },
  { type: 'stop', label: 'STP', requiresStopPrice: true },
  { type: 'stop-limit', label: 'STP LMT', requiresLimitPrice: true, requiresStopPrice: true },
  { type: 'trailing-stop', label: 'TRAIL', requiresStopPrice: true, requiresTrailPercent: true },
]

export const SUPPORTED_ORDER_TYPES = SUPPORTED_ORDER_RULES.map((rule) => rule.type)

export const OPTION_ORDER_TYPES = OPTION_ORDER_RULES.map((rule) => rule.type)

export const IBKR_ORDER_TICKET_CUSTOM_FIELDS = [
  {
    id: 'outsideRth',
    type: 'checkbox' as const,
    label: 'Fill order outside RTH',
    defaultValue: false,
  },
  {
    id: 'takeProfitOutsideRth',
    type: 'checkbox' as const,
    label: 'Fill take profit outside RTH',
    defaultValue: false,
  },
]

export const IBKR_ICEBERG_TICKET_SETTINGS: TradingTicketSettings = {
  fieldLayout: {
    sections: [
      {
        id: 'ibkr-order-display',
        placement: 'order-options' as const,
        columns: 3 as const,
        fields: [
          {
            id: 'orderVisibility',
            columnSpan: 2 as const,
            kind: 'checkbox' as const,
            label: 'Iceberg',
            inlineLabel: true,
            checkedValue: 'iceberg',
            uncheckedValue: 'visible',
            showLabel: false,
            binding: { target: 'customFields' as const, field: 'orderVisibility' },
            defaultValue: 'visible',
          },
          {
            id: 'displaySize',
            kind: 'quantity' as const,
            label: 'Displayed quantity',
            showLabel: false,
            placeholder: 'Qty',
            showRequiredMessage: false,
            binding: { target: 'customFields' as const, field: 'displaySize' },
            min: 1,
            step: 1,
            enabledWhen: {
              source: 'customField' as const,
              field: 'orderVisibility',
              equals: 'iceberg',
            },
            requiredWhen: {
              source: 'customField' as const,
              field: 'orderVisibility',
              equals: 'iceberg',
            },
            validations: [
              {
                operator: 'lt' as const,
                other: { target: 'draft' as const, field: 'quantity' as const },
                message: 'Displayed quantity must be smaller than total quantity.',
              },
            ],
          },
        ],
      },
    ],
  },
}

export const SUPPORTED_DURATIONS = [
  { type: 'day' as const, label: 'DAY' },
  { type: 'gtc' as const, label: 'GTC' },
  {
    type: 'gtd' as const,
    label: 'GTD',
    hasDatePicker: true,
    hasTimePicker: true,
    supportedOrderTypes: SUPPORTED_ORDER_TYPES.filter(
      (type) => type !== 'market' && type !== 'market-on-close',
    ),
  },
]

export function supportsIbkrIceberg(
  symbol: SymbolInfo,
  defaultRoutingDestination?: string,
): boolean {
  const exchange = (defaultRoutingDestination ?? symbol.exchange)?.trim().toUpperCase() || 'SMART'
  return symbol.type === 'stock' && symbol.currency?.toUpperCase() === 'USD' && exchange === 'SMART'
}

export function brokerSessionPath(symbol: SymbolInfo): string {
  const params = new URLSearchParams({ symbol: symbol.brokerSymbol ?? symbol.ticker })
  if (symbol.exchange) params.set('exchange', symbol.exchange)
  if (symbol.listedExchange) params.set('primaryExchange', symbol.listedExchange)
  if (symbol.currency) params.set('currency', symbol.currency)
  if (symbol.type) params.set('assetClass', symbol.type)
  return `/sessions?${params.toString()}`
}

export function priceStepFromSymbol(symbol: SymbolInfo): number | undefined {
  const tickSize = positiveStep(symbol.tickSize)
  if (tickSize !== undefined) return tickSize
  const minMove = positiveStep(symbol.minMove)
  const pricescale = positiveStep(symbol.pricescale)
  return minMove !== undefined && pricescale !== undefined
    ? positiveStep(minMove / pricescale)
    : undefined
}

export function positiveStep(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}
