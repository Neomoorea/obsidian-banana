import { MarkdownView, Modal, TFile } from 'obsidian'
import type { Modifier } from 'obsidian'
import ModalVault from './ModalVault.svelte'
import ModalInFile from './ModalInFile.svelte'
import { Action, eventBus, EventNames, isInputComposition } from '../globals'
import type BananaPlugin from '../main'
import { mount, unmount } from 'svelte'
import { MIN_MODAL_HEIGHT, MIN_MODAL_WIDTH, migrateModalGeometry } from './modal-geometry'

// The default prompt is roughly 700px wide. A 270×180px lower bound is about
// 50% larger than the original minimum, while still allowing a compact layout.
// Bounds are further limited by the viewport.

abstract class BananaModal extends Modal {
  private resizeCursorTarget: HTMLElement | null = null
  private resizeCursorOriginal = ''
  private resizeCursorOriginalPriority = ''
  private resizeState: {
    pointerId: number
    edge: { left: boolean; right: boolean; top: boolean; bottom: boolean }
    startX: number
    startY: number
    startLeft: number
    startTop: number
    startWidth: number
    startHeight: number
    didResizeWidth: boolean
    didResizeHeight: boolean
  } | null = null

  protected constructor(protected plugin: BananaPlugin) {
    super(plugin.app)
    const settings = plugin.settings

    // Remove all the default modal's children
    // so that we can more easily customize it
    // const closeEl = this.containerEl.find('.modal-close-button')
    this.modalEl.replaceChildren()
    // this.modalEl.append(closeEl)
    this.modalEl.addClass('banana-modal', 'prompt')
    this.modalEl.removeClass('modal')
    this.modalEl.tabIndex = -1
    // Older geometry could persist the resize minimum as the modal's preferred
    // dimensions. Migrate it back to content-driven height and a usable default.
    const geometryMigration = migrateModalGeometry(
      settings.queryModalSize,
      settings.queryModalGeometryVersion ?? 0,
    )
    if (geometryMigration.changed) {
      settings.queryModalSize = geometryMigration.size
      settings.queryModalGeometryVersion = geometryMigration.version
      void plugin.saveData(settings)
    }
    this.applySavedGeometry()
    this.modalEl.addEventListener('pointerdown', this.startResize, true)
    this.modalEl.addEventListener('pointermove', this.updateResizeCursor, true)
    document.addEventListener('pointermove', this.moveResize)
    document.addEventListener('pointerup', this.stopResize)
    document.addEventListener('pointercancel', this.stopResize)
    window.addEventListener('resize', this.clampGeometryToViewport)

    // Setup events that can be listened through the event bus

    // #region Up/Down navigation

    this.scope.register([], 'ArrowDown', e => {
      e.preventDefault()
      eventBus.emit(Action.ArrowDown)
    })
    this.scope.register([], 'ArrowUp', e => {
      e.preventDefault()
      eventBus.emit(Action.ArrowUp)
    })

    // Ctrl+j/k
    for (const key of [
      { k: 'J', dir: 'down' },
      { k: 'K', dir: 'up' },
    ] as const) {
      for (const modifier of ['Ctrl', 'Mod'] as const) {
        this.scope.register([modifier], key.k, _e => {
          if (settings.vimLikeNavigationShortcut) {
            // e.preventDefault()
            eventBus.emit('arrow-' + key.dir)
          }
        })
      }
    }

    // Ctrl+n/p
    for (const key of [
      { k: 'N', dir: 'down' },
      { k: 'P', dir: 'up' },
    ] as const) {
      for (const modifier of ['Ctrl', 'Mod'] as const) {
        this.scope.register([modifier], key.k, _e => {
          if (settings.vimLikeNavigationShortcut) {
            // e.preventDefault()
            eventBus.emit('arrow-' + key.dir)
          }
        })
      }
    }

    // #endregion Up/Down navigation

    const openInCurrentPaneKey: Modifier[] = []
    const openInNewPaneKey: Modifier[] = ['Mod']
    const createInCurrentPaneKey: Modifier[] = ['Shift']
    const createInNewPaneKey: Modifier[] = ['Mod', 'Shift']
    const openInNewLeafKey: Modifier[] = ['Mod', 'Alt']

    // Open in new pane
    this.scope.register(openInNewPaneKey, 'Enter', e => {
      e.preventDefault()
      eventBus.emit(Action.OpenInNewPane)
    })

    // Open in a new leaf
    this.scope.register(openInNewLeafKey, 'Enter', e => {
      e.preventDefault()
      eventBus.emit(Action.OpenInNewLeaf)
    })

    // Insert link
    this.scope.register(['Alt'], 'Enter', e => {
      e.preventDefault()
      eventBus.emit(Action.InsertLink)
    })

    // Create a new note
    this.scope.register(createInCurrentPaneKey, 'Enter', e => {
      e.preventDefault()
      eventBus.emit(Action.CreateNote)
    })
    this.scope.register(createInNewPaneKey, 'Enter', e => {
      e.preventDefault()
      eventBus.emit(Action.CreateNote, { newLeaf: true })
    })

    // Open in current pane
    this.scope.register(openInCurrentPaneKey, 'Enter', e => {
      if (!isInputComposition()) {
        // Check if the user is still typing
        e.preventDefault()
        eventBus.emit(Action.Enter)
      }
    })

    // Open in background
    this.scope.register(['Mod'], 'O', e => {
      if (!isInputComposition()) {
        // Check if the user is still typing
        e.preventDefault()
        eventBus.emit(Action.OpenInBackground)
      }
    })

    // Tab is reserved for accepting a ghost-text autocomplete suggestion.
    // Shift+Tab switches between Vault Search and In-File Search.
    this.scope.register(['Shift'], 'Tab', e => {
      e.preventDefault()
      eventBus.emit(Action.Tab)
    })
    this.scope.register(['Mod', 'Shift'], 'C', e => {
      e.preventDefault()
      this.resetGeometry()
    })

    // Search history
    this.scope.register(['Alt'], 'ArrowDown', e => {
      e.preventDefault()
      eventBus.emit(Action.NextSearchHistory)
    })
    this.scope.register(['Alt'], 'ArrowUp', e => {
      e.preventDefault()
      eventBus.emit(Action.PrevSearchHistory)
    })

    // Context
    this.scope.register(['Mod'], 'G', _e => {
      eventBus.emit(EventNames.ToggleExcerpts)
    })
  }

  /** Persist window position and any user-customized dimensions. */
  public persistGeometry(sizeChange?: { width: boolean; height: boolean; heightCap?: number | null }): void {
    const rect = this.modalEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    this.plugin.settings.queryModalPosition = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8)),
    }

    const existingSize = this.plugin.settings.queryModalSize
    if (sizeChange?.width || sizeChange?.height) {
      this.plugin.settings.queryModalSize = {
        width: sizeChange.width ? rect.width : existingSize?.width ?? rect.width,
        // Height is a maximum, not a fixed height. Null means the pane should
        // remain content-driven up to the viewport limit.
        height: sizeChange.height
          ? (sizeChange.heightCap ?? rect.height)
          : existingSize?.height ?? null,
      }
    } else if (existingSize) {
      this.plugin.settings.queryModalSize = { width: existingSize.width, height: existingSize.height }
    }
    void this.plugin.saveData(this.plugin.settings)
  }

  /** Clamp persistent width/height limits after a viewport resize. */
  public clampGeometryToViewport = (): void => {
    const maxWidth = Math.max(1, window.innerWidth - 16)
    const maxHeight = Math.max(1, window.innerHeight - 16)
    const size = this.plugin.settings.queryModalSize

    if (size && Number.isFinite(size.width)) {
      const minWidth = Math.min(MIN_MODAL_WIDTH, maxWidth)
      const width = Math.max(minWidth, Math.min(size.width, maxWidth))
      this.modalEl.setCssProps({
        'min-width': `${minWidth}px`,
        'max-width': `${maxWidth}px`,
        width: `${width}px`,
        'box-sizing': 'border-box',
      })
      let height = size.height
      if (height != null) {
        const minHeight = this.getMinimumModalHeight(maxHeight)
        height = Math.max(minHeight, Math.min(height, maxHeight))
        this.modalEl.setCssProps({
          'min-height': `${minHeight}px`,
          'max-height': `${height}px`,
          height: 'auto',
        })
      } else {
        this.modalEl.style.removeProperty('min-height')
        this.modalEl.style.removeProperty('max-height')
        this.modalEl.style.removeProperty('height')
      }
      this.plugin.settings.queryModalSize = { width, height }
    } else {
      // Never override the native Omnisearch/Obsidian default dimensions when
      // the user has not chosen a custom width or vertical cap.
      this.clearSizeStyles()
    }

    const rect = this.modalEl.getBoundingClientRect()
    if (this.plugin.settings.queryModalPosition) {
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8))
      this.modalEl.setCssProps({ position: 'fixed', transform: 'none', margin: '0', left: `${left}px`, top: `${top}px` })
      this.plugin.settings.queryModalPosition = { left, top }
    }
    void this.plugin.saveData(this.plugin.settings)
  }

  /** Remove modal-level listeners when the Svelte view is destroyed. */
  public disposeResizeListeners(): void {
    this.modalEl.removeEventListener('pointerdown', this.startResize, true)
    this.modalEl.removeEventListener('pointermove', this.updateResizeCursor, true)
    document.removeEventListener('pointermove', this.moveResize)
    document.removeEventListener('pointerup', this.stopResize)
    document.removeEventListener('pointercancel', this.stopResize)
    window.removeEventListener('resize', this.clampGeometryToViewport)
    this.resizeState = null
    this.clearResizeCursorTarget()
    this.modalEl.style.removeProperty('cursor')
  }

  /** Restore the default centered size and position. */
  public resetGeometry(): void {
    this.plugin.settings.queryModalPosition = null
    this.plugin.settings.queryModalSize = null
    void this.plugin.saveData(this.plugin.settings)
    this.clearResizeCursorTarget()
    for (const property of ['position', 'transform', 'margin', 'left', 'top', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing', 'cursor']) {
      this.modalEl.style.removeProperty(property)
    }
    // Re-apply viewport and minimum constraints without restoring a custom size;
    // the default width and content-driven height now come from Obsidian's prompt.
    this.applySavedGeometry()
  }

  /**
   * Keep the search input and complete shortcut footer visible at every size.
   * The result list is the only child allowed to shrink; when the viewport is
   * itself smaller than the required chrome, the viewport becomes the limit.
   */
  private getMinimumModalHeight(maxHeight: number): number {
    const results = this.modalEl.querySelector<HTMLElement>('.prompt-results')
    const children = Array.from(this.modalEl.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== results,
    )
    const chromeHeight = children.reduce((total, child) => {
      const rectHeight = child.getBoundingClientRect().height
      const scrollHeight = child.scrollHeight
      const style = window.getComputedStyle(child)
      const margins = (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0)
      return total + Math.max(rectHeight, scrollHeight) + margins
    }, 0)
    const modalStyle = window.getComputedStyle(this.modalEl)
    const insets = [modalStyle.paddingTop, modalStyle.paddingBottom, modalStyle.borderTopWidth, modalStyle.borderBottomWidth]
      .reduce((total, value) => total + (Number.parseFloat(value) || 0), 0)
    return Math.min(maxHeight, Math.max(MIN_MODAL_HEIGHT, Math.ceil(chromeHeight + insets)))
  }

  private clearSizeStyles(): void {
    for (const property of ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing']) {
      this.modalEl.style.removeProperty(property)
    }
  }

  private applySavedGeometry(): void {
    const maxWidth = Math.max(1, window.innerWidth - 16)
    const maxHeight = Math.max(1, window.innerHeight - 16)
    const size = this.plugin.settings.queryModalSize

    // With no user-selected width, leave sizing entirely to Obsidian's native
    // `.prompt` rules. That's how Omnisearch gets its normal default dimensions.
    this.clearSizeStyles()
    if (size && Number.isFinite(size.width)) {
      const minWidth = Math.min(MIN_MODAL_WIDTH, maxWidth)
      this.modalEl.setCssProps({
        'min-width': `${minWidth}px`,
        'max-width': `${maxWidth}px`,
        width: `${Math.min(maxWidth, Math.max(minWidth, size.width))}px`,
        'box-sizing': 'border-box',
      })
      if (size.height != null) {
        const minHeight = this.getMinimumModalHeight(maxHeight)
        this.modalEl.setCssProps({
          'min-height': `${minHeight}px`,
          'max-height': `${Math.max(minHeight, Math.min(size.height, maxHeight))}px`,
          height: 'auto',
        })
      }
    }

    const position = this.plugin.settings.queryModalPosition
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
      const width = size?.width
        ? Math.min(maxWidth, Math.max(Math.min(MIN_MODAL_WIDTH, maxWidth), size.width))
        : Math.min(this.modalEl.getBoundingClientRect().width || 720, maxWidth)
      // The component has not mounted yet, so use the viewport only as a
      // temporary estimate. ModalVault clamps the final position after mount.
      const height = size?.height != null
        ? Math.min(maxHeight, Math.max(this.getMinimumModalHeight(maxHeight), size.height))
        : Math.min(this.modalEl.getBoundingClientRect().height || 600, maxHeight)
      this.modalEl.setCssProps({
        position: 'fixed',
        transform: 'none',
        margin: '0',
        left: `${Math.max(8, Math.min(position.left, window.innerWidth - width - 8))}px`,
        top: `${Math.max(8, Math.min(position.top, window.innerHeight - height - 8))}px`,
      })
    }
  }

  private getNativePromptMaxHeight(viewportMaxHeight: number): number {
    const raw = window.getComputedStyle(this.modalEl).maxHeight
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value)) return viewportMaxHeight
    let pixels = value
    if (raw.endsWith('vh')) pixels = value * window.innerHeight / 100
    else if (!raw.endsWith('px') && !/^\d+(?:\.\d+)?$/u.test(raw)) return viewportMaxHeight
    return Math.max(Math.min(MIN_MODAL_HEIGHT, viewportMaxHeight), Math.min(pixels, viewportMaxHeight))
  }

  private getResizeEdge(event: PointerEvent): { left: boolean; right: boolean; top: boolean; bottom: boolean } | null {
    const rect = this.modalEl.getBoundingClientRect()
    const distance = 7
    const left = event.clientX >= rect.left && event.clientX <= rect.left + distance
    const right = event.clientX <= rect.right && event.clientX >= rect.right - distance
    const top = event.clientY >= rect.top && event.clientY <= rect.top + distance
    const bottom = event.clientY <= rect.bottom && event.clientY >= rect.bottom - distance
    if (!(left || right || top || bottom)) return null
    return { left, right: !left && right, top, bottom: !top && bottom }
  }

  private cursorForEdge(edge: { left: boolean; right: boolean; top: boolean; bottom: boolean }): string {
    if ((edge.left && edge.top) || (edge.right && edge.bottom)) return 'nwse-resize'
    if ((edge.right && edge.top) || (edge.left && edge.bottom)) return 'nesw-resize'
    if (edge.left || edge.right) return 'ew-resize'
    return 'ns-resize'
  }

  private clearResizeCursorTarget(): void {
    if (!this.resizeCursorTarget) return
    if (this.resizeCursorOriginal) {
      this.resizeCursorTarget.style.setProperty('cursor', this.resizeCursorOriginal, this.resizeCursorOriginalPriority)
    } else {
      this.resizeCursorTarget.style.removeProperty('cursor')
    }
    this.resizeCursorTarget = null
    this.resizeCursorOriginal = ''
    this.resizeCursorOriginalPriority = ''
  }

  private setResizeCursorTarget(target: EventTarget | null, cursor: string | null): void {
    const element = target instanceof HTMLElement && target !== this.modalEl && this.modalEl.contains(target)
      ? target
      : null
    if (this.resizeCursorTarget !== element) {
      this.clearResizeCursorTarget()
      if (element) {
        this.resizeCursorTarget = element
        this.resizeCursorOriginal = element.style.getPropertyValue('cursor')
        this.resizeCursorOriginalPriority = element.style.getPropertyPriority('cursor')
      }
    }
    if (this.resizeCursorTarget && cursor) {
      // Explicit inline priority wins over inner controls' own cursors while the
      // pointer is within the narrow, invisible resize hit area.
      this.resizeCursorTarget.style.setProperty('cursor', cursor, 'important')
    }
  }

  private updateResizeCursor = (event: PointerEvent): void => {
    if (this.resizeState) return
    const edge = this.getResizeEdge(event)
    const cursor = edge ? this.cursorForEdge(edge) : null
    if (!cursor) {
      // Restore any child input/footer cursor override as soon as the pointer
      // leaves the 7px border hit zone, even if it is still over the same child.
      this.clearResizeCursorTarget()
      this.modalEl.style.removeProperty('cursor')
      return
    }
    this.setResizeCursorTarget(event.target, cursor)
    this.modalEl.setCssProps({ cursor })
  }

  private startResize = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const edge = this.getResizeEdge(event)
    if (!edge) return
    event.preventDefault()
    event.stopPropagation()
    const rect = this.modalEl.getBoundingClientRect()
    this.resizeState = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startHeight: rect.height,
      didResizeWidth: false,
      didResizeHeight: false,
    }
    const cursor = this.cursorForEdge(edge)
    this.setResizeCursorTarget(event.target, cursor)
    this.modalEl.setCssProps({ cursor })
  }

  private moveResize = (event: PointerEvent): void => {
    const state = this.resizeState
    if (!state || event.pointerId !== state.pointerId) return
    event.preventDefault()
    const cursor = this.cursorForEdge(state.edge)
    this.setResizeCursorTarget(event.target, cursor)
    this.modalEl.setCssProps({ cursor })

    const maxWidth = Math.max(1, window.innerWidth - 16)
    const maxHeight = Math.max(1, window.innerHeight - 16)
    const minWidth = Math.min(maxWidth, MIN_MODAL_WIDTH)
    const minHeight = this.getMinimumModalHeight(maxHeight)
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    const horizontalEdge = state.edge.left || state.edge.right
    const verticalEdge = state.edge.top || state.edge.bottom
    const requestedWidth = Math.max(minWidth, Math.min(maxWidth,
      state.startWidth + (state.edge.right ? dx : state.edge.left ? -dx : 0)))
    const requestedHeight = Math.max(minHeight, Math.min(maxHeight,
      state.startHeight + (state.edge.bottom ? dy : state.edge.top ? -dy : 0)))

    let left = state.edge.left ? state.startLeft + state.startWidth - requestedWidth : state.startLeft
    left = Math.max(8, Math.min(left, window.innerWidth - requestedWidth - 8))
    this.modalEl.setCssProps({
      position: 'fixed', transform: 'none', margin: '0', 'box-sizing': 'border-box',
      'max-width': `${maxWidth}px`, width: `${requestedWidth}px`, height: 'auto', left: `${left}px`,
    })

    const viewportCap = maxHeight
    const previousCap = this.plugin.settings.queryModalSize?.height ?? null
    const defaultCap = this.getNativePromptMaxHeight(maxHeight)
    let layoutCap = previousCap ?? defaultCap
    let shouldPersistHeightCap = previousCap !== null
    let top = state.startTop
    let effectiveHeight = this.modalEl.getBoundingClientRect().height

    const verticalMoved = verticalEdge && Math.abs(dy) > 1
    if (verticalMoved) {
      // Temporarily remove Obsidian's default prompt cap while actively resizing
      // vertically. We can expand to show the current result list, then persist
      // only a cap that actually changed the visible height.
      this.modalEl.setCssProps({ 'max-height': `${viewportCap}px` })
      const beforeCapRect = this.modalEl.getBoundingClientRect()
      const results = this.modalEl.querySelector<HTMLElement>('.prompt-results')
      const overflow = results ? Math.max(0, results.scrollHeight - results.clientHeight) : 0
      const contentFitHeight = Math.min(maxHeight, beforeCapRect.height + overflow)
      effectiveHeight = Math.max(minHeight, Math.min(requestedHeight, contentFitHeight))

      if (requestedHeight < contentFitHeight - 1) {
        layoutCap = requestedHeight
        shouldPersistHeightCap = true
      } else if (contentFitHeight > state.startHeight + 1) {
        // The user expanded a scrolling list until all current results fit. Cap
        // future queries at that visible height, not at the unused drag distance.
        layoutCap = contentFitHeight
        shouldPersistHeightCap = true
      } else {
        // A short result list already fits. Don't turn an attempted empty-space
        // drag into a viewport-sized cap or make the default pane taller.
        layoutCap = previousCap ?? defaultCap
        shouldPersistHeightCap = previousCap !== null
      }
      top = state.edge.top ? state.startTop + state.startHeight - effectiveHeight : state.startTop
    } else {
      // Horizontal resizing must not replace the native default max-height with
      // the full viewport. The selected width is independent of vertical size.
      effectiveHeight = this.modalEl.getBoundingClientRect().height
    }

    if (shouldPersistHeightCap) {
      this.modalEl.setCssProps({
        'min-height': `${minHeight}px`,
        'max-height': `${Math.max(minHeight, Math.min(layoutCap, maxHeight))}px`,
      })
    } else {
      this.modalEl.style.removeProperty('min-height')
      this.modalEl.style.removeProperty('max-height')
    }
    this.modalEl.setCssProps({
      top: `${Math.max(8, Math.min(top, window.innerHeight - effectiveHeight - 8))}px`,
    })
    const currentRect = this.modalEl.getBoundingClientRect()
    state.didResizeWidth = horizontalEdge && Math.abs(currentRect.width - state.startWidth) > 1
    state.didResizeHeight = !!verticalMoved && Math.abs(currentRect.height - state.startHeight) > 1
  }

  private stopResize = (event?: PointerEvent): void => {
    const state = this.resizeState
    if (!state || (event && event.pointerId !== state.pointerId)) return
    this.resizeState = null
    const styleCap = Number.parseFloat(this.modalEl.style.getPropertyValue('max-height'))
    this.persistGeometry({
      width: state.didResizeWidth,
      height: state.didResizeHeight,
      heightCap: state.didResizeHeight && Number.isFinite(styleCap) ? styleCap : undefined,
    })
    this.clearResizeCursorTarget()
    this.modalEl.style.removeProperty('cursor')
  }

}

export class BananaVaultModal extends BananaModal {
  /**
   * Instanciate the Banana vault modal
   * @param plugin
   * @param query The query to pre-fill the search field with
   */
  constructor(plugin: BananaPlugin, query?: string) {
    super(plugin)

    // Selected text in the editor
    const selectedText = plugin.app.workspace
      .getActiveViewOfType(MarkdownView)
      ?.editor.getSelection()

    plugin.searchHistory.getHistory().then(history => {
      // Previously searched query (if enabled in settings)
      const previous = plugin.settings.showPreviousQueryResults
        ? history[0]
        : null

      // Instantiate and display the Svelte component
      const cmp = mount(ModalVault, {
        target: this.modalEl,
        props: {
          plugin,
          modal: this,
          previousQuery: query || selectedText || previous || '',
        },
      })

      this.onClose = () => {
        this.disposeResizeListeners()
        // Since the component is manually created,
        // we also need to manually destroy it
        void unmount(cmp)
      }
    }).catch(e => {
      this.disposeResizeListeners()
      console.error('Banana - Failed to load search history', e)
    })
  }
}

export class BananaInFileModal extends BananaModal {
  constructor(
    plugin: BananaPlugin,
    file: TFile,
    searchQuery: string = '',
    parent?: BananaModal
  ) {
    super(plugin)

    const cmp = mount(ModalInFile, {
      target: this.modalEl,
      props: {
        plugin,
        modal: this,
        singleFilePath: file.path,
        parent: parent,
        previousQuery: searchQuery,
      },
    })

    if (parent) {
      // Hide the parent vault modal, and show it back when this one is closed
      parent.containerEl.toggleVisibility(false)
    }
    this.onClose = () => {
      this.disposeResizeListeners()
      if (parent) {
        parent.containerEl.toggleVisibility(true)
      }
      void unmount(cmp)
    }
  }
}
