/** Version for making previous-query restoration opt-in by default. */
export const QUERY_PREFILL_BEHAVIOR_VERSION = 1

export type QueryPrefillSettings = {
  showPreviousQueryResults: boolean
  queryPrefillBehaviorVersion: number
}

export type StoredQueryPrefillSettings = Partial<QueryPrefillSettings> | null | undefined

/**
 * Older releases defaulted to restoring the previous query, which could make
 * a saved term appear every time Banana opened. Make that behavior opt-in while
 * preserving the setting for users who already have the current migration marker.
 * Returns true when an existing settings object should be saved after migration.
 */
export function migrateQueryPrefillPreference(
  current: QueryPrefillSettings,
  stored: StoredQueryPrefillSettings,
): boolean {
  if ((stored?.queryPrefillBehaviorVersion ?? 0) >= QUERY_PREFILL_BEHAVIOR_VERSION) {
    return false
  }

  current.showPreviousQueryResults = false
  current.queryPrefillBehaviorVersion = QUERY_PREFILL_BEHAVIOR_VERSION
  return stored != null
}
