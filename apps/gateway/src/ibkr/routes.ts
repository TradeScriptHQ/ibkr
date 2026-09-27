import type { BrokerContractDetails } from '@ibkr-terminal/contracts'
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify'
import type { GatewayConfig } from '../config.js'
import { fromIbSymbol } from './contracts.js'
import { executeEnvironmentBoundMutation } from './execution-environment.js'
import type { IbkrService } from './ibkr-service.js'
import type { OptionChainRequest } from './option-chains.js'
import { normalizeIbTimezone, parseIbSchedule } from './session-calendar.js'
import type { BrokerStateStore } from './state-store.js'
import type {
  BrokerContext,
  BrokerSymbol,
  ExecutionEnvironmentBoundRequest,
  OptionContract,
  OrderDraft,
  OrderPatch,
  PositionCloseOptions,
} from './types.js'

interface OrderRequest extends ExecutionEnvironmentBoundRequest {
  draft: OrderDraft
  context?: BrokerContext
}

type ModifyOrderRequest = ExecutionEnvironmentBoundRequest &
  OrderPatch & {
    patch?: OrderPatch
    draft?: OrderPatch
    context?: BrokerContext
  }

interface OptionResolveRequest extends ExecutionEnvironmentBoundRequest {
  contract: OptionContract
  accountId?: string
}

interface ClosePositionRequest extends ExecutionEnvironmentBoundRequest {
  context?: BrokerContext
  options?: PositionCloseOptions
}

interface IbkrRouteOptions {
  config: GatewayConfig
  ibkr: IbkrService
  brokerStore: BrokerStateStore
  authenticated: RouteShorthandOptions
  financialMutation: RouteShorthandOptions
  brokerMutation<T>(
    request: FastifyRequest,
    eventType: string,
    execute: () => T | Promise<T>,
  ): Promise<T>
}

/** Broker HTTP endpoints; authentication and journaling are supplied by the server. */
export function registerIbkrRoutes(app: FastifyInstance, options: IbkrRouteOptions): void {
  const { authenticated, financialMutation, brokerMutation } = options
  app.get('/api/v1/ibkr/health', authenticated, async () => {
    const { brokerStore } = options
    const state = brokerStore.getState()
    return {
      ok: state.connectionStatus === 'connected',
      mode: options.config.ibkr.executionEnvironment,
      ibkrHost: options.config.ibkr.host,
      ibkrPort: options.config.ibkr.port,
      backendPort: options.config.gateway.port,
      liveConnectionAllowed: options.config.ibkr.executionEnvironment === 'live',
      liveOrdersEnabled: options.config.ibkr.liveOrdersEnabled,
      connectionStatus: state.connectionStatus,
      marketDataConnection: state.marketDataConnection,
      activeAccountId: state.activeAccountId,
    }
  })

  app.get('/api/v1/ibkr/state', authenticated, async () => {
    const { brokerStore } = options
    return brokerStore.getState()
  })
  app.get('/api/v1/ibkr/time', authenticated, async () => ({
    time: Date.now(),
    iso: new Date().toISOString(),
  }))

  app.get('/api/v1/ibkr/events', authenticated, async (request, reply) => {
    const { brokerStore } = options
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    reply.raw.write('retry: 1000\n\n')
    const unsubscribe = brokerStore.subscribe((event) => {
      if (reply.raw.destroyed) return
      reply.raw.write(`event: ${event.type}\n`)
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    request.raw.once('close', unsubscribe)
  })

  app.get('/api/v1/ibkr/symbols/search', authenticated, async (request) => {
    const { ibkr, brokerStore } = options
    const query = request.query as {
      query?: string
      limit?: string
      assetClass?: string
      exchange?: string
    }
    try {
      return await ibkr.searchSymbols(query.query ?? '', Number(query.limit ?? 10), {
        assetClass: query.assetClass,
        exchange: query.exchange,
      })
    } catch (error) {
      brokerStore.addDiagnostic(
        'warning',
        error instanceof Error ? error.message : 'IBKR symbol search unavailable',
      )
      throw error
    }
  })

  app.get('/api/v1/ibkr/contracts/opposing-outcome', authenticated, async (request) => {
    const query = request.query as Record<string, string | undefined>
    return options.ibkr.getOpposingForecastContract({
      symbol: query.symbol ?? '',
      exchange: 'FORECASTX',
      currency: query.currency,
      assetClass: 'event-contract',
    })
  })

  app.get('/api/v1/ibkr/contracts', authenticated, async (request) => {
    const query = request.query as Record<string, string | undefined>
    const details = await options.ibkr.discoverContracts({
      symbol: query.symbol ?? '',
      securityType: query.securityType ?? '',
      exchange: query.exchange ?? '',
      currency: query.currency,
      expiry: query.expiry,
      ...(query.conId === undefined ? {} : { conId: Number(query.conId) }),
    })
    return details.map(
      (item): BrokerContractDetails => ({
        symbol: fromIbSymbol(item.contract),
        name:
          item.longName?.trim() ||
          (item.contract.secType === 'BOND' ? item.descAppend?.trim() : undefined),
        minTick: item.minTick,
        minQuantity: item.minSize,
        quantityStep: item.sizeIncrement,
        orderTypes: item.orderTypes,
        validExchanges: item.validExchanges,
        tradingWindows:
          item.timeZoneId && item.tradingHours
            ? parseIbSchedule(item.tradingHours, normalizeIbTimezone(item.timeZoneId)).windows.map(
                ({ opensAt, closesAt }) => ({ opensAt, closesAt }),
              )
            : undefined,
        tradingHours: item.tradingHours,
        liquidHours: item.liquidHours,
        timeZoneId: item.timeZoneId,
        bond:
          item.contract.secType === 'BOND'
            ? {
                cusip: item.cusip,
                coupon: item.coupon,
                maturity: item.maturity,
                issueDate: item.issueDate,
                ratings: item.ratings,
                bondType: item.bondType,
              }
            : undefined,
      }),
    )
  })

  app.get('/api/v1/ibkr/symbols/resolve', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | undefined>
    return ibkr.resolveSymbol(query.symbol ?? '', {
      exchange: query.exchange,
      primaryExchange: query.primaryExchange,
      currency: query.currency,
      assetClass: query.assetClass,
    })
  })

  app.get('/api/v1/ibkr/instrument-details', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | undefined>
    return ibkr.getInstrumentDetails({
      symbol: query.symbol ?? '',
      ...(query.exchange ? { exchange: query.exchange } : {}),
      ...(query.primaryExchange ? { primaryExchange: query.primaryExchange } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.assetClass ? { assetClass: query.assetClass } : {}),
    })
  })

  app.get('/api/v1/ibkr/bars', authenticated, async (request) => {
    const { ibkr, brokerStore } = options
    const query = request.query as Record<string, string | undefined>
    try {
      return await ibkr.loadBars({
        symbol: query.symbol ?? '',
        ...(query.exchange ? { exchange: query.exchange } : {}),
        ...(query.primaryExchange ? { primaryExchange: query.primaryExchange } : {}),
        ...(query.currency ? { currency: query.currency } : {}),
        interval: query.interval ?? '1m',
        startTime: Number(query.startTime ?? Number.NaN),
        endTime: Number(query.endTime ?? Number.NaN),
        barCount: Number(query.barCount ?? Number.NaN),
        ...((query.assetClass ?? query.type)
          ? { assetClass: query.assetClass ?? query.type ?? '' }
          : {}),
      })
    } catch (error) {
      brokerStore.addDiagnostic(
        'warning',
        error instanceof Error ? error.message : 'IBKR bars unavailable',
      )
      throw error
    }
  })

  app.get('/api/v1/ibkr/quotes', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | string[] | undefined>
    const rawSymbols = Array.isArray(query.symbol) ? query.symbol : [query.symbol ?? '']
    const symbols = rawSymbols.flatMap((value) => value.split(',')).filter(Boolean)
    return ibkr.getQuotes(
      symbols.map(
        (symbol): BrokerSymbol => ({
          symbol,
          ...(typeof query.exchange === 'string' ? { exchange: query.exchange } : {}),
          ...(typeof query.primaryExchange === 'string'
            ? { primaryExchange: query.primaryExchange }
            : {}),
          ...(typeof query.currency === 'string' ? { currency: query.currency } : {}),
          ...(typeof query.assetClass === 'string'
            ? { assetClass: query.assetClass }
            : typeof query.type === 'string'
              ? { assetClass: query.type }
              : {}),
        }),
      ),
      query.fresh === 'true' ? { maxAgeMs: 30_000 } : {},
    )
  })

  app.get('/api/v1/ibkr/depth', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | undefined>
    return ibkr.getMarketDepth(
      {
        symbol: query.symbol ?? '',
        ...(query.exchange ? { exchange: query.exchange } : {}),
        ...(query.primaryExchange ? { primaryExchange: query.primaryExchange } : {}),
        ...(query.currency ? { currency: query.currency } : {}),
        ...(query.assetClass ? { assetClass: query.assetClass } : {}),
      },
      Number(query.levels ?? 20),
    )
  })

  app.get('/api/v1/ibkr/time-and-sales', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | undefined>
    return ibkr.getTimeAndSales(
      {
        symbol: query.symbol ?? '',
        ...(query.exchange ? { exchange: query.exchange } : {}),
        ...(query.primaryExchange ? { primaryExchange: query.primaryExchange } : {}),
        ...(query.currency ? { currency: query.currency } : {}),
        ...(query.assetClass ? { assetClass: query.assetClass } : {}),
      },
      Number(query.limit ?? 200),
    )
  })

  app.get('/api/v1/ibkr/options/chain', authenticated, async (request) => {
    const { ibkr } = options
    return ibkr.getOptionChain(optionChainRequest(request.query))
  })

  app.get('/api/v1/ibkr/options/chain/events', authenticated, async (request, reply) => {
    const { ibkr } = options
    let ready = false
    const stream = await ibkr.subscribeOptionChain(optionChainRequest(request.query), (chain) => {
      if (!ready || reply.raw.destroyed) return
      reply.raw.write('event: option-quotes\n')
      reply.raw.write(`data: ${JSON.stringify(chain)}\n\n`)
    })
    if (request.raw.destroyed) {
      stream.unsubscribe()
      return
    }
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    reply.raw.write('retry: 1000\n\n')
    reply.raw.write('event: option-quotes\n')
    reply.raw.write(`data: ${JSON.stringify(stream.initial)}\n\n`)
    ready = true
    const keepalive = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n')
    }, 15_000)
    keepalive.unref?.()
    request.raw.once('close', () => {
      clearInterval(keepalive)
      stream.unsubscribe()
    })
  })

  app.post('/api/v1/ibkr/options/resolve', financialMutation, async (request) => {
    const { ibkr } = options
    const body = request.body as OptionResolveRequest
    return brokerMutation(request, 'option.resolve', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.resolveOptionContract(body.contract, body.accountId),
      ),
    )
  })

  app.get('/api/v1/ibkr/sessions', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | undefined>
    return ibkr.resolveSession({
      symbol: query.symbol ?? '',
      ...(query.exchange ? { exchange: query.exchange } : {}),
      ...(query.primaryExchange ? { primaryExchange: query.primaryExchange } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...((query.assetClass ?? query.type)
        ? { assetClass: query.assetClass ?? query.type ?? '' }
        : {}),
    })
  })

  app.get('/api/v1/ibkr/session-calendar', authenticated, async (request) => {
    const { ibkr } = options
    const query = request.query as Record<string, string | undefined>
    return ibkr.resolveSessionCalendar({
      symbol: query.symbol ?? '',
      ...(query.exchange ? { exchange: query.exchange } : {}),
      ...(query.primaryExchange ? { primaryExchange: query.primaryExchange } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...((query.assetClass ?? query.type)
        ? { assetClass: query.assetClass ?? query.type ?? '' }
        : {}),
      startTime: Number(query.startTime),
      endTime: Number(query.endTime),
    })
  })

  app.post('/api/v1/ibkr/orders/preview', financialMutation, async (request) => {
    const { ibkr } = options
    const body = request.body as OrderRequest
    return brokerMutation(request, 'order.preview', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.previewOrder(body.draft, body.context),
      ),
    )
  })

  app.post('/api/v1/ibkr/orders', financialMutation, async (request, reply) => {
    const { ibkr } = options
    const body = request.body as OrderRequest
    const result = await brokerMutation(request, 'order.place', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.placeOrder(body.draft, body.context),
      ),
    )
    return reply.status(201).send(result)
  })

  app.post('/api/v1/ibkr/accounts/:accountId/activate', financialMutation, async (request) => {
    const { ibkr } = options
    const body = request.body as ExecutionEnvironmentBoundRequest
    const { accountId } = request.params as { accountId: string }
    return brokerMutation(request, 'account.activate', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.setActiveAccount(accountId),
      ),
    )
  })

  app.post('/api/v1/ibkr/orders/:orderId/preview', financialMutation, async (request) => {
    const { ibkr } = options
    const body = request.body as ModifyOrderRequest
    const { orderId } = request.params as { orderId: string }
    return brokerMutation(request, 'order.modify-preview', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.previewModifyOrder(orderId, body.patch ?? body.draft ?? body, body.context),
      ),
    )
  })

  app.patch('/api/v1/ibkr/orders/:orderId', financialMutation, async (request) => {
    const { ibkr } = options
    const body = request.body as ModifyOrderRequest
    const { orderId } = request.params as { orderId: string }
    return brokerMutation(request, 'order.modify', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.modifyOrder(orderId, body.patch ?? body.draft ?? body, body.context),
      ),
    )
  })

  app.delete('/api/v1/ibkr/orders/:orderId', financialMutation, async (request) => {
    const { ibkr } = options
    const body = request.body as ExecutionEnvironmentBoundRequest
    const { orderId } = request.params as { orderId: string }
    await brokerMutation(request, 'order.cancel', () =>
      executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
        ibkr.cancelOrder(orderId),
      ),
    )
    return { ok: true }
  })

  app.post(
    '/api/v1/ibkr/positions/:positionId/close/preview',
    financialMutation,
    async (request) => {
      const body = request.body as ClosePositionRequest
      const { positionId } = request.params as { positionId: string }
      return brokerMutation(request, 'position.close-preview', () =>
        executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
          options.ibkr.previewClosePosition(positionId, body.context, body.options),
        ),
      )
    },
  )

  app.post(
    '/api/v1/ibkr/positions/:positionId/close',
    financialMutation,
    async (request, reply) => {
      const { ibkr } = options
      const body = request.body as ClosePositionRequest
      const { positionId } = request.params as { positionId: string }
      const result = await brokerMutation(request, 'position.close', () =>
        executeEnvironmentBoundMutation(body, options.config.ibkr.executionEnvironment, () =>
          ibkr.closePosition(positionId, body.context, body.options),
        ),
      )
      return reply.status(201).send(result)
    },
  )
}

function optionalNumber(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalNumberField<K extends string>(
  key: K,
  value: string | string[] | undefined,
): Partial<Record<K, number>> {
  const parsed = optionalNumber(value)
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<K, number>)
}

function optionChainRequest(queryValue: unknown): OptionChainRequest {
  const query = queryValue as Record<string, string | string[] | undefined>
  const expirations = Array.isArray(query.expiration)
    ? query.expiration
    : typeof query.expiration === 'string'
      ? [query.expiration]
      : []
  return {
    underlying:
      typeof query.underlying === 'string'
        ? query.underlying
        : typeof query.symbol === 'string'
          ? query.symbol
          : '',
    ...(typeof query.exchange === 'string' ? { exchange: query.exchange } : {}),
    ...(typeof query.currency === 'string' ? { currency: query.currency } : {}),
    ...(typeof query.underlyingAssetClass === 'string'
      ? { underlyingAssetClass: query.underlyingAssetClass }
      : {}),
    ...(typeof query.underlyingExchange === 'string'
      ? { underlyingExchange: query.underlyingExchange }
      : {}),
    expirations,
    ...optionalNumberField('minStrike', query.minStrike),
    ...optionalNumberField('maxStrike', query.maxStrike),
    ...optionalNumberField('centerPrice', query.centerPrice),
    ...optionalNumberField('quoteWindowRows', query.quoteWindowRows),
    ...optionalNumberField('maxQuoteContracts', query.maxQuoteContracts),
  }
}
