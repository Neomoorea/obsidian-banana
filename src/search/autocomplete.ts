/**
 * Turn MiniSearch's whole-query suggestions into a completion for the final
 * partially typed token. MiniSearch can return values such as
 * "machine learn learning"; we must not append the duplicate " learning".
 */
export function completeTrailingToken(query: string, suggestions: readonly string[]): string | undefined {
  const value = query.trimEnd()
  if (!value || /[:()"']/u.test(value)) return undefined
  const tokenMatch = /^(.*\s)?([^\s]+)$/u.exec(value)
  if (!tokenMatch) return undefined

  const prefix = tokenMatch[1] ?? ''
  const token = tokenMatch[2]
  if (!/^[\p{L}\p{N}_-]+$/u.test(token)) return undefined
  const normalizedToken = token.toLocaleLowerCase()

  for (const suggestion of suggestions) {
    for (const candidate of suggestion.trim().split(/\s+/u)) {
      if (candidate.length > token.length && candidate.toLocaleLowerCase().startsWith(normalizedToken)) {
        return `${prefix}${candidate}`
      }
    }
  }
  return undefined
}
