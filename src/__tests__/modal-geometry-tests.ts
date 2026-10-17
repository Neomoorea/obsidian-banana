import { describe, expect, it } from 'vitest'
import { migrateModalGeometry } from '../components/modal-geometry'

describe('search modal geometry migration', () => {
  it('clears an accidentally persisted minimum-width, minimum-height pane', () => {
    expect(migrateModalGeometry({ width: 270, height: 180 }, 3)).toEqual({
      size: null,
      version: 4,
      changed: true,
    })
  })

  it('preserves a custom width while discarding a previous vertical cap', () => {
    expect(migrateModalGeometry({ width: 720, height: 180 }, 3)).toEqual({
      size: { width: 720, height: null },
      version: 4,
      changed: true,
    })
  })

  it('returns custom widths to content-driven height even when an old cap was large', () => {
    expect(migrateModalGeometry({ width: 920, height: 560 }, 3)).toEqual({
      size: { width: 920, height: null },
      version: 4,
      changed: true,
    })
  })

  it('does not re-migrate current geometry settings', () => {
    const size = { width: 800, height: null }
    expect(migrateModalGeometry(size, 4)).toEqual({ size, version: 4, changed: false })
  })
})
