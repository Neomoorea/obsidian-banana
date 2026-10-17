import { describe, expect, it } from 'vitest'
import {
  applyBooleanOperator,
  collectLiteralSyntaxSpellings,
  combineMatchProvenance,
  compareTypedValues,
  compileTagPattern,
  FIELD_REGISTRY,
  matchTagPattern,
  matchesProgressivePropertyString,
  matchesPropertyString,
  matchesProgressiveEnumValue,
  resolvePropertyNameCandidates,
  parseQueryLanguage,
  type QueryNode,
} from '../search/query-language'

function root(query: string): QueryNode {
  const parsed = parseQueryLanguage(query)
  expect(parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
  expect(parsed.root).not.toBeNull()
  return parsed.root!
}

function operatorShape(node: QueryNode): string {
  if (node.kind === 'binary') return `(${operatorShape(node.left)} ${node.operator} ${operatorShape(node.right)})`
  if (node.kind === 'not') return `(NOT ${operatorShape(node.child)})`
  if (node.kind === 'field') return `${node.field}:${node.value}`
  if (node.kind === 'property') return `property:${node.name}${node.comparison === 'exists' ? '' : node.comparison}`
  if (node.kind === 'tag') return `tag:#${node.pattern}`
  if (node.kind === 'phrase') return `phrase:${node.value}`
  if (node.kind === 'textQuery') return `textQuery:${node.query}`
  if (node.kind === 'literal') return `literal:${node.value}`
  return node.value
}

describe('query language lexer/parser', () => {
  it('collects structured syntax spellings independently from Boolean evaluation', () => {
    const parsed = root('tag:#research AND (section:1 OR property:status=active)')
    expect(collectLiteralSyntaxSpellings(parsed)).toEqual([
      'tag:#research',
      'section:1',
      'property:status=active',
    ])
    expect(collectLiteralSyntaxSpellings(root('NOT content:"machine learning"'))).toEqual([
      'content:"machine learning"',
    ])
    expect(collectLiteralSyntaxSpellings(root('#research'))).toEqual(['#research'])
    expect(collectLiteralSyntaxSpellings(root('machine learning'))).toEqual([])
  })

  it('parses structured predicates instead of treating them as text', () => {
    expect(root('tag:#mytag').kind).toBe('field')
    expect(root('path:"Projects/AI"')).toMatchObject({ kind: 'field', field: 'path', value: 'Projects/AI' })
    expect(root('property:status=active')).toMatchObject({ kind: 'property', name: 'status', comparison: '=', value: 'active' })
    expect(root('property:"project status"="in progress"')).toMatchObject({ kind: 'property', name: 'project status', value: 'in progress' })
  })

  it('supports shared matching modifiers across structured text fields and title aliases', () => {
    expect(root('file:=md')).toMatchObject({ kind: 'field', field: 'file', value: 'md', matchMode: 'exact' })
    expect(root('path:^Projects')).toMatchObject({ kind: 'field', field: 'path', value: 'Projects', matchMode: 'prefix' })
    expect(root('file:*.md')).toMatchObject({ kind: 'field', field: 'file', value: '*.md', matchMode: 'glob' })
    expect(root('tag:=B')).toMatchObject({ kind: 'field', field: 'tag', value: 'B', tagExact: true })
    expect(root('tag:=*/B')).toMatchObject({ kind: 'field', field: 'tag', value: '*/B', tagExact: true })
    expect(parseQueryLanguage('pt:status=active', { fieldAliases: { pt: 'property' } }).root)
      .toMatchObject({ kind: 'property', name: 'status', comparison: '=', value: 'active' })
    expect(parseQueryLanguage('literal:"pt:status"', { fieldAliases: { pt: 'property' } }).root)
      .toMatchObject({ kind: 'literal', value: 'pt:status' })
    // Alias resolution is one-hop and built-in names cannot be redirected.
    expect(parseQueryLanguage('pt:status', { fieldAliases: { pt: 'other', other: 'property' } }).diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('tag:#work', { fieldAliases: { tag: 'property' } }).root)
      .toMatchObject({ kind: 'field', field: 'tag' })
  })

  it('preserves escaped wildcard spelling on nodes that also contain active glob tokens', () => {
    expect(root(String.raw`file:star\*tail*`)).toMatchObject({
      kind: 'field', field: 'file', value: 'star*tail*', matchMode: 'glob', rawValue: String.raw`star\*tail*`,
    })
    expect(root(String.raw`property:status=star\*tail*`)).toMatchObject({
      kind: 'property', name: 'status', value: 'star*tail*', rawValue: String.raw`star\*tail*`,
    })
  })

  it('implements field-specific title modifiers including unquoted exact values', () => {
    expect(root('title:mytitle')).toMatchObject({ kind: 'field', titleMode: 'substring', value: 'mytitle' })
    expect(root('title:=My Project')).toMatchObject({ kind: 'field', titleMode: 'exact', value: 'My Project' })
    expect(root('title:="My Project"')).toMatchObject({ kind: 'field', titleMode: 'exact', value: 'My Project' })
    expect(root('title:^"My Pro"')).toMatchObject({ kind: 'field', titleMode: 'prefix', value: 'My Pro' })
    expect(root('title:~"Project Notes"')).toMatchObject({ kind: 'field', titleMode: 'substring', value: 'Project Notes' })
  })

  it('uses the specified precedence and left associativity', () => {
    expect(operatorShape(root('tag:#work OR tag:#personal AND content:meeting')))
      .toBe('(tag:work OR (tag:personal AND content:meeting))')
    expect(operatorShape(root('(tag:#work OR tag:#personal) AND content:meeting')))
      .toBe('((tag:work OR tag:personal) AND content:meeting)')
    expect(operatorShape(root('tag:#a XOR tag:#b XOR tag:#c')))
      .toBe('((tag:a XOR tag:b) XOR tag:c)')
    expect(operatorShape(root('NOT (tag:#archived OR property:status=deleted)')))
      .toBe('(NOT (tag:archived OR property:status=))')
  })

  it('supports implicit AND while leaving ordinary lower-case words alone', () => {
    expect(operatorShape(root('machine learning OR tag:#research')))
      .toBe('(textQuery:machine learning OR tag:research)')
    expect(parseQueryLanguage('candy').isAdvanced).toBe(false)
    expect(parseQueryLanguage('and or not').isAdvanced).toBe(false)
    expect(parseQueryLanguage('C:\\Users').isAdvanced).toBe(false)
    expect(root('"AND OR NOT XOR && ||"')).toMatchObject({ kind: 'phrase', value: 'AND OR NOT XOR && ||' })
  })

  it('recognizes symbolic aliases and preserves field comparisons', () => {
    expect(operatorShape(root('tag:#a && tag:#b'))).toContain('AND')
    expect(operatorShape(root('tag:#a !&& tag:#b'))).toContain('NAND')
    expect(operatorShape(root('path:Projects -tag:#archived'))).toBe('(path:Projects AND (NOT tag:archived))')
    expect(operatorShape(root('tag:#a || tag:#b'))).toContain('OR')
    expect(operatorShape(root('tag:#a !|| tag:#b'))).toContain('NOR')
    expect(operatorShape(root('tag:#a ^ tag:#b'))).toContain('XOR')
    expect(operatorShape(root('tag:#a ↔ tag:#b'))).toContain('XNOR')
    expect(root('property:status!=archived')).toMatchObject({ kind: 'property', comparison: '!=' })
  })

  it('reports malformed structured queries instead of silently falling back to text', () => {
    for (const query of ['tag:#bad/', '(tag:#work', 'tag:#work OR', 'foo:bar', 'property:>=3', 'section:meeting AND']) {
      const parsed = parseQueryLanguage(query)
      expect(parsed.isAdvanced).toBe(true)
      expect(parsed.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
    }
  })

  it('keeps empty known-field values quiet while typing', () => {
    for (const query of ['path:', 'title:', 'file:', 'format:', 'type:', 'has:', 'literal:', 'tag:', 'tag:#', 'tag:=', 'property:', 'property:status=', 'property:status>=', 'size:>=', 'created:>']) {
      expect(parseQueryLanguage(query).diagnostics.filter(diagnostic => diagnostic.severity === 'error'), query).toEqual([])
    }
  })

  it('parses tag predicates distinctly while leaving literal matching to the evaluator', () => {
    expect(root('#research')).toMatchObject({ kind: 'tag', pattern: 'research', bare: true })
    expect(root('tag:#research')).toMatchObject({ kind: 'field', field: 'tag', value: 'research' })
    // Search evaluation independently checks raw text for the query spelling,
    // so explicit predicates can yield Semantic, Literal, or Both results.
  })

  it('preserves literal syntax and punctuation-only searches', () => {
    expect(root('literal:"tag:#mytag"')).toMatchObject({ kind: 'literal', value: 'tag:#mytag' })
    expect(root('%%')).toMatchObject({ kind: 'text', value: '%%' })
    expect(root('%%%')).toMatchObject({ kind: 'text', value: '%%%' })
    expect(root('literal:"%%"')).toMatchObject({ kind: 'literal', value: '%%' })
    expect(root('"\\\\\\""')).toBeTruthy()
  })
})

describe('field registry', () => {
  it('publishes real sources, types, matching and missing-value rules for implemented fields', () => {
    expect(FIELD_REGISTRY.tag.source).toContain('CachedMetadata')
    expect(FIELD_REGISTRY.property.operators).toContain('~=')
    expect(FIELD_REGISTRY.created.source).toContain('ctime')
    for (const field of ['block', 'section', 'tagcount', 'linkcount', 'backlinkcount', 'contains', 'is', 'empty', 'orphan', 'wordcount', 'inlinks', 'outlinks', 'taskcount']) {
      expect(FIELD_REGISTRY, field).toHaveProperty(field)
    }
  })

  it('keeps progressive enum values valid while typing and treats empty tag: as has:tag', () => {
    for (const query of ['format:mark', 'type:no', 'has:ta', 'is:att', 'empty:tr', 'orphan:f']) {
      expect(parseQueryLanguage(query).diagnostics.filter(d => d.severity === 'error')).toEqual([])
    }
    expect(parseQueryLanguage('format:blargh').diagnostics.some(d => d.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('type:unknown').diagnostics.some(d => d.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('has:unknown').diagnostics.some(d => d.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('tag:')).toMatchObject({ root: { kind: 'field', field: 'has', value: 'tag' }, diagnostics: [] })
    // An unfinished comparison is a quiet, non-matching editing state.
    expect(parseQueryLanguage('property:status=').diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(parseQueryLanguage('property:').diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(parseQueryLanguage('is:unsupported').diagnostics.some(d => d.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('empty:maybe').diagnostics.some(d => d.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('tagcount:>=2').root).toMatchObject({ kind: 'field', field: 'tagcount', comparison: '>=', value: '2' })
    expect(parseQueryLanguage('wordcount:>10').root).toMatchObject({ kind: 'field', field: 'wordcount', comparison: '>', value: '10' })
  })

  it('keeps property comparisons typed and allows validated format alternatives', () => {
    expect(compareTypedValues(3, '3', '=')).toBe(false)
    expect(compareTypedValues(3, '3', '!=')).toBe(true)
    expect(compareTypedValues(30, 3, '>')).toBe(true)
    expect(compareTypedValues('beta', 'alpha', '>')).toBe(true)
    expect(compareTypedValues('Active  Status', 'active status', '=')).toBe(true)
    expect(compareTypedValues('ＡＣＴＩＶＥ', 'active', '=')).toBe(true)
    expect(compareTypedValues('Project  Alpha', 'alpha', '~=')).toBe(true)
    expect(compareTypedValues('active', 'archived', '!=')).toBe(true)
    expect(compareTypedValues(true, false, '>')).toBe(false)
    expect(parseQueryLanguage('format:"pdf office"').diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(parseQueryLanguage('type:"note document"').diagnostics.filter(d => d.severity === 'error')).toEqual([])
  })

  it('resolves property-name prefixes during typing but prefers complete keys', () => {
    expect(resolvePropertyNameCandidates(['status', 'status-note', 'priority'], 'sta'))
      .toEqual(['status', 'status-note'])
    expect(resolvePropertyNameCandidates(['status', 'status-note', 'priority'], 'status'))
      .toEqual(['status'])
    expect(resolvePropertyNameCandidates(['status', 'priority'], 'st')).toEqual(['status'])
  })

  it('matches unquoted property string prefixes progressively and keeps quoted values exact', () => {
    expect(matchesProgressivePropertyString('active', 'acti', 'acti')).toBe(true)
    expect(matchesProgressivePropertyString('active', 'active', 'active')).toBe(true)
    expect(matchesProgressivePropertyString('inactive', 'acti', 'acti')).toBe(false)
    expect(matchesProgressivePropertyString('active', 'acti', '"acti"')).toBe(false)
    expect(matchesProgressivePropertyString('active', 'act', 'act*')).toBe(false)
    expect(matchesPropertyString('active', '^act', '^act')).toBe(true)
    expect(matchesPropertyString('inactive', '^act', '^act')).toBe(false)
    expect(matchesPropertyString('inactive', '~tiv', '~tiv')).toBe(true)
    expect(matchesPropertyString('active', '*tive', '*tive')).toBe(true)
    expect(matchesPropertyString('active', 'active', '"active"')).toBe(false) // strict equality is handled by the typed comparator
    // Raw escape information must survive decoding when a pattern mixes a
    // literal asterisk with a later active wildcard.
    expect(matchesPropertyString('star*tail-final', 'star*tail*', String.raw`star\*tail*`)).toBe(true)
    expect(matchesPropertyString('starXtail-final', 'star*tail*', String.raw`star\*tail*`)).toBe(false)
  })

  it('matches enum-like field values progressively without treating an empty value as a match', () => {
    expect(matchesProgressiveEnumValue('markdown', 'mark')).toBe(true)
    expect(matchesProgressiveEnumValue('note', 'no')).toBe(true)
    expect(matchesProgressiveEnumValue('md', 'm')).toBe(true)
    expect(matchesProgressiveEnumValue('false', 'f')).toBe(true)
    expect(matchesProgressiveEnumValue('markdown', '')).toBe(false)
    expect(matchesProgressiveEnumValue('image', 'mark')).toBe(false)
  })

  it('accepts progressive boolean task-field values but respects exact mode', () => {
    for (const value of ['t', 'tr', 'tru', 'f', 'fa', 'fal']) {
      expect(parseQueryLanguage(`task-todo:${value}`).diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    }
    expect(parseQueryLanguage('task-todo:=true').diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(parseQueryLanguage('task-todo:=t').diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('task-todo:maybe').diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
  })

  it('keeps enum fields live while typing, including explicit modifiers', () => {
    for (const query of ['format:mark', 'format:=markdown', 'format:^mark', 'format:~ark', 'format:m*', 'type:no', 'has:ta']) {
      expect(parseQueryLanguage(query).diagnostics.filter(diagnostic => diagnostic.severity === 'error'), query).toEqual([])
    }
    expect(parseQueryLanguage('format:=mark').diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
    expect(parseQueryLanguage('format:bogus').diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
  })

  it('treats a trailing property comparison as incomplete rather than invalid syntax', () => {
    const bare = parseQueryLanguage('property:')
    expect(bare.root).toMatchObject({ kind: 'property', name: '', comparison: 'exists' })
    expect(bare.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    const parsed = parseQueryLanguage('property:status=')
    expect(parsed.root).toMatchObject({ kind: 'property', name: 'status', comparison: '=', value: undefined, rawValue: '' })
    expect(parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(parseQueryLanguage('property:status=acti').root).toMatchObject({ kind: 'property', name: 'status', comparison: '=', value: 'acti' })
  })
})

describe('Boolean truth tables and provenance', () => {
  const combinations = [
    { a: false, b: false, values: [false, false, false, true, true, true] },
    { a: false, b: true, values: [false, true, true, true, false, false] },
    { a: true, b: false, values: [false, true, true, true, false, false] },
    { a: true, b: true, values: [true, true, false, false, false, true] },
  ] as const
  it('matches the formal truth table for every Boolean operator', () => {
    const operators = ['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR'] as const
    for (const row of combinations) {
      expect(operators.map(operator => applyBooleanOperator(operator, row.a, row.b))).toEqual(row.values)
    }
  })

  it('keeps literal provenance from masquerading as a semantic match', () => {
    expect(combineMatchProvenance('AND', { semantic: false, literal: true }, { semantic: true, literal: false }))
      .toMatchObject({ matched: true, provenance: { semantic: true, literal: true } })
    expect(combineMatchProvenance('OR', { semantic: true, literal: false }, { semantic: false, literal: true }))
      .toMatchObject({ matched: true, provenance: { semantic: true, literal: true } })
    expect(combineMatchProvenance('XOR', { semantic: false, literal: true }, null))
      .toMatchObject({ matched: true, provenance: { semantic: false, literal: true } })
    expect(combineMatchProvenance('OR', { semantic: false, literal: true }, { semantic: true, literal: false }))
      .toMatchObject({ matched: true, provenance: { semantic: true, literal: true } })
  })
})

describe('DAGtags segment wildcard compatibility', () => {
  const fixtures = ['A/B', 'C/B', 'C/BB', 'C/BC', 'C/CB', 'D/B/F']
  const matches = (pattern: string) => {
    const compiled = compileTagPattern(pattern)
    expect(compiled).not.toBeNull()
    return fixtures.filter(tag => matchTagPattern(compiled!, tag))
  }

  it('matches machine-learning subtags regardless of the root segment', () => {
    const compiled = compileTagPattern('*/machine-learning')
    expect(compiled).not.toBeNull()
    expect(['AI/machine-learning', 'article/machine-learning', 'conference/machine-learning']
      .every(tag => matchTagPattern(compiled!, tag))).toBe(true)
  })

  it('#*/B matches B-prefixed leaf segments, but not CB or deeper descendants', () => {
    expect(matches('*/B')).toEqual(['A/B', 'C/B', 'C/BB', 'C/BC'])
  })
  it('#*/B* stays anchored to the start of a segment and never crosses /', () => {
    expect(matches('*/B*')).toEqual(['A/B', 'C/B', 'C/BB', 'C/BC'])
    expect(matches('*/B*')).not.toContain('C/CB')
    expect(matches('*/B*')).not.toContain('D/B/F')
  })
  it('#*/BB is distinct from #*/B and #*/CB', () => {
    expect(matches('*/BB')).toEqual(['C/BB'])
  })
  it('exact wildcard paths match the full segment, not a prefix', () => {
    const exact = (pattern: string) => {
      const compiled = compileTagPattern(pattern, { exact: true })!
      return fixtures.filter(tag => matchTagPattern(compiled, tag))
    }
    expect(exact('*/B')).toEqual(['A/B', 'C/B'])
    expect(exact('*/BC')).toEqual(['C/BC'])
    expect(exact('*/BB')).toEqual(['C/BB'])
  })
  it('handles globstar as a whole-segment descendant wildcard', () => {
    expect(matches('*/B/**')).toEqual(['A/B', 'C/B', 'C/BB', 'C/BC', 'D/B/F'])
    expect(matches('**/B')).toEqual(['A/B', 'C/B', 'C/BB', 'C/BC'])
    expect(matches('**/B/**')).toEqual(['A/B', 'C/B', 'C/BB', 'C/BC', 'D/B/F'])
  })
  it('supports progressive single-segment tags and explicit exact whole paths', () => {
    const all = ['B', 'BB', 'B/C', 'B/C/D', 'A/B', 'A/BB']
    const matchAll = (pattern: string, exact = false) => {
      const compiled = compileTagPattern(pattern, { exact })!
      return all.filter(tag => matchTagPattern(compiled, tag))
    }
    expect(matchAll('B')).toEqual(['B', 'BB', 'B/C', 'B/C/D'])
    expect(matchAll('B', true)).toEqual(['B'])
    expect(matchAll('*/B', true)).toEqual(['A/B'])
    expect(matchAll('*/B')).toEqual(['A/B', 'A/BB'])
  })
  it('keeps an explicit root descendant pattern distinct from a longer root prefix', () => {
    const compiled = compileTagPattern('B/**')!
    expect(['B', 'B/C', 'B/C/D', 'BB', 'BB/C'].filter(tag => matchTagPattern(compiled, tag)))
      .toEqual(['B', 'B/C', 'B/C/D'])
  })
  it('supports partial segments, case-insensitive matching, escaping and invalid paths', () => {
    const compiled = compileTagPattern('proj*/B')
    expect(matchTagPattern(compiled!, 'project/B')).toBe(true)
    expect(matchTagPattern(compiled!, 'projects/B')).toBe(true)
    expect(matchTagPattern(compiled!, 'project/x/B')).toBe(false)
    expect(matchTagPattern(compileTagPattern('*/b')!, 'A/B')).toBe(true)
    expect(matchTagPattern(compileTagPattern('\\*/B')!, '*/B')).toBe(true)
    expect(compileTagPattern('*/B/')).toBeNull()
    expect(compileTagPattern('A//B')).toBeNull()
  })
})
