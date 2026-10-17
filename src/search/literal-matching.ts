/**
 * Mask occurrences of a query expression while evaluating its structured
 * predicate. Replacement preserves line breaks and character offsets, so a
 * value embedded only in its own syntax (for example, the `1` in `section:1`)
 * cannot count as independent semantic evidence. The literal-search branch
 * evaluates the original source separately.
 */
export function maskQuerySyntaxOccurrences(source: string, expression: string): string {
  if (!source || !expression) return source
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(escaped, 'giu')
  if (!pattern.test(source)) return source
  pattern.lastIndex = 0
  return source.replace(pattern, match => match.replace(/[^\r\n]/g, ' '))
}
