import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Selecting this suite enables paper scenarios. The shared fixture verifies the real
// connection before any scenario runs; read-only cases still reject broker writes.
export default defineConfig({ ...base, grepInvert: undefined })
