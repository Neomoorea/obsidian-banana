/** Return true when a pattern contains an active (unescaped) glob token. */
export function hasUnescapedWildcard(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '\\' && index + 1 < pattern.length && ['\\', '*', '?'].includes(pattern[index + 1])) {
      index++
      continue
    }
    if (character === '*' || character === '?') return true
  }
  return false
}

/**
 * Match a full string against a glob while keeping escaped `*` and `?` literal.
 * Escapes are parsed from the raw user pattern, before query decoding can erase
 * the distinction between a wildcard and a literal wildcard character.
 */
export function globPatternMatches(
  candidate: string,
  rawPattern: string,
  normalize: (value: string) => string = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase(),
): boolean {
  const value = normalize(candidate)
  const pattern = rawPattern.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
  if (!pattern) return false

  let expression = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    const next = pattern[index + 1]
    if (character === '\\' && next !== undefined) {
      if (['\\', '*', '?'].includes(next)) {
        expression += next.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        index++
        continue
      }
      // The query parser defines backslash as an escape for syntax characters.
      if ('"`:=^~()'.includes(next)) {
        expression += next.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        index++
        continue
      }
      expression += '\\\\'
      continue
    }
    if (character === '*') expression += '.*'
    else if (character === '?') expression += '.'
    else expression += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }

  try {
    return new RegExp(`^${expression}$`, 'iu').test(value)
  } catch {
    return false
  }
}
