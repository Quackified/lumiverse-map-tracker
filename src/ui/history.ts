import type { WorldProfile } from '../shared/types'

const LIMIT = 100
/** Edits in the same group closer together than this collapse into one step. */
const GROUP_WINDOW = 1500

/** Snapshot undo/redo for profile edits (points, zones, bounds, crop, calibration). */
export class History {
  private past: WorldProfile[] = []
  private future: WorldProfile[] = []
  private lastGroup: string | null = null
  private lastAt = 0

  /** Call before applying an edit, with the profile as it is now. */
  record(current: WorldProfile, group: string | null = null): void {
    const now = Date.now()
    if (group && group === this.lastGroup && now - this.lastAt < GROUP_WINDOW) {
      this.lastAt = now
      return
    }
    this.past.push(structuredClone(current))
    if (this.past.length > LIMIT) this.past.shift()
    this.future = []
    this.lastGroup = group
    this.lastAt = now
  }

  undo(current: WorldProfile): WorldProfile | null {
    const prev = this.past.pop()
    if (!prev) return null
    this.future.push(structuredClone(current))
    this.lastGroup = null
    return prev
  }

  redo(current: WorldProfile): WorldProfile | null {
    const next = this.future.pop()
    if (!next) return null
    this.past.push(structuredClone(current))
    this.lastGroup = null
    return next
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  clear(): void {
    this.past = []
    this.future = []
    this.lastGroup = null
  }
}
