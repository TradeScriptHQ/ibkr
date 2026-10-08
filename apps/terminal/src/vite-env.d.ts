/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOGO_DEV_PUBLISHABLE_KEY: string
  readonly VITE_TRADESCRIPT_SDK_SOURCE_MODE: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'virtual:tradescript-source-development-sdk' {
  export function createSourceDevelopmentSdk(): Promise<
    import('@tradescript/pro/sdk').TradeScriptSdkProducts
  >
}
