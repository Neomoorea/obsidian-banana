/** Geometry constraints and migration for the resizable search modal. */
export const MIN_MODAL_WIDTH = 270
export const MIN_MODAL_HEIGHT = 180
export const MODAL_GEOMETRY_VERSION = 4

export type ModalSizePreference = { width: number; height: number | null } | null

export type ModalGeometryMigration = {
  size: ModalSizePreference
  version: number
  changed: boolean
}

/**
 * The previous implementation persisted viewport-sized height caps even when
 * users were only changing width. Preserve a deliberate width, but return
 * vertical sizing to Obsidian's native prompt behavior until the user explicitly
 * resizes vertically again. Discard accidental minimum-sized panes as well.
 */
export function migrateModalGeometry(
  size: ModalSizePreference,
  version: number,
): ModalGeometryMigration {
  if (version >= MODAL_GEOMETRY_VERSION) return { size, version, changed: false }
  if (!size) return { size: null, version: MODAL_GEOMETRY_VERSION, changed: true }

  const widthLooksLikeMinimum = size.width <= MIN_MODAL_WIDTH + 15
  const heightLooksLikeMinimum = size.height !== null && size.height <= MIN_MODAL_HEIGHT + 15
  if (widthLooksLikeMinimum && (heightLooksLikeMinimum || size.height === null)) {
    return { size: null, version: MODAL_GEOMETRY_VERSION, changed: true }
  }

  return {
    size: { width: size.width, height: null },
    version: MODAL_GEOMETRY_VERSION,
    changed: true,
  }
}
