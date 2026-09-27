export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export type OrderSide = 'buy' | 'sell'
export type PositionEffect = 'open' | 'close'
export type OrderType =
  | 'market'
  | 'limit'
  | 'midprice'
  | 'market-to-limit'
  | 'stop'
  | 'stop-limit'
  | 'trailing-stop'
  | 'trailing-stop-limit'
  | 'relative'
  | 'retail-price-improvement'
  | 'peg-mid'
  | 'peg-best'
  | 'snap-market'
  | 'snap-mid'
  | 'snap-primary'
  | 'market-on-close'
  | 'limit-on-close'
  | 'adaptive'
  | 'ib-algo'
export type OrderDuration =
  | 'day'
  | 'gtc'
  | 'gtd'
  | 'ioc'
  | 'fok'
  | 'opg'
  | 'overnight-day'
  | 'overnight'
export type OrderStatus =
  | 'placing'
  | 'pre-submitted'
  | 'working'
  | 'partially-filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'inactive'

export interface AccountSummary {
  id: string
  label: string
  currency: string
  netLiquidation?: number | undefined
  buyingPower?: number | undefined
  availableFunds?: number | undefined
  marginUsed?: number | undefined
  maintenanceMargin?: number | undefined
  cash?: number | undefined
  dailyPnl?: number | undefined
  unrealizedPnl?: number | undefined
  realizedPnl?: number | undefined
}

/** Complete JSON-safe SDK descriptor; known identity fields are indexed without dropping the rest. */
export interface SourceSymbolIdentity {
  ticker: string
  [key: string]: unknown
  canonicalSymbol?: string | undefined
  brokerSymbol?: string | undefined
  provider?: string | undefined
  selectionId?: string | undefined
  marketDataSeriesId?: string | undefined
  exchange?: string | undefined
  listedExchange?: string | undefined
  currency?: string | undefined
  type?: string | undefined
  marketType?: string | undefined
  resolveRevision?: string | undefined
}

export interface BrokerSymbol {
  symbol: string
  canonicalSymbol?: string | undefined
  exchange?: string | undefined
  currency?: string | undefined
  assetClass?: string | undefined
  primaryExchange?: string | undefined
  /** Route-specific price increments returned by TWS reqMarketRule. */
  priceIncrements?: PriceIncrementBand[] | undefined
  sourceSymbol?: SourceSymbolIdentity | undefined
  /** Broker readback identity, including instruments not yet enabled for trading. */
  contractIdentity?:
    | {
        securityType: string
        conId?: number | undefined
        localSymbol?: string | undefined
        expiry?: string | undefined
        tradingClass?: string | undefined
        multiplier?: number | undefined
        strike?: number | undefined
        right?: string | undefined
      }
    | undefined
}

export interface PriceIncrementBand {
  /** Inclusive lower price bound for this increment. */
  lowEdge: number
  increment: number
}

export interface OrderDraft {
  accountId?: string | undefined
  symbol: BrokerSymbol
  side: OrderSide
  type: OrderType
  brokerOrderTypeId?: string | undefined
  duration: OrderDuration
  durationDateTime?: number | undefined
  /** Instrument units. Zero for broker-native cash-quantity orders. */
  quantity: number
  /** Broker-native cash amount, currently used for cryptocurrency market buys. */
  cashQuantity?: number | undefined
  limitPrice?: number | undefined
  stopPrice?: number | undefined
  trailPercent?: number | undefined
  trailingStopPips?: number | undefined
  relativeOffset?: number | undefined
  postOnly?: boolean | undefined
  /** Execution venue selected independently from the instrument listing exchange. */
  routingDestination?: string | undefined
  /** Requires the complete order quantity to fill in one execution. */
  allOrNone?: boolean | undefined
  /** General One-Cancels-All group and IBKR execution behavior. */
  oca?: OrderOcaSelection | undefined
  /** Publicly disclosed share quantity for an IBKR Iceberg order. */
  displaySize?: number | undefined
  stopType?: 'stop-loss' | 'trailing-stop' | 'guaranteed-stop' | undefined
  guaranteedStop?: boolean | undefined
  hidden?: boolean | undefined
  outsideRth?: boolean | undefined
  takeProfitOutsideRth?: boolean | undefined
  ocaGroup?: string | undefined
  ocaType?: number | undefined
  exits?: OrderExitPlan | null | undefined
  parentId?: string | undefined
  parentType?: 'order' | undefined
  bracketGroupId?: string | undefined
  exitLevelId?: string | undefined
  optionLegs?: OptionOrderLegDraft[] | undefined
  strategyLegs?: StrategyOrderLegDraft[] | undefined
  confirmId?: string | undefined
  customFields?: Record<string, unknown> | undefined
}

export type OrderOcaBehavior = 'cancel-with-block' | 'reduce-with-block' | 'reduce-without-block'

export interface OrderOcaSelection {
  groupId: string
  behavior: OrderOcaBehavior
}

export type OrderPatch = Omit<Partial<OrderDraft>, 'oca' | 'displaySize'> & {
  /** `null` removes the order from its current OCA group. */
  oca?: OrderOcaSelection | null | undefined
  /** `null` returns an existing Iceberg order to fully displayed. */
  displaySize?: number | null | undefined
}

export interface OrderExitPlan {
  levels: OrderExitLevel[]
}

export interface OrderExitLevel {
  id: string
  quantity: number
  takeProfit?: { price: number } | undefined
  stopLoss?: OrderProtectiveStop | undefined
}

export type OrderProtectiveStop =
  | { kind: 'fixed'; triggerPrice: number; limitPrice?: number | undefined }
  | { kind: 'trailing'; trailingPips: number }
  | { kind: 'guaranteed'; triggerPrice: number }

export interface OptionContract {
  underlying: string
  underlyingSymbolInfo: BrokerSymbol
  expiration: string
  strike: number
  right: 'call' | 'put'
  multiplier: number
  exchange?: string | undefined
  route?: string | undefined
  currency?: string | undefined
  symbol?: string | undefined
  brokerContractId?: string | number | undefined
  priceStep?: number | undefined
  /** Full route-specific price increment structure returned by TWS reqMarketRule. */
  priceIncrements?: PriceIncrementBand[] | undefined
}

export interface OptionChainResult {
  underlying: string
  exchange?: string | undefined
  currency?: string | undefined
  expirations: OptionChainExpiration[]
}

export interface OptionContractResolution {
  contract: OptionContract
  tradable?: boolean | undefined
  reason?: string | undefined
}

export interface OptionChainExpiration {
  expiration: string
  contracts: OptionChainContract[]
}

export interface OptionChainContract {
  contract: OptionContract
  bid?: number | undefined
  ask?: number | undefined
  last?: number | undefined
  mark?: number | undefined
  quoteTimestamp?: string | undefined
  marketDataType?: 'live' | 'frozen' | 'delayed' | 'delayed-frozen' | undefined
  openInterest?: number | undefined
  volume?: number | undefined
  impliedVolatility?: number | undefined
  delta?: number | undefined
  gamma?: number | undefined
  theta?: number | undefined
  vega?: number | undefined
}

export interface OptionOrderLegDraft {
  id?: string | undefined
  contract: OptionContract
  side: OrderSide
  positionEffect: PositionEffect
  quantity: number
  ratio?: number | undefined
  price?: number | undefined
}

export type StrategyOrderLegDraft =
  | (OptionOrderLegDraft & { instrument: 'option' })
  | {
      instrument: 'equity'
      id?: string | undefined
      symbol: string
      symbolInfo: BrokerSymbol
      exchange?: string | undefined
      currency?: string | undefined
      side: OrderSide
      positionEffect: PositionEffect
      quantity: number
      ratio: number
      price?: number | undefined
    }

export interface Order extends OrderDraft {
  id: string
  status: OrderStatus
  submittedAt: string
  updatedAt: string
  filledQuantity?: number | undefined
  remainingQuantity?: number | undefined
  avgFillPrice?: number | undefined
  message?: string | undefined
  brokerOrderId?: number | undefined
}

export interface Position {
  id: string
  accountId: string
  symbol: BrokerSymbol
  quantity: number
  avgCost?: number | undefined
  /** Price per quoted unit; derivatives divide broker average cost by the contract multiplier. */
  averagePrice?: number | undefined
  markPrice?: number | undefined
  optionContract?: OptionContract | undefined
  marketValue?: number | undefined
  unrealizedPnl?: number | undefined
  realizedPnl?: number | undefined
  pnlCurrency?: string | undefined
}

export interface PositionCloseOptions {
  quantity?: number | undefined
  confirmId?: string | undefined
  operationId?: string | undefined
  origin?: 'host' | 'human' | 'mcp' | undefined
}

export interface Execution {
  id: string
  accountId?: string | undefined
  orderId?: string | undefined
  positionId?: string | undefined
  symbol: BrokerSymbol
  optionContract?: OptionContract | undefined
  side: OrderSide
  quantity: number
  price: number
  timestamp: string
}

export interface MarketDepthLevel {
  price: number
  size: number
  marketMaker?: string | undefined
}

export interface MarketDepth {
  symbol: BrokerSymbol
  bids: MarketDepthLevel[]
  asks: MarketDepthLevel[]
  updatedAt: string
  diagnostic?: { message: string; code?: number | undefined } | undefined
}

export interface MarketQuote {
  symbol: BrokerSymbol
  bid?: number | undefined
  bidSize?: number | undefined
  bidUpdatedAt?: string | undefined
  ask?: number | undefined
  askSize?: number | undefined
  askUpdatedAt?: string | undefined
  last?: number | undefined
  mark?: number | undefined
  change?: number | undefined
  changePercent?: number | undefined
  volume?: number | undefined
  open?: number | undefined
  high?: number | undefined
  low?: number | undefined
  previousClose?: number | undefined
  timestamp: string
  marketDataType?: 'live' | 'frozen' | 'delayed' | 'delayed-frozen' | undefined
  status?: 'ok' | 'delayed' | 'closed' | 'unavailable' | undefined
  unavailableReason?: string | undefined
  ibkrErrorCode?: number | undefined
}

export interface BridgeMessage {
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
  timestamp: string
}

export interface BridgeDiagnostic extends BridgeMessage {}

export interface MarketDataConnection {
  status: 'unknown' | 'connected' | 'disconnected' | 'degraded'
  message?: string | undefined
}

export interface BrokerState {
  connectionStatus: ConnectionStatus
  marketDataConnection?: MarketDataConnection | undefined
  activeAccountId?: string | undefined
  accounts: AccountSummary[]
  orders: Order[]
  ordersHistory?: Order[] | undefined
  positions: Position[]
  executions: Execution[]
  quotes: MarketQuote[]
  messages: BridgeMessage[]
  diagnostics: BridgeDiagnostic[]
  marketDepth?: MarketDepth | undefined
  updatedAt: string
}

export type BrokerEvent =
  | { type: 'state'; state: BrokerState; timestamp: string }
  | {
      type: 'connection-status'
      status: ConnectionStatus
      message?: string | undefined
      timestamp: string
    }
  | {
      type: 'accounts'
      accounts: AccountSummary[]
      activeAccountId?: string | undefined
      timestamp: string
    }
  | { type: 'orders'; orders: Order[]; timestamp: string }
  | { type: 'orders-history'; orders: Order[]; timestamp: string }
  | { type: 'positions'; positions: Position[]; timestamp: string }
  | { type: 'executions'; executions: Execution[]; timestamp: string }
  | { type: 'quotes'; quotes: MarketQuote[]; timestamp: string }
  | { type: 'market-depth'; marketDepth: MarketDepth; timestamp: string }
  | { type: 'message'; message: BridgeMessage; timestamp: string }
  | { type: 'diagnostic'; diagnostic: BridgeDiagnostic; timestamp: string }

export interface BrokerContext {
  symbol?: string | undefined
  exchange?: string | undefined
  symbolType?: string | undefined
  accountId?: string | undefined
  currency?: string | undefined
  lastPrice?: number | undefined
  bid?: number | undefined
  ask?: number | undefined
}

export interface OrderPreviewResult {
  accepted: boolean
  reason?: string | undefined
  source?: 'broker' | 'local' | undefined
  estimatedCost?: number | undefined
  estimatedCostSource?: 'broker' | 'local' | undefined
  estimatedCostCurrency?: string | undefined
  estimatedCommission?: number | undefined
  estimatedCommissionRange?:
    | { minimum?: number | undefined; maximum?: number | undefined }
    | undefined
  /** Independent alternative exit estimates; never added together as a bracket total. */
  exitCommissions?:
    | Array<{
        levelId: string
        leg: 'take-profit' | 'stop-loss'
        quantity: number
        estimatedCommission?: number | undefined
        estimatedCommissionRange?:
          | { minimum?: number | undefined; maximum?: number | undefined }
          | undefined
        commissionCurrency?: string | undefined
        reason?: string | undefined
        warnings?: string[] | undefined
      }>
    | undefined
  commissionCurrency?: string | undefined
  estimatedFees?: number | undefined
  feesCurrency?: string | undefined
  estimatedMargin?: number | undefined
  marginCurrency?: string | undefined
  warnings?: string[] | undefined
  confirmId?: string | undefined
  fieldErrors?: Array<{ fieldId: string; message: string }> | undefined
}

export interface PlaceOrderResult {
  order: Order
  preview?: OrderPreviewResult | undefined
}

import type { ExecutionEnvironment } from './api.js'

export interface ExecutionEnvironmentBoundRequest {
  expectedExecutionEnvironment: ExecutionEnvironment
}

export interface HealthResponse {
  ok: boolean
  mode: ExecutionEnvironment
  ibkrHost: string
  ibkrPort: number
  backendPort: number
  liveConnectionAllowed?: boolean | undefined
  liveOrdersEnabled?: boolean | undefined
  maxOrderNotional?: number | undefined
  rejectMarketOrders?: boolean | undefined
  connectionStatus: ConnectionStatus
  marketDataConnection?: MarketDataConnection | undefined
  activeAccountId?: string | undefined
}

export interface ForecastOutcomeDetails {
  kind: 'prediction-contract'
  eventId: string
  marketId: string
  outcomeId: string
  eventTitle: string
  marketTitle: string
  outcomeLabel: 'Yes' | 'No'
  priceConvention: 'probability'
  payout: { amount: number; currency: string }
}

export interface MarketSymbol {
  prediction?: ForecastOutcomeDetails | undefined
  ticker: string
  brokerSymbol?: string | undefined
  contractIdentity?: BrokerSymbol['contractIdentity']
  contractMultiplier?: number | undefined
  canonicalSymbol?: string | undefined
  exchange?: string | undefined
  name?: string | undefined
  type?:
    | 'stock'
    | 'crypto'
    | 'forex'
    | 'futures'
    | 'index'
    | 'fund'
    | 'bond'
    | 'warrant'
    | 'commodity'
    | 'cfd'
    | 'option'
    | 'event-contract'
    | undefined
  currency?: string | undefined
  primaryExchange?: string | undefined
  description?: string | undefined
  minTick?: number | undefined
  /** Full route-specific price increment structure returned by TWS reqMarketRule. */
  priceIncrements?: PriceIncrementBand[] | undefined
}

export interface SymbolSearchResult {
  symbol: MarketSymbol
  displayName?: string | undefined
  description?: string | undefined
  provider?: string | undefined
}

export interface MarketBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number | undefined
}

export interface BarHistoryResult {
  bars: MarketBar[]
  hasOlder?: boolean | undefined
  hasNewer?: boolean | undefined
  dataUnavailable?: boolean | undefined
}

export type MarketSessionState =
  | 'closed'
  | 'pre-market'
  | 'regular'
  | 'post-market'
  | 'holiday'
  | 'extended'
  | 'unknown'

export interface MarketSessionWindow {
  opensAt: number
  closesAt: number
  state: MarketSessionState
}

export interface MarketSessionInfo {
  symbol: MarketSymbol
  timezone: string
  currentState: MarketSessionState
  asOf: number
  upcoming: MarketSessionWindow[]
  note?: string | undefined
  source: 'ibkr-contract-details'
  metadata?:
    | {
        dayStart?: number | undefined
        dayEnd?: number | undefined
        regularOpen?: number | undefined
        regularClose?: number | undefined
        earlyClose?: boolean | undefined
        holidayName?: string | undefined
        tradingHours?: string | undefined
        liquidHours?: string | undefined
        timeZoneId?: string | undefined
        minQuantity?: number | undefined
        quantityStep?: number | undefined
        contractMultiplier?: number | undefined
        /** TIF values returned by IBKR ContractDetails for this exact instrument. */
        supportedDurations?: BrokerOrderDuration[] | undefined
        /** Order-routing venues returned by IBKR ContractDetails for this exact instrument. */
        routingDestinations?: BrokerOrderRoutingDestination[] | undefined
        /** Broker route selected when the ticket has no explicit destination. */
        defaultRoutingDestination?: string | undefined
        /** IBKR All-or-None support for this exact instrument. */
        allOrNone?: BrokerOrderAllOrNoneCapability | undefined
        /** IBKR general One-Cancels-All behaviors for this exact instrument. */
        oca?: BrokerOrderOcaCapability | undefined
        /** Raw broker facts retained for diagnostics and future capability mapping. */
        orderTypes?: string | undefined
        validExchanges?: string | undefined
      }
    | undefined
}

export interface MarketSessionCalendar {
  symbol: MarketSymbol
  timezone: string
  coverage: {
    startTime: number
    endTime: number
  }
  windows: MarketSessionWindow[]
  source: 'ibkr-historical-schedule'
}

export interface BrokerOrderDuration {
  type: 'day' | 'gtc' | 'gtd' | 'ioc' | 'fok' | 'custom'
  value: OrderDuration
  label: string
  hasDatePicker?: boolean | undefined
  hasTimePicker?: boolean | undefined
  default?: boolean | undefined
  supportedOrderTypes?: OrderType[] | undefined
}

export interface BrokerOrderRoutingDestination {
  value: string
  label: string
  supportedOrderTypes?: OrderType[] | undefined
  disabledReason?: string | undefined
}

export interface BrokerOrderAllOrNoneCapability {
  supported: boolean
  default?: boolean | undefined
  supportedOrderTypes?: OrderType[] | undefined
  disabledReason?: string | undefined
}

export interface BrokerOrderOcaBehavior {
  value: OrderOcaBehavior
  label: string
  supportedOrderTypes?: OrderType[] | undefined
  disabledReason?: string | undefined
}

export interface BrokerOrderOcaCapability {
  behaviors: BrokerOrderOcaBehavior[]
  defaultBehavior?: OrderOcaBehavior | undefined
  disabledReason?: string | undefined
}

export interface BrokerInstrumentDetails {
  symbol: MarketSymbol
  name?: string | undefined
  industry?: string | undefined
  category?: string | undefined
  subcategory?: string | undefined
  minTick?: number | undefined
  priceIncrements?: PriceIncrementBand[] | undefined
  source: string
}

/** Exact TWS discovery metadata, including families awaiting SDK display support. */
export interface BrokerContractDetails {
  symbol: BrokerSymbol
  name?: string | undefined
  minTick?: number | undefined
  minQuantity?: number | undefined
  quantityStep?: number | undefined
  orderTypes?: string | undefined
  validExchanges?: string | undefined
  tradingHours?: string | undefined
  liquidHours?: string | undefined
  timeZoneId?: string | undefined
  tradingWindows?: Array<{ opensAt: number; closesAt: number }> | undefined
  bond?:
    | {
        cusip?: string | undefined
        coupon?: number | undefined
        maturity?: string | undefined
        issueDate?: string | undefined
        ratings?: string | undefined
        bondType?: string | undefined
      }
    | undefined
}
