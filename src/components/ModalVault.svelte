<script lang="ts">
  import { MarkdownView, Notice, Platform, TFile, debounce } from 'obsidian'
  import { onDestroy, onMount, tick, untrack } from 'svelte'
  import InputSearch from './InputSearch.svelte'
  import ModalContainer from './ModalContainer.svelte'
  import {
    eventBus,
    indexingStep,
    IndexingStepType,
    type ResultNote,
    SPACE_OR_PUNCTUATION,
    Action,
  } from '../globals'
  import { createNote, openNote } from '../tools/notes'
  import {
    getCtrlKeyLabel,
    getAltKeyLabel,
    getExtension,
    isFilePDF,
    isModKeyPressed,
    loopIndex,
  } from '../tools/utils'
  import {
    BananaInFileModal,
    type BananaVaultModal,
  } from '../components/modals'
  import ResultItemVault from './ResultItemVault.svelte'
  import { Query } from '../search/query'
  import { cancelable, CancelablePromise } from 'cancelable-promise'
  import type BananaPlugin from '../main'
  import type { QueryNode } from '../search/query-language'
  import LazyLoader from './lazy-loader/LazyLoader.svelte'

  let {
    modal,
    previousQuery,
    plugin,
  }: {
    modal: BananaVaultModal
    previousQuery?: string | undefined
    plugin: BananaPlugin
  } = $props()

  let selectedIndex = $state(0)
  let historySearchIndex = 0
  let searchQuery = $state(untrack(() => previousQuery ?? ''))
  let resultNotes: ResultNote[] = $state([])
  let allResultNotes: ResultNote[] = $state([])
  let hideLiteralOnly = $state(false)
  let diagnosticsVisible = $state(false)
  let queryRequestId = 0
  let query: Query = $state(new Query('', { ignoreDiacritics: false, ignoreArabicDiacritics: false, fieldAliases: untrack(() => plugin.settings.queryFieldAliases), literalPrefixes: untrack(() => plugin.settings.queryLiteralPrefixes) }))
  let indexingStepDesc = $state('')
  let searching = $state(true)
  let refInput: InputSearch | undefined
  const openInCurrentPaneKey = '↵'
  const openInNewPaneKey = `${getCtrlKeyLabel()} ↵`
  const createInCurrentPaneKey = 'Shift ↵'
  const createInNewPaneKey = `${getCtrlKeyLabel()} Shift ↵`
  const openInNewLeafKey = `${getCtrlKeyLabel()} ${getAltKeyLabel()} ↵`

  const selectedNote = $derived(resultNotes[selectedIndex])
  const uniqueResultCount = $derived(new Set(resultNotes.map(note => note.path)).size)
  const isLiteralOnly = (note: ResultNote): boolean => {
    const provenance = note.provenance
    return !!provenance?.literal && !provenance.semantic
  }
  const literalOnlyCount = $derived(new Set(allResultNotes.filter(isLiteralOnly).map(note => note.path)).size)
  const hasQueryErrors = $derived(query.language.diagnostics.some(diagnostic => diagnostic.severity === 'error'))
  const queryErrors = $derived(query.language.diagnostics.filter(diagnostic => diagnostic.severity === 'error'))
  // A warning is only a hint about how the text is searched; it never makes the query invalid.
  const queryHint = $derived(queryErrors.length ? null : query.language.diagnostics.find(diagnostic => diagnostic.severity === 'warning')?.message ?? null)
  const queryDiagnosticState = $derived(queryErrors.length === 0 ? null : queryErrors.every(diagnostic => /missing (?:value|tag pattern|comparison value)|unterminated|requires (?:a right operand|an expression)|expected a query expression|expected property:/iu.test(diagnostic.message)) ? 'incomplete' : 'invalid')
  const quietlyIncomplete = $derived(isQuietlyIncomplete(query.language.root))

  function isQuietlyIncomplete(node: QueryNode | null): boolean {
    if (!node) return false
    if (node.kind === 'property') {
      return !node.name.trim() || (node.comparison !== 'exists' && node.value === undefined && !(node.rawValue ?? '').trim())
    }
    if (node.kind === 'field') return !node.value.trim()
    if (node.kind === 'literal') return !node.value.trim()
    if (node.kind === 'not') return isQuietlyIncomplete(node.child)
    if (node.kind === 'binary') return isQuietlyIncomplete(node.left) || isQuietlyIncomplete(node.right)
    return false
  }

  $effect(() => {
    if (searchQuery) {
      // Invalidate an in-flight result immediately on every edit, before the
      // debounce expires. Keep the previous list visible until the replacement
      // is ready, and never allow the previous request to flash into view.
      queryRequestId++
      searching = true
      updateResultsDebounced()
    } else {
      queryRequestId++
      if (cancelableQuery) {
        cancelableQuery.cancel()
        cancelableQuery = null
      }
      query = new Query('', {
        ignoreDiacritics: plugin.settings.ignoreDiacritics,
        ignoreArabicDiacritics: plugin.settings.ignoreArabicDiacritics,
        fieldAliases: plugin.settings.queryFieldAliases,
        literalPrefixes: plugin.settings.queryLiteralPrefixes,
      })
      searching = false
      resultNotes = []
      allResultNotes = []
    }
  })
  // Structured-query diagnostics should not interrupt every keystroke. The
  // parser still rejects invalid expressions immediately; only the notice is delayed.
  $effect(() => {
    const source = searchQuery
    diagnosticsVisible = false
    if (!source.trim()) return
    const timer = window.setTimeout(() => {
      if (source === searchQuery) diagnosticsVisible = true
    }, 1000)
    return () => window.clearTimeout(timer)
  })

  $effect(() => {
    switch ($indexingStep) {
      case IndexingStepType.LoadingCache:
        indexingStepDesc = 'Loading cache...'
        break
      case IndexingStepType.ReadingFiles:
        indexingStepDesc = 'Reading files...'
        break
      case IndexingStepType.IndexingFiles:
        indexingStepDesc = 'Indexing files...'
        break
      case IndexingStepType.WritingCache:
        updateResultsDebounced()
        indexingStepDesc = 'Updating cache...'
        break
      default:
        updateResultsDebounced()
        indexingStepDesc = ''
        break
    }
  })

  onMount(async () => {
    eventBus.enable('vault')
    eventBus.on('vault', Action.Enter, openNoteAndCloseModal)
    eventBus.on('vault', Action.OpenInBackground, openNoteInBackground)
    eventBus.on('vault', Action.CreateNote, createNoteAndCloseModal)
    eventBus.on('vault', Action.OpenInNewPane, openNoteInNewPane)
    eventBus.on('vault', Action.InsertLink, insertLink)
    eventBus.on('vault', Action.Tab, switchToInFileModal)
    eventBus.on('vault', Action.ArrowUp, () => moveIndex(-1))
    eventBus.on('vault', Action.ArrowDown, () => moveIndex(1))
    eventBus.on('vault', Action.PrevSearchHistory, prevSearchHistory)
    eventBus.on('vault', Action.NextSearchHistory, nextSearchHistory)
    eventBus.on('vault', Action.OpenInNewLeaf, openNoteInNewLeaf)
    await plugin.notesIndexer.refreshIndex()
    await updateResultsDebounced()
  })

  onDestroy(() => {
    eventBus.disable('vault')
    stopDragging()
  })

  async function prevSearchHistory() {
    // Filter out the empty string, if it's there
    const history = (await plugin.searchHistory.getHistory()).filter(s => s)
    if (++historySearchIndex >= history.length) {
      historySearchIndex = 0
    }
    searchQuery = history[historySearchIndex]
    refInput?.setInputValue(searchQuery ?? '')
  }

  async function nextSearchHistory() {
    const history = (await plugin.searchHistory.getHistory()).filter(s => s)
    if (--historySearchIndex < 0) {
      historySearchIndex = history.length ? history.length - 1 : 0
    }
    searchQuery = history[historySearchIndex]
    refInput?.setInputValue(searchQuery ?? '')
  }

  let cancelableQuery: CancelablePromise<ResultNote[]> | null = null
  function applyLiteralVisibility(notes: ResultNote[]): void {
    allResultNotes = notes
    resultNotes = hideLiteralOnly ? notes.filter(note => !isLiteralOnly(note)) : notes
  }

  function toggleLiteralOnly(): void {
    hideLiteralOnly = !hideLiteralOnly
    resultNotes = hideLiteralOnly
      ? allResultNotes.filter(note => !isLiteralOnly(note))
      : allResultNotes
    selectedIndex = 0
  }

  function handleInputKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
      const key = event.key.toLocaleLowerCase()
      if (key === 'l') {
        event.preventDefault()
        event.stopPropagation()
        toggleLiteralOnly()
      }
    }
  }

  async function updateResults() {
    const requestId = ++queryRequestId
    searching = true
    // Cancel the previous request and guard result assignment as well: cancellation
    // cannot guarantee that underlying indexing or metadata reads stop immediately.
    if (cancelableQuery) {
      cancelableQuery.cancel()
      cancelableQuery = null
    }
    query = new Query(searchQuery, {
      ignoreDiacritics: plugin.settings.ignoreDiacritics,
      ignoreArabicDiacritics: plugin.settings.ignoreArabicDiacritics,
      fieldAliases: plugin.settings.queryFieldAliases,
      literalPrefixes: plugin.settings.queryLiteralPrefixes,
    })
    const currentRequest = cancelable(
      new Promise<ResultNote[]>(resolve => {
        resolve(plugin.searchEngine.getSuggestions(query))
      })
    )
    cancelableQuery = currentRequest
    try {
      const notes = await currentRequest
      if (requestId !== queryRequestId) return
      applyLiteralVisibility(notes)
      selectedIndex = 0
      await scrollIntoView()
    } catch (error: unknown) {
      if (requestId === queryRequestId) {
        applyLiteralVisibility([])
        if (!(error instanceof Error && /cancel/i.test(error.message))) {
          console.error('Banana query failed', error)
        }
      }
    } finally {
      if (requestId === queryRequestId) {
        searching = false
        cancelableQuery = null
      }
    }
  }

  // Debounce this function to avoid multiple calls caused by Svelte reactivity
  const updateResultsDebounced = debounce(updateResults, 180)

  function onClick(evt?: MouseEvent | KeyboardEvent) {
    if (!selectedNote) return
    if (isModKeyPressed(evt)) {
      openNoteInNewPane()
    } else {
      openNoteAndCloseModal()
    }
  }

  function openNoteInNewPane(): void {
    if (!selectedNote) return
    openSearchResult(selectedNote, true)
    modal.close()
  }

  function openNoteAndCloseModal(): void {
    if (!selectedNote) return
    openSearchResult(selectedNote)
    modal.close()
  }

  function openNoteInBackground(): void {
    if (!selectedNote) return
    openSearchResult(selectedNote, true)
  }

  function openNoteInNewLeaf(): void {
    if (!selectedNote) return
    openSearchResult(selectedNote, true, true)
    modal.close()
  }

  function saveCurrentQuery() {
    if (searchQuery) {
      plugin.searchHistory.addToHistory(searchQuery)
    }
  }

  function openSearchResult(
    note: ResultNote,
    newPane = false,
    newLeaf = false
  ) {
    saveCurrentQuery()
    const offset = note.matches?.[0]?.offset ?? 0
    openNote(plugin, note, offset, newPane, newLeaf)
  }

  async function onClickCreateNote(_e: MouseEvent) {
    await createNoteAndCloseModal()
  }

  async function createNoteAndCloseModal(opt?: {
    newLeaf: boolean
  }): Promise<void> {
    if (searchQuery) {
      try {
        await createNote(plugin.app, searchQuery, opt?.newLeaf)
      } catch (e) {
        new Notice((e as Error).message)
        return
      }
      modal.close()
    }
  }

  function insertLink(): void {
    if (!selectedNote) return
    const file = plugin.app.vault
      .getMarkdownFiles()
      .find(f => f.path === selectedNote.path)
    const active = plugin.app.workspace.getActiveFile()
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view?.editor) {
      new Notice('Banana - Error - No active editor', 3000)
      return
    }

    // Generate link
    let link: string
    if (file && active) {
      link = plugin.app.fileManager.generateMarkdownLink(
        file,
        active.path,
        '',
        selectedNote.displayTitle
      )
    } else {
      const maybeDisplayTitle =
        selectedNote.displayTitle === '' ? '' : `|${selectedNote.displayTitle}`
      link = `[[${selectedNote.basename}.${getExtension(
        selectedNote.path
      )}${maybeDisplayTitle}]]`
    }

    // Inject link
    const cursor = view.editor.getCursor()
    view.editor.replaceRange(link, cursor, cursor)
    cursor.ch += link.length
    view.editor.setCursor(cursor)

    modal.close()
  }

  function switchToInFileModal(): void {
    // Do nothing if the selectedNote is a PDF,
    // or if there is 0 match (e.g indexing in progress)
    if (
      selectedNote &&
      (isFilePDF(selectedNote?.path) || !selectedNote?.matches.length)
    ) {
      return
    }

    saveCurrentQuery()
    // Preserve the exact window geometry across the Vault ↔ In-File mode change.
    modal.persistGeometry()
    modal.close()

    if (selectedNote) {
      // Open in-file modal for selected search result
      const file = plugin.app.vault.getAbstractFileByPath(selectedNote.path)
      if (file && file instanceof TFile) {
        new BananaInFileModal(plugin, file, searchQuery).open()
      }
    } else {
      // Open in-file modal for active file
      const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
      if (view?.file) {
        new BananaInFileModal(plugin, view.file, searchQuery).open()
      }
    }
  }

  function moveIndex(dir: 1 | -1): void {
    selectedIndex = loopIndex(selectedIndex + dir, resultNotes.length)
    scrollIntoView()
  }

  async function scrollIntoView(): Promise<void> {
    await tick()
    if (selectedNote) {
      const elem = activeWindow.document.querySelector(
        `[data-result-id="${selectedNote.path}"]`
      )
      elem?.scrollIntoView({ behavior: 'auto', block: 'nearest' })
    }
  }

  let dragOffset: { x: number; y: number; pointerId: number } | null = null

  function clampModalPosition(left: number, top: number): { left: number; top: number } {
    const rect = modal.modalEl.getBoundingClientRect()
    const width = rect.width || Math.min(720, window.innerWidth - 32)
    const height = rect.height || Math.min(600, window.innerHeight - 32)
    return {
      left: Math.max(8, Math.min(left, Math.max(8, window.innerWidth - width - 8))),
      top: Math.max(8, Math.min(top, Math.max(8, window.innerHeight - height - 8))),
    }
  }

  function applyModalPosition(left: number, top: number): void {
    const position = clampModalPosition(left, top)
    modal.modalEl.style.position = 'fixed'
    modal.modalEl.style.transform = 'none'
    modal.modalEl.style.margin = '0'
    modal.modalEl.style.left = `${position.left}px`
    modal.modalEl.style.top = `${position.top}px`
  }

  function startDragging(event: PointerEvent): void {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button, input, a, [role="button"]')) return
    const rect = modal.modalEl.getBoundingClientRect()
    dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top, pointerId: event.pointerId }
    document.addEventListener('pointermove', moveDraggedModal)
    document.addEventListener('pointerup', stopDragging)
    document.addEventListener('pointercancel', stopDragging)
  }

  function moveDraggedModal(event: PointerEvent): void {
    if (!dragOffset || event.pointerId !== dragOffset.pointerId) return
    event.preventDefault()
    applyModalPosition(event.clientX - dragOffset.x, event.clientY - dragOffset.y)
  }

  function stopDragging(event?: PointerEvent): void {
    if (event && dragOffset && event.pointerId !== dragOffset.pointerId) return
    document.removeEventListener('pointermove', moveDraggedModal)
    document.removeEventListener('pointerup', stopDragging)
    document.removeEventListener('pointercancel', stopDragging)
    if (!dragOffset) return
    dragOffset = null
    modal.persistGeometry()
  }

  onMount(() => {
    const saved = plugin.settings.queryModalPosition
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      applyModalPosition(saved.left, saved.top)
    }
    // Recalculate chrome-aware minimum height after Svelte has mounted the
    // complete shortcut footer. This prevents a stale compact size from clipping it.
    modal.clampGeometryToViewport()
    const onResize = () => {
      modal.clampGeometryToViewport()
      if (plugin.settings.queryModalPosition) {
        const rect = modal.modalEl.getBoundingClientRect()
        const position = clampModalPosition(rect.left, rect.top)
        applyModalPosition(position.left, position.top)
        plugin.settings.queryModalPosition = position
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })
</script>

<div class="banana-query-header">
  <div class="banana-query-header__input">
    <InputSearch
      bind:this={refInput}
      {plugin}
      initialValue={searchQuery}
      resultCount={uniqueResultCount > 0 ? uniqueResultCount : null}
      on:input={e => (searchQuery = e.detail)}
      on:keydown={e => handleInputKeydown(e.detail)}
      placeholder="Banana - Vault">
      <div class="banana-input-container__buttons">
        {#if plugin.settings.showCreateButton}
          <button onclick={onClickCreateNote}>Create note</button>
        {/if}
        {#if Platform.isMobile}
          <button onclick={switchToInFileModal}>In-File search</button>
        {/if}
      </div>
    </InputSearch>
  </div>
</div>

{#if diagnosticsVisible && query.language.isAdvanced && queryDiagnosticState}
  <div class="banana-query-diagnostics banana-query-diagnostics--invalid" role="status" aria-live="polite">
    <div class="banana-query-diagnostics__title">{queryDiagnosticState === 'incomplete' ? 'Incomplete query' : 'Invalid query'}</div>
    {#each queryErrors.slice(0, 1) as diagnostic}
      <div>{diagnostic.message} <span>(character {diagnostic.start + 1})</span></div>
    {/each}
  </div>
{/if}
{#if diagnosticsVisible && queryHint}
  <div class="banana-query-hint" title={queryHint} role="status" aria-live="polite">{queryHint}</div>
{/if}
{#if indexingStepDesc}
  <div style="text-align: center; color: var(--text-accent); margin-top: 10px">
    ⏳ Work in progress: {indexingStepDesc}
  </div>
{/if}

<ModalContainer>
  {#each resultNotes as result, i}
    <LazyLoader
      height={100}
      offset={500}
      keep={true}
      fadeOption={{ delay: 0, duration: 0 }}>
      <ResultItemVault
        {plugin}
        selected={i === selectedIndex}
        note={result}
        on:mousemove={_ => (selectedIndex = i)}
        on:click={onClick}
        on:longpress={() => {
          selectedIndex = i
          openNoteInNewPane()
        }}
        on:auxclick={evt => {
          if (evt.button == 1) openNoteInNewPane()
        }} />
    </LazyLoader>
  {/each}
  <div style="text-align: center;">
    {#if !resultNotes.length && searchQuery && !searching && !hasQueryErrors && !quietlyIncomplete}
      We found 0 results for your search here.
      {#if plugin.settings.simpleSearch && searchQuery
          .split(SPACE_OR_PUNCTUATION)
          .some(w => w.length < 3)}
        <br />
        <span style="color: var(--text-accent); font-size: small">
          You have enabled "Simpler Search" in the settings, try to type more
          characters.
        </span>
      {/if}
    {/if}
  </div>
</ModalContainer>

<div class="prompt-instructions banana-query-footer" onpointerdown={startDragging} role="presentation">
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">↑↓</span><span>to navigate</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getAltKeyLabel()} ↑↓</span>
    <span>to cycle history</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getCtrlKeyLabel()} Shift L</span>
    <span>{hideLiteralOnly ? 'to show literal-only matches' : 'to hide literal-only matches'}{#if hideLiteralOnly && literalOnlyCount > 0} · {literalOnlyCount} literal-only {literalOnlyCount === 1 ? 'match' : 'matches'} hidden{/if}</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getCtrlKeyLabel()} Shift C</span>
    <span>to reset window</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{openInCurrentPaneKey}</span>
    <span>to open</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">Shift+Tab</span>
    <span>to switch to In-File Search</span>
  </div>

  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{openInNewPaneKey}</span>
    <span>to open in a new pane</span>
  </div>

  {#if Platform.isMobile}
    <div class="prompt-instruction">
      <span class="prompt-instruction-command">hold</span>
      <span>to open in a new pane</span>
    </div>
  {/if}

  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{openInNewLeafKey}</span>
    <span>to open in a new split</span>
  </div>

  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getCtrlKeyLabel()} o</span>
    <span>to open in the background</span>
  </div>

  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{createInCurrentPaneKey}</span>
    <span>to create</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{createInNewPaneKey}</span>
    <span>to create in a new pane</span>
  </div>

  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getAltKeyLabel()} ↵</span>
    <span>to insert a link</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getCtrlKeyLabel()} g</span>
    <span>to toggle excerpts</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">Esc</span><span>to close</span>
  </div>
</div>
