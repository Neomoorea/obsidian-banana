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

  it('keeps the typed spelling of a predicate that is wrapped in parentheses', () => {
    expect(root('(section:1)')).toMatchObject({ kind: 'field', field: 'section', raw: 'section:1' })
    expect(collectLiteralSyntaxSpellings(root('NOT ((tag:#research)) AND (property:status=active)'))).toEqual([
      'tag:#research',
      'property:status=active',
    ])
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
    const redirected = parseQueryLanguage('pt:status', { fieldAliases: { pt: 'other', other: 'property' } })
    expect(redirected.root).not.toMatchObject({ kind: 'property' })
    expect(redirected.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(['warning'])
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

  it('ends a title value at its closing quote or parenthesis instead of absorbing later words', () => {
    expect(operatorShape(root('title:"AI Roadmap" budget'))).toBe('(title:AI Roadmap AND budget)')
    expect(operatorShape(root('title:="My Project" meeting'))).toBe('(title:My Project AND meeting)')
    expect(operatorShape(root('title:^"My Pro" meeting'))).toBe('(title:My Pro AND meeting)')
    expect(operatorShape(root('(title:=AI) Roadmap'))).toBe('(title:AI AND Roadmap)')
    // An unquoted exact or prefix value still continues across spaces, also inside a group.
    expect(operatorShape(root('(title:=AI Roadmap) AND tag:#x'))).toBe('(title:AI Roadmap AND tag:x)')
    expect(operatorShape(root('title:^AI Road tag:#x'))).toBe('(title:AI Road AND tag:x)')
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
    for (const query of ['tag:#bad/', '(tag:#work', 'tag:#work OR', 'property:>=3', 'section:meeting AND', 'size:>abc', 'created:>soon', 'literal:"azerty', 'literal:="azerty']) {
      const parsed = parseQueryLanguage(query)
      expect(parsed.isAdvanced).toBe(true)
      expect(parsed.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
    }
  })

  it('hints at empty known-field values instead of raising an error while typing', () => {
    for (const query of ['path:', 'title:', 'file:', 'format:', 'type:', 'has:', 'literal:', 'tag:=', 'property:', 'property:status=', 'property:status>=', 'size:>=', 'created:>', 'title:""']) {
      const diagnostics = parseQueryLanguage(query).diagnostics
      expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error'), query).toEqual([])
      expect(diagnostics.filter(diagnostic => diagnostic.severity === 'warning').map(diagnostic => diagnostic.message), query)
        .toEqual([expect.stringContaining('has no value yet, so it matches nothing.')])
    }
    // `tag:` alone lists every tagged note, so it has nothing to hint at.
    for (const query of ['tag:', 'tag:#']) expect(parseQueryLanguage(query).diagnostics, query).toEqual([])
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

describe('query language: multiword values, plain text, exclusion and exemptions', () => {
  const errors = (query: string, options: Parameters<typeof parseQueryLanguage>[1] = {}) =>
    parseQueryLanguage(query, options).diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => diagnostic.message)
  const hints = (query: string, options: Parameters<typeof parseQueryLanguage>[1] = {}) =>
    parseQueryLanguage(query, options).diagnostics.filter(diagnostic => diagnostic.severity === 'warning').map(diagnostic => diagnostic.message)

  it('reads an unquoted exact or prefix value of a text field as multiword, wherever the predicate appears', () => {
    expect(operatorShape(root('tag:#x title:=AI Roadmap'))).toBe(operatorShape(root('tag:#x title:="AI Roadmap"')))
    expect(operatorShape(root('NOT title:=AI Roadmap'))).toBe('(NOT title:AI Roadmap)')
    expect(operatorShape(root('-title:=AI Roadmap'))).toBe('(NOT title:AI Roadmap)')
    expect(root('section:=AI LLM')).toMatchObject({ kind: 'field', field: 'section', matchMode: 'exact', value: 'AI LLM' })
    expect(root('contains:=Exact phrase')).toMatchObject({ kind: 'field', field: 'contains', matchMode: 'exact', value: 'Exact phrase' })
    expect(root('title:= AI LLM*')).toMatchObject({ kind: 'field', field: 'title', matchMode: 'exact', globPattern: 'AI LLM*' })
    // The value ends at an exclusion, a field or a quoted phrase. Enum fields stay single-word.
    expect(operatorShape(root('title:=AI -draft'))).toBe('(title:AI AND (NOT draft))')
    expect(operatorShape(root('is:=todo meeting'))).toBe('(is:todo AND meeting)')
    // Unquoted values without a modifier are one word followed by an ordinary search.
    expect(operatorShape(root('title:AI Roadmap'))).toBe('(title:AI AND Roadmap)')
  })

  it('keeps wildcards active in every unquoted form and literal when quoted or escaped', () => {
    expect(root('title:=AI *LLM')).toMatchObject({ matchMode: 'exact', globPattern: 'AI *LLM' })
    expect(root('title:^AI*')).toMatchObject({ matchMode: 'prefix', globPattern: 'AI*' })
    expect(root('title:~AI*')).toMatchObject({ matchMode: 'substring', globPattern: 'AI*' })
    expect(root('file:*.md')).toMatchObject({ matchMode: 'glob', globPattern: '*.md' })
    expect((root('title:="AI *LLM"') as { globPattern?: string }).globPattern).toBeUndefined()
    expect((root('title:"AI *LLM"') as { globPattern?: string }).globPattern).toBeUndefined()
    expect((root('title:=AI\\*LLM') as { globPattern?: string }).globPattern).toBeUndefined()
  })

  it('treats parentheses as plain text unless the query already uses query syntax', () => {
    for (const text of ['foo(bar', 'foo (bar baz)', '(foo', 'foo)']) {
      const parsed = parseQueryLanguage(text)
      expect(parsed.diagnostics).toEqual([])
      expect(parsed.isAdvanced).toBe(false)
    }
    expect(operatorShape(root('tag:#a (foo OR bar)'))).toBe('(tag:a AND (foo OR bar))')
    expect(operatorShape(root('(foo OR bar)'))).toBe('(foo OR bar)')
  })

  it('reads punctuation inside a word as text even in a structured query', () => {
    expect(errors('tag:#a foo(bar')).toEqual([])
    expect(operatorShape(root('tag:#a foo(bar'))).toBe('(tag:a AND foo(bar)')
    expect(operatorShape(root('tag:#a foo(bar)'))).toBe('(tag:a AND foo(bar))')
    expect(operatorShape(root('(foo(bar) OR baz)'))).toBe('(foo(bar) OR baz)')
    expect(operatorShape(root('tag:#a R&D'))).toBe('(tag:a AND R&D)')
    expect(operatorShape(root('tag:#a x^2'))).toBe('(tag:a AND x^2)')
    // A group still needs to be closed, and a quote still needs its partner.
    expect(errors('tag:#a (foo')).toEqual(['Unmatched opening parenthesis.'])
    expect(errors('tag:#a "for test')).toEqual(['Unterminated quoted phrase.'])
    // A closing parenthesis that closes nothing is text.
    expect(errors('tag:#a smile :)')).toEqual([])
  })

  it('reads a query without fields, tags or Boolean operators as free text', () => {
    for (const text of ['foo(bar', 'foo(bar)', '"for test', 'say "hi', 'R&D', 'x^2', 'wow!', '!important', 'AI LLM*', 'what? really']) {
      const parsed = parseQueryLanguage(text)
      expect(parsed.diagnostics).toEqual([])
      expect(parsed.isAdvanced).toBe(false)
    }
    // Spaced `&`, `^` and a lone `!` occur in prose and stay text, so they never raise errors.
    for (const text of ['Q & A', '2 ^ 3', 'Bonjour !', 'smile :)']) expect(parseQueryLanguage(text).diagnostics).toEqual([])
    expect(root('Bonjour !')).toMatchObject({ kind: 'textQuery', query: 'Bonjour !' })
    // A complete quoted phrase is still a phrase.
    expect(root('"for test"')).toMatchObject({ kind: 'phrase', value: 'for test' })
  })

  it('recognises a symbolic operator only when it stands alone', () => {
    expect(operatorShape(root('a && b'))).toBe('(a AND b)')
    expect(operatorShape(root('a || b'))).toBe('(a OR b)')
    expect(operatorShape(root('tag:#a & tag:#b'))).toBe('(tag:a AND tag:b)')
    expect(operatorShape(root('(tag:#a)&&(tag:#b)'))).toBe('(tag:a AND tag:b)')
    expect(operatorShape(root('(a OR b)AND(c)'))).toBe('((a OR b) AND c)')
    expect(operatorShape(root('NOT(tag:#x)'))).toBe('(NOT tag:x)')
    expect(operatorShape(root('tag:#a !foo'))).toBe('(tag:a AND (NOT foo))')
    // Glued to a field value it is part of the value, so spaces are needed between operands.
    expect(root('tag:#a&&tag:#b')).toMatchObject({ kind: 'field', field: 'tag', value: 'a&&tag:#b' })
  })

  it('negates a group with a leading hyphen like NOT', () => {
    expect(operatorShape(root('-(a OR b)'))).toBe(operatorShape(root('NOT (a OR b)')))
    expect(operatorShape(root('-(tag:#x OR tag:#y) foo'))).toBe('((NOT (tag:x OR tag:y)) AND foo)')
    // A hyphen inside a word is not an exclusion.
    expect(parseQueryLanguage('a-(b)').isAdvanced).toBe(false)
  })

  it('searches `word: text` as plain text and hints only at probable fields', () => {
    const warnings = (query: string) =>
      parseQueryLanguage(query, { fieldAliases: { pt: 'property' } }).diagnostics.filter(diagnostic => diagnostic.severity === 'warning').map(diagnostic => diagnostic.message)
    const parsed = parseQueryLanguage('title: foo')
    expect(parsed.isAdvanced).toBe(false)
    expect(parsed.root).toMatchObject({ kind: 'textQuery', query: 'title: foo' })
    expect(parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(warnings('title: foo')).toEqual(['"title:" needs a value right after the colon. Searching for the text literally.'])
    expect(warnings('pt: x')).toEqual(['"pt:" needs a value right after the colon. Searching for the text literally.'])
    expect(warnings('tga: foo')).toEqual(['Unknown field "tga:", did you mean "tag:"? Searching for the text literally.'])
    // Ordinary prose stays silent. A field word that ends the query only says it has no value yet.
    expect(warnings('Note: remember the milk')).toEqual([])
    expect(warnings('Re: hello')).toEqual([])
    expect(warnings('title:')).toEqual(['"title:" has no value yet, so it matches nothing.'])
    // In a structured query the same words stay text next to the predicate.
    expect(operatorShape(root('tag:#a title: foo'))).toBe('(tag:a AND textQuery:title: foo)')
  })

  it('searches an unknown field as plain text and says so in a hint', () => {
    const parsed = parseQueryLanguage('foo:bar')
    expect(parsed.isAdvanced).toBe(false)
    expect(parsed.root).toMatchObject({ kind: 'text', value: 'foo:bar' })
    expect(operatorShape(root('tag:#a foo:bar baz'))).toBe('(tag:a AND textQuery:foo:bar baz)')
    expect(hints('foo:bar')).toEqual(['Unknown field "foo:". Searching for the text literally.'])
    expect(hints('tga:#x')).toEqual(['Unknown field "tga:", did you mean "tag:"? Searching for the text literally.'])
    // A known field next to it keeps working normally.
    expect(operatorShape(root('title:AI foo:bar'))).toBe('(title:AI AND foo:bar)')
  })

  it('rejects values that a numeric or date field can never match', () => {
    expect(errors('size:>abc')).toEqual(['Invalid size "abc". Use a number with an optional unit (B, KB, KiB, MB, MiB, GB, GiB), for example size:>1MB.'])
    expect(errors('words:>many')).toEqual(['Invalid number "many" for words:. Use a number, for example words:>10.'])
    expect(errors('created:>soon')).toEqual(['Invalid date "soon" for created:. Use a date such as created:>2026-01-31.'])
    expect(errors('size:>1MB words:>=10 modified:<2026-01-31 linkcount:=0')).toEqual([])
  })

  it('says so when a query can never match', () => {
    for (const query of ['""', '-""', 'NOT ""']) expect(hints(query), query).toEqual(['Empty quotes match nothing.'])
    expect(errors('tag:^AI')).toEqual(['Tags have no "^" form: tag:AI already matches from the start, and tag:=AI matches exactly.'])
    expect(errors('tag:~AI')).toHaveLength(1)
    expect(hints('literal:="azerty"')).toEqual(['"literal:" searches the text as typed, so the "=" is part of it. Write literal:"…" to search the words alone.'])
    expect(hints('literal:"azerty"')).toEqual([])
  })

  it('reports an unterminated quote in a field value instead of staying silent', () => {
    expect(errors('literal:"azerty')).toEqual(['Unterminated quoted value.'])
    expect(errors('literal:="azerty')).toEqual(['Unterminated quoted value.'])
    expect(errors('title:"AI Roadmap')).toEqual(['Unterminated quoted value.'])
  })

  it('keeps names and paths single-word after a modifier', () => {
    expect(operatorShape(root('path:^Projects/ meeting'))).toBe('(path:Projects/ AND meeting)')
    expect(operatorShape(root('folder:=Projects meeting'))).toBe('(folder:Projects AND meeting)')
    expect(operatorShape(root('file:=Plan.md meeting'))).toBe('(file:Plan.md AND meeting)')
    expect(operatorShape(root('outlinks:^Projects/ budget'))).toBe('(outlinks:Projects/ AND budget)')
    expect(operatorShape(root('path:="Projects/AI Roadmap"'))).toBe('path:Projects/AI Roadmap')
    expect(root('title:=AI Roadmap')).toMatchObject({ field: 'title', value: 'AI Roadmap' })
  })

  it('honours a backslash before parentheses, quotes and carets outside quotes', () => {
    expect(errors('foo\\(bar')).toEqual([])
    expect(errors('say \\"hi\\"')).toEqual([])
    expect(errors('tag:#a foo\\(bar')).toEqual([])
    expect(operatorShape(root('tag:#a foo\\(bar'))).toBe('(tag:a AND foo(bar)')
    expect(operatorShape(root('a\\^b'))).toBe('a^b')
    expect(root('title:\\"hi\\"')).toMatchObject({ field: 'title', matchMode: 'substring', value: '"hi"' })
    expect(root('title:"hi"')).toMatchObject({ field: 'title', matchMode: 'substring', value: 'hi' })
  })

  it('makes a leading hyphen behave like NOT and reports unknown fields behind it', () => {
    for (const [hyphen, keyword] of [
      ['-tag:#archived', 'NOT tag:#archived'],
      ['-#draft', 'NOT #draft'],
      ['-title:foo', 'NOT title:foo'],
      ['-literal:foo:bar', 'NOT literal:"foo:bar"'],
    ]) expect(operatorShape(root(hyphen))).toBe(operatorShape(root(keyword)))
    // An unknown field is a hint, not an error, and the word is searched as plain text.
    const hint = 'Unknown field "foo:". Searching for the text literally.'
    for (const query of ['foo:bar', 'NOT foo:bar', '-foo:bar']) {
      expect(errors(query), query).toEqual([])
      expect(hints(query), query).toEqual([hint])
    }
    expect(operatorShape(root('-foo:bar'))).toBe(operatorShape(root('NOT foo:bar')))
    expect(hints('-tga:#archived')).toEqual(['Unknown field "tga:", did you mean "tag:"? Searching for the text literally.'])
  })

  it('never reads a hyphen inside a value as an exclusion', () => {
    expect(root('title:-foo')).toMatchObject({ kind: 'field', field: 'title', value: '-foo' })
    expect(root('tag:-foo')).toMatchObject({ kind: 'field', field: 'tag', value: '-foo' })
  })

  it('lets the literal prefix list decide which field-like words are plain text', () => {
    // Exempt words are plain text without any hint; others are plain text with the unknown-field hint.
    for (const text of ['https://example.com', '-https://example.com', 'NOT https://example.com', 'C:\\Users', '-C:\\Users', 'C:/Users']) {
      expect(parseQueryLanguage(text).diagnostics, text).toEqual([])
    }
    expect(root('title:https://example.com')).toMatchObject({ field: 'title', value: 'https://example.com' })
    expect(hints('https://example.com', { literalPrefixes: [] })).toEqual(['Unknown field "https:". Searching for the text literally.'])
    expect(hints('-https://example.com', { literalPrefixes: [] })).toEqual(['Unknown field "https:". Searching for the text literally.'])
    expect(hints('C:\\Users', { literalPrefixes: [] })).toEqual(['Unknown field "c:". Searching for the text literally.'])
    expect(parseQueryLanguage('ftp://host', { literalPrefixes: ['ftp://'] }).diagnostics).toEqual([])
    expect(hints('https://host', { literalPrefixes: ['ftp://'] })).toEqual(['Unknown field "https:". Searching for the text literally.'])
  })

  it('rejects text glued after a closing quote instead of dropping it', () => {
    const message = ['Unexpected text after closing quote.']
    expect(errors('path:"Projects"/Archive')).toEqual(message)
    expect(errors('file:"AI Roadmap".md')).toEqual(message)
    expect(errors('title:="A B"x')).toEqual(message)
    expect(errors('property:name="x"y')).toEqual(message)
    expect(errors('literal:"x"y')).toEqual(message)
    expect(errors('file:"AI Roadmap.md"')).toEqual([])
    expect(errors('property:"project status"="in progress"')).toEqual([])
  })

  it('resolves an alias of literal and ignores an alias that is not a valid field name', () => {
    const fieldAliases = { lit: 'literal' }
    expect(parseQueryLanguage('lit:"tag:#AI"', { fieldAliases }).root).toMatchObject({ kind: 'literal', value: 'tag:#AI' })
    expect(parseQueryLanguage('-lit:x', { fieldAliases }).root).toMatchObject({ kind: 'not', child: { kind: 'literal', value: 'x' } })
    const inert = parseQueryLanguage('-p_t:x', { fieldAliases: { p_t: 'property' } })
    expect(inert.root).toMatchObject({ kind: 'not', child: { kind: 'text' } })
    expect(inert.diagnostics).toEqual([])
  })

  it('accepts wildcards behind a modifier for enum values', () => {
    expect(errors('format:=mark*')).toEqual([])
    expect(errors('format:^mark*')).toEqual([])
    expect(errors('format:~*down')).toEqual([])
    expect(errors('format:=zz*')).toHaveLength(1)
  })
})
