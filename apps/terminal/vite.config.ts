import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin, searchForWorkspaceRoot } from 'vite'
import { APP_NAME } from './src/branding.js'
import { logoDevPublishableKey } from './src/ibkr/symbol-logos.js'
import { LEGAL_DOCUMENTS } from './src/legal-documents.js'

function bundledLegalNoticesPlugin(legalDirectory: string): Plugin {
  return {
    name: 'terminal-bundled-legal-notices',
    configureServer(server) {
      server.middlewares.use('/legal', async (request, response) => {
        const pathname = (request.url ?? '/').split('?', 1)[0]
        const document = LEGAL_DOCUMENTS.find(([, file]) => pathname === `/${file}`)
        if (!document) {
          response.statusCode = 404
          response.end('Document not found.')
          return
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405
          response.setHeader('Allow', 'GET, HEAD')
          response.end()
          return
        }
        try {
          const contents = await readFile(path.join(legalDirectory, document[1]))
          response.setHeader('Content-Type', 'text/plain; charset=utf-8')
          response.setHeader('X-Content-Type-Options', 'nosniff')
          response.setHeader('Cache-Control', 'no-store')
          response.end(request.method === 'HEAD' ? undefined : contents)
        } catch {
          response.statusCode = 404
          response.end('Document unavailable.')
        }
      })
    },
  }
}

function terminalBrandingPlugin(): Plugin {
  return {
    name: 'terminal-branding',
    transformIndexHtml(html) {
      const title = APP_NAME.replace(/[&<>]/gu, (character) =>
        character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;',
      )
      return html.replace('__TERMINAL_NAME__', title)
    },
  }
}

const SOURCE_DEVELOPMENT_SDK_ID = 'virtual:tradescript-source-development-sdk'
const RESOLVED_SOURCE_DEVELOPMENT_SDK_ID = `\0${SOURCE_DEVELOPMENT_SDK_ID}`

function sourceDevelopmentSdkPlugin(sourceSdkRoot: string | undefined): Plugin {
  return {
    name: 'tradescript-source-development-sdk',
    resolveId(id) {
      if (id !== SOURCE_DEVELOPMENT_SDK_ID) return undefined
      if (sourceSdkRoot !== undefined) {
        return path.join(sourceSdkRoot, 'src/sdk/sourceDevelopmentSdk.ts')
      }
      return RESOLVED_SOURCE_DEVELOPMENT_SDK_ID
    },
    load(id) {
      if (id !== RESOLVED_SOURCE_DEVELOPMENT_SDK_ID) return undefined
      return `export async function createSourceDevelopmentSdk() {
  throw new Error('TradeScript SDK source mode is not enabled')
}`
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const terminalRoot = import.meta.dirname
  const repositoryRoot = path.resolve(terminalRoot, '../..')
  const environment = loadEnv(
    mode,
    process.env.TERMINAL_ENV_FILE ? path.dirname(process.env.TERMINAL_ENV_FILE) : repositoryRoot,
    '',
  )
  // A public branding key can be shared with isolated paper development without
  // loading the root broker configuration into that workstation.
  const logoKey =
    environment.VITE_LOGO_DEV_PUBLISHABLE_KEY ??
    loadEnv(mode, repositoryRoot, 'VITE_LOGO_DEV_PUBLISHABLE_KEY').VITE_LOGO_DEV_PUBLISHABLE_KEY
  const configuredSourceRoot = environment.TRADESCRIPT_SDK_SOURCE?.trim()
  const sourceSdkRoot =
    command === 'serve' && configuredSourceRoot !== undefined && configuredSourceRoot.length > 0
      ? path.resolve(repositoryRoot, configuredSourceRoot)
      : undefined
  const capability = process.env.INTERNAL_PROXY_CAPABILITY
  if (command === 'serve' && mode !== 'test' && capability === undefined) {
    throw new Error('Start the workstation with the root npm run dev command')
  }

  if (sourceSdkRoot !== undefined) {
    const sourcePackage = path.join(sourceSdkRoot, 'package.json')
    if (!existsSync(sourcePackage)) {
      throw new Error(`TRADESCRIPT_SDK_SOURCE does not contain package.json: ${sourceSdkRoot}`)
    }
    const packageMetadata = JSON.parse(readFileSync(sourcePackage, 'utf8')) as { name?: unknown }
    if (packageMetadata.name !== '@tradescript/pro') {
      throw new Error(`TRADESCRIPT_SDK_SOURCE is not the @tradescript/pro source: ${sourceSdkRoot}`)
    }
    for (const requiredPath of [
      'src/sdk/sourceDevelopmentSdk.ts',
      'src/styles/tailwind.css',
      'react-widgets/dist/style.css',
    ]) {
      if (!existsSync(path.join(sourceSdkRoot, requiredPath))) {
        throw new Error(
          `TradeScript source mode requires ${path.join(sourceSdkRoot, requiredPath)}`,
        )
      }
    }
  }

  const sourceSdkAliases =
    sourceSdkRoot === undefined
      ? {}
      : {
          '@tradescript/pro/react/ui': path.join(sourceSdkRoot, 'src/public-ui/index.ts'),
          '@tradescript/pro/react/style.css': path.join(
            sourceSdkRoot,
            'react-widgets/dist/style.css',
          ),
          '@tradescript/pro/style.css': path.join(sourceSdkRoot, 'src/style.css'),
          '@tradescript/pro/tailwind.css': path.join(sourceSdkRoot, 'src/styles/tailwind.css'),
          '@tradescript/pro/sdk/hotkeys': path.join(sourceSdkRoot, 'src/sdk/hotkeys/public.ts'),
          '@tradescript/pro/sdk/theme': path.join(sourceSdkRoot, 'src/sdk/theme.ts'),
          '@tradescript/pro/sdk/advanced': path.join(sourceSdkRoot, 'src/sdk/advanced.ts'),
          '@tradescript/pro/sdk/element': path.join(sourceSdkRoot, 'src/sdk/element.ts'),
          '@tradescript/pro/sdk/testing': path.join(sourceSdkRoot, 'src/sdk/testing/index.ts'),
          '@tradescript/pro/sdk/workers': path.join(sourceSdkRoot, 'src/sdk/workers/index.ts'),
          '@tradescript/pro/sdk/indicators/ta': path.join(
            sourceSdkRoot,
            'src/indicators/ta/index.ts',
          ),
          '@tradescript/pro/sdk/indicators/math': path.join(
            sourceSdkRoot,
            'src/indicators/math/index.ts',
          ),
          '@tradescript/pro/sdk/indicators': path.join(sourceSdkRoot, 'src/indicators/index.ts'),
          '@tradescript/pro/sdk/core': path.join(sourceSdkRoot, 'src/sdk/core.ts'),
          '@tradescript/pro/sdk/trading': path.join(sourceSdkRoot, 'src/trading/index.ts'),
          '@tradescript/react-widgets/ui': path.join(sourceSdkRoot, 'src/public-ui/index.ts'),
          '@shared/ui': path.join(sourceSdkRoot, 'src/ui'),
          '@shared/options': path.join(sourceSdkRoot, 'src/options/optionSeries.ts'),
          // Vite aliases match prefixes, so the specific SDK entries must come first.
          '@tradescript/pro/sdk': path.join(sourceSdkRoot, 'src/sdk/index.ts'),
          '@tradescript/pro': path.join(sourceSdkRoot, 'src/index.ts'),
        }

  const sourceTailwindPlugin = (() => {
    if (sourceSdkRoot === undefined) return undefined
    const sourceRequire = createRequire(path.join(sourceSdkRoot, 'package.json'))
    const sourceTailwindConfig = sourceRequire(path.join(sourceSdkRoot, 'tailwind.config.cjs'))
    return sourceRequire('tailwindcss')({
      ...sourceTailwindConfig,
      content: [
        path.join(sourceSdkRoot, 'src/**/*.{ts,tsx}'),
        path.join(sourceSdkRoot, 'react-widgets/src/**/*.{ts,tsx}'),
      ],
    })
  })()

  return {
    ...(environment.TERMINAL_VITE_CACHE_DIR?.trim()
      ? { cacheDir: path.resolve(repositoryRoot, environment.TERMINAL_VITE_CACHE_DIR) }
      : {}),
    plugins: [
      react(),
      terminalBrandingPlugin(),
      sourceDevelopmentSdkPlugin(sourceSdkRoot),
      bundledLegalNoticesPlugin(
        path.join(repositoryRoot, 'apps/desktop/src-tauri/runtime/web/legal'),
      ),
    ],
    define: {
      'import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY': JSON.stringify(
        logoDevPublishableKey(logoKey),
      ),
      'import.meta.env.VITE_TRADESCRIPT_SDK_SOURCE_MODE': JSON.stringify(
        sourceSdkRoot !== undefined,
      ),
      ...(sourceSdkRoot === undefined
        ? {}
        : {
            __TRADESCRIPT_CHART_BUILD_IDENTITY__: JSON.stringify({
              mode: 'development',
              customerBuildFingerprint: null,
              chartLeaseTrust: null,
            }),
            __TRADESCRIPT_CHART_CUSTOMER_ARTIFACT__: 'false',
            'process.env.NODE_ENV': JSON.stringify('development'),
          }),
    },
    ...(sourceSdkRoot === undefined
      ? {}
      : {
          optimizeDeps: {
            exclude: [
              '@tradescript/pro',
              '@tradescript/pro/sdk',
              '@tradescript/pro/sdk/core',
              '@tradescript/pro/sdk/trading',
            ],
          },
        }),
    resolve: {
      alias: sourceSdkAliases,
      dedupe: ['react', 'react-dom'],
    },
    ...(sourceTailwindPlugin === undefined
      ? {}
      : { css: { postcss: { plugins: [sourceTailwindPlugin] } } }),
    server: {
      host: '127.0.0.1',
      port: Number(environment.UI_PORT ?? 3000),
      strictPort: true,
      allowedHosts: ['localhost'],
      fs: {
        allow: [searchForWorkspaceRoot(terminalRoot), ...(sourceSdkRoot ? [sourceSdkRoot] : [])],
      },
      proxy: {
        '/mcp-local': {
          target: `http://127.0.0.1:${environment.TRADESCRIPT_MCP_HTTP_PORT ?? 39182}`,
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/mcp-local/u, ''),
          headers: {
            'x-terminal-proxy-capability': capability ?? '',
          },
          configure(proxy) {
            proxy.on('proxyReq', (request) => {
              request.setHeader('x-terminal-proxy-capability', capability ?? '')
            })
          },
        },
        '/api': {
          target: `http://127.0.0.1:${environment.GATEWAY_PORT ?? 3001}`,
          changeOrigin: false,
          ws: true,
          headers: {
            'x-terminal-proxy-capability': capability ?? '',
            'x-tradescript-client': 'terminal-v1',
          },
          configure(proxy) {
            const setGatewayHeaders = (request: {
              setHeader(name: string, value: string): void
            }) => {
              request.setHeader('x-terminal-proxy-capability', capability ?? '')
              request.setHeader('x-tradescript-client', 'terminal-v1')
            }
            proxy.on('proxyReq', setGatewayHeaders)
            proxy.on('proxyReqWs', setGatewayHeaders)
          },
        },
      },
    },
  }
})
