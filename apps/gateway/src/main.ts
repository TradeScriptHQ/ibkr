import { isMainThread } from 'node:worker_threads'
import { runService } from '@ibkr-terminal/service-runtime'
import { startGatewayService } from './service.js'

if (isMainThread) process.umask(0o077)
await runService(startGatewayService)
