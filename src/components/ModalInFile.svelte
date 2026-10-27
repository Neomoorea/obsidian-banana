<script lang="ts">
  import InputSearch from './InputSearch.svelte'
  import {
    Action,
    eventBus,
    excerptAfter,
    type ResultNote,
    type SearchMatch,
  } from '../globals'
  import { getCtrlKeyLabel, isModKeyPressed, loopIndex } from '../tools/utils'
  import { onDestroy, onMount, tick } from 'svelte'
  import { Platform } from 'obsidian'
  import ModalContainer from './ModalContainer.svelte'
  import {
    BananaInFileModal,
    BananaVaultModal,
  } from '../components/modals'
  import ResultItemInFile from './ResultItemInFile.svelte'
  import { Query } from '../search/query'
  import { openNote } from '../tools/notes'
  import type BananaPlugin from '../main'

  export let plugin: BananaPlugin
  export let modal: BananaInFileModal
  export let parent: BananaVaultModal | null = null
  export let singleFilePath = ''
  export let previousQuery: string | undefined

  let searchQuery: string
  let groupedOffsets: number[] = []
  let selectedIndex = 0
  let note: ResultNote | undefined
  let query: Query

  $: searchQuery = previousQuery ?? ''

  onMount(() => {
    // Apply persisted geometry after the modal is attached, when its actual
    // dimensions are measurable. This avoids a position jump on mode switches.
    modal.clampGeometryToViewport()
    eventBus.enable('infile')

    eventBus.on('infile', Action.Enter, openSelection)
    eventBus.on('infile', Action.OpenInNewPane, openSelectionInNewTab)
    eventBus.on('infile', Action.ArrowUp, () => moveIndex(-1))
    eventBus.on('infile', Action.ArrowDown, () => moveIndex(1))
    eventBus.on('infile', Action.Tab, switchToVaultModal)
  })

  onDestroy(() => {
    eventBus.disable('infile')
  })

  $: (async () => {
    if (searchQuery) {
      query = new Query(searchQuery, {
        ignoreDiacritics: plugin.settings.ignoreDiacritics,
        ignoreArabicDiacritics: plugin.settings.ignoreArabicDiacritics,
        fieldAliases: plugin.settings.queryFieldAliases,
        literalPrefixes: plugin.settings.queryLiteralPrefixes,
      })
      note =
        (
          await plugin.searchEngine.getSuggestions(query, {
            singleFilePath,
          })
        )[0] ?? null
    }
    selectedIndex = 0
    await scrollIntoView()
  })()

  $: {
    if (note) {
      let groups = getGroups(note.matches)

      // If there are quotes in the search,
      // only show results that match at least one of the quotes
      const exactTerms = query.getExactTerms()
      if (exactTerms.length) {
        groups = groups.filter(group =>
          exactTerms.every(exact =>
            group.some(match => match.match.includes(exact))
          )
        )
      }

      groupedOffsets = groups.map(group => Math.round(group.first()!.offset))
    }
  }

  /**
   * Group together close matches to reduce the number of results
   */
  function getGroups(matches: SearchMatch[]): SearchMatch[][] {
    const groups: SearchMatch[][] = []
    let lastOffset = -1
    let count = 0 // Avoid infinite loops
    while (++count < 100) {
      const group = getGroupedMatches(matches, lastOffset, excerptAfter)
      if (!group.length) break
      lastOffset = group.last()!.offset
      groups.push(group)
    }
    return groups
  }

  function getGroupedMatches(
    matches: SearchMatch[],
    offsetFrom: number,
    maxLen: number
  ): SearchMatch[] {
    const first = matches.find(m => m.offset > offsetFrom)
    if (!first) return []
    return matches.filter(
      m => m.offset > offsetFrom && m.offset <= first.offset + maxLen
    )
  }

  function moveIndex(dir: 1 | -1): void {
    selectedIndex = loopIndex(selectedIndex + dir, groupedOffsets.length)
    scrollIntoView()
  }

  async function scrollIntoView(): Promise<void> {
    await tick()
    const elem = document.querySelector(`[data-result-id="${selectedIndex}"]`)
    elem?.scrollIntoView({ behavior: 'auto', block: 'nearest' })
  }

  async function openSelectionInNewTab(): Promise<void> {
    return openSelection(true)
  }

  async function openSelectionFromClick(evt: MouseEvent): Promise<void> {
    return openSelection(isModKeyPressed(evt))
  }

  async function openSelection(newTab = false): Promise<void> {
    if (note) {
      modal.close()
      if (parent) parent.close()

      // Open (or switch focus to) the note
      const offset = groupedOffsets[selectedIndex] ?? 0
      await openNote(plugin, note, offset, newTab)
    }
  }

  function switchToVaultModal(): void {
    // Carry the live size and position into Vault Search before closing this modal.
    modal.persistGeometry()
    new BananaVaultModal(plugin, searchQuery ?? previousQuery).open()
    modal.close()
  }
</script>

<InputSearch
  {plugin}
  on:input={e => (searchQuery = e.detail)}
  placeholder="Banana - File"
  initialValue={previousQuery}>
  <div class="banana-input-container__buttons">
    {#if Platform.isMobile}
      <button on:click={switchToVaultModal}>Vault search</button>
    {/if}
  </div>
</InputSearch>

<ModalContainer>
  {#if groupedOffsets.length && note}
    {#each groupedOffsets as offset, i}
      <ResultItemInFile
        {plugin}
        {offset}
        {note}
        index={i}
        selected={i === selectedIndex}
        on:mousemove={_e => (selectedIndex = i)}
        on:click={openSelectionFromClick}
        on:longpress={() => {
          selectedIndex = i
          openSelection(true)
        }}
        on:auxclick={evt => {
          if (evt.button == 1) openSelection(true)
        }} />
    {/each}
  {:else}
    <div style="text-align: center;">
      We found 0 results for your search here.
    </div>
  {/if}
</ModalContainer>

<div class="prompt-instructions">
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">↑↓</span><span>to navigate</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">↵</span><span>to open</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">Shift+Tab</span>
    <span>to switch to Vault Search</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getCtrlKeyLabel()} Shift C</span>
    <span>to reset window</span>
  </div>
  <div class="prompt-instruction">
    <span class="prompt-instruction-command">esc</span>
    {#if !!parent}
      <span>to go back to Vault Search</span>
    {:else}
      <span>to close</span>
    {/if}
  </div>

  <div class="prompt-instruction">
    <span class="prompt-instruction-command">{getCtrlKeyLabel()} ↵</span>
    <span>to open in a new pane</span>
  </div>

  {#if Platform.isMobile}
    <div class="prompt-instruction">
      <span class="prompt-instruction-command">hold</span>
      <span>to open in a new pane</span>
    </div>
  {/if}
</div>
