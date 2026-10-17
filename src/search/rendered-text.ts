import type { TextMatchMode } from './query-language'
import { normalizeQueryValue } from './query-language'
import { globPatternMatches } from './glob'

export interface MappedText {
  text: string
  /** Source UTF-16 start offset for each UTF-16 code unit in `text`. */
  sourceOffsets: number[]
  /** Exclusive source end offset for each UTF-16 code unit in `text`. */
  sourceEnds: number[]
}

export type NormalizedMappedText = MappedText

/** Create an identity-offset source view for raw-source searches. */
export function buildSourceMappedText(source: string): MappedText {
  return { text: source, sourceOffsets: Array.from({ length: source.length }, (_, index) => index), sourceEnds: Array.from({ length: source.length }, (_, index) => index + 1) }
}

/**
 * A conservative Markdown text view for matching escaped punctuation and common
 * inline formatting while preserving offsets into the original source. This is
 * a verification/highlighting representation; the main MiniSearch index remains
 * the ranked candidate engine for ordinary word searches.
 */
export function buildRenderedText(source: string): MappedText {
  let text = ''
  const sourceOffsets: number[] = []
  const sourceEnds: number[] = []
  const push = (value: string, offset: number, end = offset + value.length) => {
    for (let j = 0; j < value.length; j++) {
      text += value[j]
      sourceOffsets.push(offset + j)
      sourceEnds.push(end === offset + value.length ? offset + j + 1 : end)
    }
  }
  const isPunctuation = (char: string) => /[\\`*_{}\[\]()#+\-.!|>~=%]/u.test(char)
  const lineEndAt = (from: number) => {
    const next = source.indexOf('\n', from)
    return next < 0 ? source.length : next
  }
  // YAML is displayed by Obsidian's properties UI, not as prose in the note
  // body. Keep it in the raw-source view but omit it from the rendered view.
  let index = source.startsWith('---\n') ? (() => {
    const close = source.indexOf('\n---', 4)
    if (close < 0) return 0
    const after = source.indexOf('\n', close + 1)
    return after < 0 ? source.length : after + 1
  })() : 0
  while (index < source.length) {
    const char = source[index]

    // Markdown headings/list/quote prefixes are syntax rather than visible text.
    if ((index === 0 || source[index - 1] === '\n') && /^(?: {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+))/.test(source.slice(index, lineEndAt(index)))) {
      const prefix = /^(?: {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+))/.exec(source.slice(index, lineEndAt(index)))![0]
      index += prefix.length
      continue
    }

    // Wikilinks show the alias when present, otherwise the target. Keep the
    // visible portion's own source offsets so navigation/highlighting maps back.
    if (source.startsWith('[[', index)) {
      const close = source.indexOf(']]', index + 2)
      if (close >= 0) {
        const innerStart = index + 2
        const inner = source.slice(innerStart, close)
        const pipe = inner.lastIndexOf('|')
        const visibleStart = pipe >= 0 ? innerStart + pipe + 1 : innerStart
        const visible = source.slice(visibleStart, close).replace(/\\\|/gu, '|')
        push(visible, visibleStart, close)
        index = close + 2
        continue
      }
    }

    // Inline Markdown links and images display their label/alt text, not the URL.
    const imageStart = source.startsWith('![', index)
    const labelStart = imageStart ? index + 2 : char === '[' ? index + 1 : -1
    if (labelStart >= 0) {
      const labelEnd = source.indexOf(']', labelStart)
      if (labelEnd >= 0 && source[labelEnd + 1] === '(') {
        let close = labelEnd + 2
        let depth = 1
        let escaped = false
        while (close < source.length && depth > 0) {
          const c = source[close]
          if (escaped) escaped = false
          else if (c === '\\') escaped = true
          else if (c === '(') depth++
          else if (c === ')') depth--
          if (depth > 0) close++
        }
        if (depth === 0) {
          push(source.slice(labelStart, labelEnd), labelStart, labelEnd)
          index = close + 1
          continue
        }
      }
    }

    // An escaped Markdown punctuation character is displayed literally.
    if (char === '\\' && index + 1 < source.length && isPunctuation(source[index + 1])) {
      push(source[index + 1], index, index + 2)
      index += 2
      continue
    }

    // Remove HTML tags, but don't mistake angle-bracket autolinks such as
    // <https://example.com> for tags.
    if (char === '<') {
      const close = source.indexOf('>', index + 1)
      if (close > index && /^<\/?[a-z][a-z0-9-]*(?:\s[^<>]*|\/?>)$/iu.test(source.slice(index, close + 1))
        && !/^<\/?[a-z][a-z0-9+.-]*:/iu.test(source.slice(index, close + 1))) {
        index = close + 1
        continue
      }
    }

    // Remove common paired inline formatting and code delimiters.
    let marker: string | undefined
    for (const candidate of ['***', '___', '**', '__', '~~', '```', '`', '*', '_']) {
      if (!source.startsWith(candidate, index)) continue
      const before = source[index - 1] ?? ''
      const after = source[index + candidate.length] ?? ''
      const boundaryBefore = !before || /[\s([{>]/u.test(before)
      const boundaryAfter = !after || /[\s.,!?;:)}\]<>]/u.test(after)
      const closeAt = source.indexOf(candidate, index + candidate.length)
      if (boundaryBefore && after && !/\s/u.test(after) && closeAt > index + candidate.length) {
        const content = source.slice(index + candidate.length, closeAt)
        if (content.length && !/^\s|\s$/u.test(content)) { marker = candidate; break }
      }
      const openAt = source.lastIndexOf(candidate, index - candidate.length)
      if (boundaryAfter && before && !/\s/u.test(before) && openAt >= 0) {
        const content = source.slice(openAt + candidate.length, index)
        const openBefore = source[openAt - 1] ?? ''
        const openAfter = source[openAt + candidate.length] ?? ''
        if ((!openBefore || /[\s([{>]/u.test(openBefore)) && openAfter && !/\s/u.test(openAfter) && content.length && !/^\s|\s$/u.test(content)) { marker = candidate; break }
      }
    }
    if (marker) {
      index += marker.length
      continue
    }

    // Decode the most common HTML entities while mapping the display character
    // to the full source entity.
    if (char === '&') {
      const close = source.indexOf(';', index + 1)
      if (close > index && close - index <= 12) {
        const entity = source.slice(index, close + 1)
        const common: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
        let decoded = common[entity.toLowerCase()]
        if (!decoded) {
          const numeric = /^&#(?:x([0-9a-f]+)|(\d+));$/iu.exec(entity)
          if (numeric) {
            const codepoint = Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10)
            if (Number.isFinite(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff) decoded = String.fromCodePoint(codepoint)
          }
        }
        if (decoded) { push(decoded, index, close + 1); index = close + 1; continue }
      }
    }

    push(char, index)
    index++
  }
  return { text, sourceOffsets, sourceEnds }
}

/** Normalize/collapse whitespace while preserving a source offset per character. */
export function normalizeMappedText(
  mapped: MappedText,
  normalizeCharacter: (value: string) => string,
): NormalizedMappedText {
  let text = ''
  const sourceOffsets: number[] = []
  const sourceEnds: number[] = []
  let previousWasSpace = true
  for (let index = 0; index < mapped.text.length; index++) {
    const normalized = normalizeCharacter(mapped.text[index])
    for (const char of normalized) {
      const sourceOffset = mapped.sourceOffsets[index] ?? index
      if (/\s/u.test(char)) {
        if (!previousWasSpace && text.length) {
          text += ' '
          sourceOffsets.push(sourceOffset)
          sourceEnds.push(mapped.sourceEnds[index] ?? sourceOffset + 1)
        }
        previousWasSpace = true
      } else {
        text += char
        for (let unit = 0; unit < char.length; unit++) {
          sourceOffsets.push(sourceOffset)
          sourceEnds.push(mapped.sourceEnds[index] ?? sourceOffset + 1)
        }
        previousWasSpace = false
      }
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    sourceOffsets.pop()
    sourceEnds.pop()
  }
  return { text, sourceOffsets, sourceEnds }
}

/** Shared matcher for text-valued structured fields; wildcard glob is anchored. */
export function matchStructuredText(candidate: string, rawPattern: string, mode: TextMatchMode, rawPatternForGlob?: string): boolean {
  const value = normalizeQueryValue(candidate)
  const pattern = normalizeQueryValue(rawPattern)
  if (!pattern) return false
  switch (mode) {
    case 'exact': return value === pattern
    case 'prefix': return value.startsWith(pattern)
    case 'substring': return value.includes(pattern)
    case 'glob': return globPatternMatches(candidate, rawPatternForGlob ?? rawPattern, normalizeQueryValue)
  }
}
