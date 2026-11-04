import type { WorldProfile } from '../shared/types'

/** The big parts of a profile, copied only when an edit touches them. */
const LAZY = ['land', 'decor', 'features', 'points', 'zones'] as const

/**
 * A copy of `prev` to edit in place, where the big parts (terrain, decorations,
 * shapes, places, zones) are copied the first time the edit reads or sets
 * them. Parts the edit never touches stay shared with `prev`, which keeps the
 * edit cheap on big maps and lets the map's caches see they didn't change.
 * Call the returned `done()` after editing to settle it into a plain object.
 * Committed profiles are never edited in place, so sharing is safe.
 */
export function editableCopy(prev: WorldProfile): { draft: WorldProfile; done: () => WorldProfile } {
  const rest: Record<string, unknown> = { ...prev }
  for (const k of LAZY) delete rest[k]
  const draft = structuredClone(rest) as unknown as WorldProfile
  const settle = (k: string, v: unknown) => Object.defineProperty(draft, k, { value: v, writable: true, enumerable: true, configurable: true })
  for (const k of LAZY) {
    if (!(k in prev)) continue
    Object.defineProperty(draft, k, {
      configurable: true,
      enumerable: true,
      get() {
        const v = structuredClone((prev as unknown as Record<string, unknown>)[k])
        settle(k, v)
        return v
      },
      set(v: unknown) {
        settle(k, v)
      },
    })
  }
  const done = (): WorldProfile => {
    for (const k of LAZY) {
      const d = Object.getOwnPropertyDescriptor(draft, k)
      // Untouched: share the original.
      if (d?.get) settle(k, (prev as unknown as Record<string, unknown>)[k])
      if ((draft as unknown as Record<string, unknown>)[k] === undefined) delete (draft as unknown as Record<string, unknown>)[k]
    }
    return draft
  }
  return { draft, done }
}
