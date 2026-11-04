import { host, makeCtx } from './host'

// Seed storage from the test (a map profile and settings), then start both halves.
for (const [k, v] of Object.entries((globalThis as any).__seed ?? {})) host.store.set(k, v as string)
await import('../../src/backend')
const { setup } = await import('../../src/frontend')
setup(makeCtx())
;(globalThis as any).__host = host
;(globalThis as any).__ready = true
