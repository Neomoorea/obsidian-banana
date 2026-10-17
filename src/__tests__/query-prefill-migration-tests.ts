import { describe, expect, it } from 'vitest'
import { migrateQueryPrefillPreference } from '../settings/query-prefill-migration'

describe('previous-query restoration migration', () => {
  it('turns off the legacy default for existing settings', () => {
    const current = { showPreviousQueryResults: true, queryPrefillBehaviorVersion: 1 }
    expect(migrateQueryPrefillPreference(current, { showPreviousQueryResults: true })).toBe(true)
    expect(current).toEqual({ showPreviousQueryResults: false, queryPrefillBehaviorVersion: 1 })
  })

  it('preserves an existing explicit opt-out', () => {
    const current = { showPreviousQueryResults: false, queryPrefillBehaviorVersion: 1 }
    expect(migrateQueryPrefillPreference(current, { showPreviousQueryResults: false })).toBe(true)
    expect(current.showPreviousQueryResults).toBe(false)
  })

  it("does not override the user's choice after migration", () => {
    const current = { showPreviousQueryResults: true, queryPrefillBehaviorVersion: 1 }
    expect(migrateQueryPrefillPreference(current, { showPreviousQueryResults: true, queryPrefillBehaviorVersion: 1 })).toBe(false)
    expect(current.showPreviousQueryResults).toBe(true)
  })
})
