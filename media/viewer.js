(function () {
  function initialize() {
    const vscode = acquireVsCodeApi();
    const main = document.getElementById('viewerViewport');
    const pdfContainer = document.getElementById('pdfContainer');
    const zoomRange = document.getElementById('zoomRange');
    const zoomValue = document.getElementById('zoomValue');
    const zoomOutButton = document.getElementById('zoomOut');
    const zoomInButton = document.getElementById('zoomIn');
    const pageNumberEl = document.getElementById('pageNumber');
    const pageCountEl = document.getElementById('pageCount');
    const pageJumpForm = document.getElementById('pageJumpForm');
    const pageJumpInput = document.getElementById('pageJumpInput');
    const pageJumpFeedback = document.getElementById('pageJumpFeedback');
    const toolbar = document.querySelector('.toolbar');
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuButtons = contextMenu
      ? Array.from(contextMenu.querySelectorAll('button[data-command]'))
      : [];
    const contextMenuCommandCache = new Map();
    let contextMenuMode = 'page';
    let pageJumpFeedbackTimer = 0;

    function handleFatalInitializationError(message, details) {
      console.error(message, details);

      if (pdfContainer instanceof HTMLElement) {
        pdfContainer.innerHTML = '';
        const errorBox = document.createElement('div');
        errorBox.className = 'error';
        errorBox.textContent = message;
        pdfContainer.appendChild(errorBox);
        return;
      }

      if (document.body instanceof HTMLElement) {
        document.body.innerHTML = '';
        const errorBox = document.createElement('div');
        errorBox.className = 'error';
        errorBox.textContent = message;
        document.body.appendChild(errorBox);
      }
    }

    function getContextMenuButton(command) {
      if (!contextMenu) {
        return null;
      }

      if (contextMenuCommandCache.has(command)) {
        return contextMenuCommandCache.get(command) || null;
      }

      const button = contextMenu.querySelector(`button[data-command="${command}"]`);
      if (button instanceof HTMLButtonElement) {
        contextMenuCommandCache.set(command, button);
        return button;
      }

      contextMenuCommandCache.set(command, null);
      return null;
    }

    function toggleContextMenuCommand(command, enabled) {
      const button = getContextMenuButton(command);
      if (!button) {
        return;
      }

      button.hidden = !enabled;
      button.setAttribute('aria-hidden', enabled ? 'false' : 'true');
      button.disabled = !enabled;
    }

    function updateContextMenuForPage(pageNumber) {
      contextMenuMode = 'page';

      const record = annotationsByPage.get(pageNumber);
      const hasNotes = Boolean(record?.notes?.length);
      const hasQuotes = Boolean(record?.quotes?.length);

      toggleContextMenuCommand('addNote', true);
      toggleContextMenuCommand('addQuote', true);
      toggleContextMenuCommand('copyPageText', true);
      toggleContextMenuCommand('toggleBookmark', true);
      toggleContextMenuCommand('editNote', false);
      toggleContextMenuCommand('editQuote', false);
      toggleContextMenuCommand('removeNote', hasNotes);
      toggleContextMenuCommand('removeQuote', hasQuotes);
    }

    function updateContextMenuForAnnotation(type) {
      contextMenuMode = 'annotation';

      const isNote = type === 'notes';
      const isQuote = type === 'quotes';

      toggleContextMenuCommand('addNote', false);
      toggleContextMenuCommand('addQuote', false);
      toggleContextMenuCommand('copyPageText', false);
      toggleContextMenuCommand('toggleBookmark', false);
      toggleContextMenuCommand('editNote', isNote);
      toggleContextMenuCommand('editQuote', isQuote);
      toggleContextMenuCommand('removeNote', isNote);
      toggleContextMenuCommand('removeQuote', isQuote);
    }
    const searchToggleButton = document.getElementById('searchToggle');
    const searchPopover = document.getElementById('searchPopover');
    const searchInput = document.getElementById('searchInput');
    const searchPrevButton = document.getElementById('searchPrev');
    const searchNextButton = document.getElementById('searchNext');
    const searchClearButton = document.getElementById('searchClear');
    const searchMatches = document.getElementById('searchMatches');
    const outlinePanel = document.getElementById('outlinePanel');
    const outlineToggle = document.getElementById('outlineToggle');
    const outlineList = document.getElementById('outlineList');
    const annotationSidebar = document.getElementById('annotationSidebar');
    const annotationToggle = document.getElementById('annotationToggle');
    const annotationSections = document.getElementById('annotationSections');
    const annotationBookmarksList = document.getElementById('annotationBookmarksList');
    const annotationNotesList = document.getElementById('annotationNotesList');
    const annotationQuotesList = document.getElementById('annotationQuotesList');
    const annotationBookmarksCount = document.getElementById('annotationBookmarksCount');
    const annotationNotesCount = document.getElementById('annotationNotesCount');
    const annotationQuotesCount = document.getElementById('annotationQuotesCount');
    const annotationBookmarksEmpty = document.getElementById('annotationBookmarksEmpty');
    const annotationNotesEmpty = document.getElementById('annotationNotesEmpty');
    const annotationQuotesEmpty = document.getElementById('annotationQuotesEmpty');

    const missingElements = [];
    if (!main) missingElements.push('#viewerViewport');
    if (!pdfContainer) missingElements.push('#pdfContainer');
    if (!(zoomRange instanceof HTMLInputElement)) missingElements.push('#zoomRange');
    if (!(zoomValue instanceof HTMLElement)) missingElements.push('#zoomValue');
    if (!(zoomOutButton instanceof HTMLButtonElement)) missingElements.push('#zoomOut');
    if (!(zoomInButton instanceof HTMLButtonElement)) missingElements.push('#zoomIn');
    if (!(pageNumberEl instanceof HTMLElement)) missingElements.push('#pageNumber');
    if (!(pageCountEl instanceof HTMLElement)) missingElements.push('#pageCount');
    if (!(toolbar instanceof HTMLElement)) missingElements.push('.toolbar');
    if (!(pageJumpInput instanceof HTMLInputElement)) missingElements.push('#pageJumpInput');
    if (!(pageJumpFeedback instanceof HTMLElement)) missingElements.push('#pageJumpFeedback');

    if (missingElements.length > 0) {
      handleFatalInitializationError(
        'PDF viewer failed to initialize. Required interface elements were not found.',
        { missingElements }
      );
      vscode.postMessage({ type: 'ready' });
      return;
    }

    const themeButtons = toolbar.querySelectorAll('button[data-theme]');
    const navigationButtons = toolbar.querySelectorAll('button[data-action]');
    const bookmarkButton = toolbar.querySelector('#bookmarkToggle');
    const bookmarkIcon = bookmarkButton?.querySelector('.toolbar__bookmark-icon');
    const pdfjsLibUri = document.body?.dataset?.pdfjsLib ?? '';
    const pdfjsWorkerUri = document.body?.dataset?.pdfjsWorker ?? '';

  const pdfjsReady = (async () => {
    if (window.pdfjsLib) {
      if (pdfjsWorkerUri) {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUri;
        } catch (error) {
          console.error('Failed to configure PDF.js worker source', error);
        }
      }
      return window.pdfjsLib;
    }

    if (!pdfjsLibUri) {
      console.error('PDF.js library URI is not available.');
      return null;
    }

    try {
      const pdfjsLib = await import(/* webpackIgnore: true */ pdfjsLibUri);
      if (pdfjsWorkerUri) {
        try {
          pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUri;
        } catch (error) {
          console.error('Failed to configure PDF.js worker source', error);
        }
      }
      window.pdfjsLib = pdfjsLib;
      return pdfjsLib;
    } catch (error) {
      console.error('Failed to load PDF.js library', error);
      return null;
    }
  })();

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  const ZOOM_STEP = 0.05;
  let pdfDoc = null;
  let currentPage = 1;
  let currentZoom = 1.0;
  let intersectionObserver = null;
  const pageViews = [];
  const pageTextContent = new Map();
  const searchMatchesByPage = new Map();
  const outlineElementsByPage = new Map();
  const activeOutlineElements = new Set();
  const annotationEntryElementsByPage = new Map();
  const activeAnnotationSidebarEntries = new Set();
  const virtualizationState = {
    slots: new Map(),
    bufferPages: 3,
    estimatedPageHeight: 960,
    pendingAnimationFrame: 0,
    lastRange: { start: 0, end: 0 }
  };
  const annotationsByPage = new Map();
  const annotationDestinations = new Map();
  const footnoteTooltipCache = new Map();
  const linkAnnotationHelpers = window.dunkelPdfLinkAnnotations || null;
  const pageBaseViewportHeights = new Map();
  const pendingPageHeightMeasurements = new Map();
  let contextMenuPage = null;
  let storedSelectionText = '';
  let isContextMenuOpen = false;
  const bookmarkedPages = new Set();
  const pageIndicatorLock = { pageNumber: null, timeoutHandle: 0 };
  const PAGE_LOCK_DURATION = 400;
  const PAGE_LOCK_RELEASE_RATIO = 0.6;
  const SEARCH_DEBOUNCE_MS = 200;
  let searchDebounceHandle = null;
  const searchState = {
    query: '',
    matches: [],
    activeIndex: -1
  };
  let isSearchPopoverOpen = false;
  let searchPopoverHideTimer = 0;
  const sharedHelpers = window.ViewerShared || {};
  const normalizeOutline =
    typeof sharedHelpers.normalizeOutline === 'function' ? sharedHelpers.normalizeOutline : () => [];
  const computeVirtualPageWindow =
    typeof sharedHelpers.computeVirtualPageWindow === 'function'
      ? sharedHelpers.computeVirtualPageWindow
      : () => ({ start: 1, end: 1 });

  let supportsTextLayer = false;
  pdfjsReady
    .then(lib => {
      supportsTextLayer = Boolean(lib?.renderTextLayer);
    })
    .catch(error => {
      console.error('Failed to determine PDF.js text layer support', error);
    });

  clearPageJumpFeedback();
  updatePageJumpBounds(null);
  setPageJumpInputEnabled(false);

  setBookmarkButtonEnabled(false);
  updateBookmarkButtonState();
  renderAnnotationSidebar();
  setupSearchControls();
  setupSearchToggle();
  if (outlineToggle instanceof HTMLButtonElement) {
    outlineToggle.addEventListener('click', () => {
      toggleOutlinePanel();
    });
  }
  if (annotationToggle instanceof HTMLButtonElement) {
    annotationToggle.addEventListener('click', () => {
      toggleAnnotationSidebar();
    });
  }
  if (main instanceof HTMLElement) {
    main.addEventListener('scroll', () => {
      scheduleVirtualizationUpdate();
    });
  }
  window.addEventListener('resize', () => {
    scheduleVirtualizationUpdate();
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || !message.type) {
      return;
    }

    switch (message.type) {
      case 'loadPdf':
        loadPdf(message.data);
        break;
      case 'setTheme':
        setTheme(message.theme);
        break;
      case 'setBookmarkStyle':
        setBookmarkStyle(message.style);
        break;
      case 'loadAnnotations':
      case 'annotationsUpdated':
        refreshAnnotationState(message.data ?? message.annotations ?? message.payload ?? null);
        break;
      default:
        break;
    }
  });

  navigationButtons.forEach(button => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      if (action === 'prev') {
        changePage(-1);
      } else if (action === 'next') {
        changePage(1);
      }
    });
  });

  if (pageJumpForm instanceof HTMLFormElement && pageJumpInput instanceof HTMLInputElement) {
    pageJumpForm.addEventListener('submit', event => {
      event.preventDefault();
      handlePageJumpSubmission(pageJumpInput.value).catch(error => {
        console.error('Failed to navigate to requested page', error);
      });
    });

    pageJumpInput.addEventListener('input', () => {
      clearPageJumpFeedback();
    });

    pageJumpInput.addEventListener('focus', () => {
      pageJumpInput.select();
    });

    pageJumpInput.addEventListener('blur', () => {
      if (pdfDoc) {
        syncPageJumpInput(currentPage);
      } else {
        pageJumpInput.value = '1';
      }
    });
  }

  themeButtons.forEach(button => {
    button.addEventListener('click', () => {
      const theme = button.getAttribute('data-theme');
      setTheme(theme);
      vscode.postMessage({ type: 'requestThemeChange', theme });
    });
  });

  zoomRange.addEventListener('input', () => {
    const parsed = Number.parseInt(zoomRange.value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setZoomLevel(parsed / 100);
  });

  zoomOutButton.addEventListener('click', event => {
    const multiplier = event.shiftKey ? 2 : 1;
    adjustZoom(-ZOOM_STEP * multiplier);
  });

  zoomInButton.addEventListener('click', event => {
    const multiplier = event.shiftKey ? 2 : 1;
    adjustZoom(ZOOM_STEP * multiplier);
  });

  if (bookmarkButton instanceof HTMLButtonElement) {
    bookmarkButton.addEventListener('click', () => {
      if (!pdfDoc || bookmarkButton.disabled) {
        return;
      }

      toggleBookmarkForCurrentPage();
      vscode.postMessage({
        type: 'toggleBookmark',
        page: currentPage
      });
    });
  }

  if (contextMenu) {
    pdfContainer.addEventListener('contextmenu', event => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('.pdf-annotations__item')) {
        return;
      }

      const surface = target.closest('.pdf-page__surface');
      if (!surface) {
        hideContextMenu();
        return;
      }

      const pageSection = surface.closest('.pdf-page');
      const pageNumber = Number(pageSection?.getAttribute('data-page-number'));
      if (!Number.isFinite(pageNumber)) {
        hideContextMenu();
        return;
      }

      event.preventDefault();
      showContextMenu(event, pageNumber);
    });

    contextMenuButtons.forEach(button => {
      button.addEventListener('click', async () => {
        if (!isContextMenuOpen || contextMenuPage === null) {
          hideContextMenu();
          return;
        }

        const savedPage = contextMenuPage;
        const command = button.getAttribute('data-command');
        if (!command) {
          hideContextMenu();
          return;
        }

        const liveSelection = (window.getSelection()?.toString() ?? '').trim();
        const selection = liveSelection || storedSelectionText;

        hideContextMenu();

        if (savedPage === null || savedPage === undefined) {
          return;
        }

        let handledLocally = false;

        if (command === 'copyPageText') {
          handledLocally = true;
          try {
            await copyPageText(savedPage);
          } catch (error) {
            console.error('Failed to copy page text', error);
          }
        } else if (command === 'toggleBookmark') {
          toggleBookmarkForPage(savedPage);
        }

        if (!handledLocally) {
          vscode.postMessage({
            type: command,
            page: savedPage,
            text: selection
          });
        }
      });
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isContextMenuOpen) {
        hideContextMenu();
      }
    });

    document.addEventListener('pointerdown', event => {
      if (!isContextMenuOpen || event.button !== 0) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Node)) {
        hideContextMenu();
        return;
      }

      if (!contextMenu.contains(target)) {
        hideContextMenu();
      }
    });

    window.addEventListener('blur', () => {
      if (isContextMenuOpen) {
        hideContextMenu();
      }
    });
  }

  function setupSearchControls() {
    updateMatchesCounter();
    updateSearchControls();

    const flushSearch = scroll => {
      if (!(searchInput instanceof HTMLInputElement)) {
        return;
      }

      if (searchDebounceHandle !== null) {
        window.clearTimeout(searchDebounceHandle);
        searchDebounceHandle = null;
      }

      applySearchQuery(searchInput.value, { scroll });
    };

    if (searchInput instanceof HTMLInputElement) {
      searchInput.addEventListener('input', () => {
        const value = searchInput.value;
        if (searchDebounceHandle !== null) {
          window.clearTimeout(searchDebounceHandle);
        }

        searchDebounceHandle = window.setTimeout(() => {
          applySearchQuery(value, { scroll: false });
          searchDebounceHandle = null;
        }, SEARCH_DEBOUNCE_MS);
      });

      searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          flushSearch(true);
          if (!searchState.matches.length) {
            return;
          }
          if (event.shiftKey) {
            setActiveMatch(searchState.activeIndex - 1, { scroll: true }).catch(error => {
              console.error('Failed to update search match', error);
            });
          } else {
            setActiveMatch(searchState.activeIndex + 1, { scroll: true }).catch(error => {
              console.error('Failed to update search match', error);
            });
          }
        }
      });

      searchInput.addEventListener('search', () => {
        flushSearch(false);
      });
    }

    if (searchPrevButton instanceof HTMLButtonElement) {
      searchPrevButton.addEventListener('click', () => {
        flushSearch(false);
        if (searchState.matches.length) {
          setActiveMatch(searchState.activeIndex - 1, { scroll: true }).catch(error => {
            console.error('Failed to update search match', error);
          });
        }
      });
    }

    if (searchNextButton instanceof HTMLButtonElement) {
      searchNextButton.addEventListener('click', () => {
        flushSearch(false);
        if (searchState.matches.length) {
          setActiveMatch(searchState.activeIndex + 1, { scroll: true }).catch(error => {
            console.error('Failed to update search match', error);
          });
        }
      });
    }

    if (searchClearButton instanceof HTMLButtonElement) {
      searchClearButton.addEventListener('click', () => {
        if (searchInput instanceof HTMLInputElement) {
          searchInput.value = '';
        }
        flushSearch(false);
        if (searchInput instanceof HTMLInputElement) {
          searchInput.focus({ preventScroll: true });
        }
      });
    }
  }

  function setupSearchToggle() {
    if (!(searchToggleButton instanceof HTMLButtonElement) || !(searchPopover instanceof HTMLElement)) {
      return;
    }

    searchToggleButton.addEventListener('click', () => {
      if (isSearchPopoverOpen) {
        closeSearchPopover({ restoreFocus: true });
      } else {
        openSearchPopover({ focusInput: true, selectText: true });
      }
    });

    if (searchInput instanceof HTMLInputElement) {
      searchInput.addEventListener('focus', () => {
        if (!isSearchPopoverOpen) {
          openSearchPopover({ focusInput: false });
        }
      });
    }

    searchPopover.addEventListener('focusout', event => {
      if (!isSearchPopoverOpen) {
        return;
      }

      const next = event.relatedTarget;
      if (next instanceof Node) {
        if (searchPopover.contains(next) || searchToggleButton.contains(next)) {
          return;
        }
      }

      closeSearchPopover();
    });

    window.addEventListener(
      'keydown',
      event => {
        if (event.defaultPrevented) {
          return;
        }

        const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
        if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'f') {
          event.preventDefault();
          openSearchPopover({ focusInput: true, selectText: true });
        }
      },
      true
    );
  }

  function openSearchPopover(options = {}) {
    if (!(searchToggleButton instanceof HTMLButtonElement) || !(searchPopover instanceof HTMLElement)) {
      return;
    }

    if (!isSearchPopoverOpen) {
      isSearchPopoverOpen = true;
      if (searchPopoverHideTimer) {
        window.clearTimeout(searchPopoverHideTimer);
        searchPopoverHideTimer = 0;
      }
      searchPopover.hidden = false;
      searchPopover.setAttribute('aria-hidden', 'false');
      searchToggleButton.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', handleSearchPopoverPointerDown, true);
      document.addEventListener('keydown', handleSearchPopoverKeydown, true);
      window.requestAnimationFrame(() => {
        if (isSearchPopoverOpen) {
          searchPopover.classList.add('is-visible');
        }
      });
    }

    if (options.focusInput !== false && searchInput instanceof HTMLInputElement) {
      window.requestAnimationFrame(() => {
        searchInput.focus({ preventScroll: true });
        if (options.selectText !== false) {
          searchInput.select();
        }
      });
    }
  }

  function closeSearchPopover(options = {}) {
    if (!isSearchPopoverOpen || !(searchToggleButton instanceof HTMLButtonElement) || !(searchPopover instanceof HTMLElement)) {
      return;
    }

    isSearchPopoverOpen = false;
    searchPopover.classList.remove('is-visible');
    searchPopover.setAttribute('aria-hidden', 'true');
    searchToggleButton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', handleSearchPopoverPointerDown, true);
    document.removeEventListener('keydown', handleSearchPopoverKeydown, true);

    if (searchPopoverHideTimer) {
      window.clearTimeout(searchPopoverHideTimer);
    }

    searchPopoverHideTimer = window.setTimeout(() => {
      searchPopover.hidden = true;
      searchPopoverHideTimer = 0;
    }, 180);

    if (options.restoreFocus && typeof searchToggleButton.focus === 'function') {
      searchToggleButton.focus({ preventScroll: true });
    }
  }

  function handleSearchPopoverPointerDown(event) {
    if (!isSearchPopoverOpen || !(searchPopover instanceof HTMLElement) || !(searchToggleButton instanceof HTMLButtonElement)) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (searchPopover.contains(target) || searchToggleButton.contains(target)) {
      return;
    }

    closeSearchPopover();
  }

  function handleSearchPopoverKeydown(event) {
    if (!isSearchPopoverOpen) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        openSearchPopover({ focusInput: true, selectText: true });
        return;
      }
    }

    if (event.key === 'Escape') {
      if (!event.defaultPrevented) {
        event.preventDefault();
      }
      event.stopPropagation();
      closeSearchPopover({ restoreFocus: true });
    }
  }

  function clearSearchStateBeforeDocumentChange() {
    pageViews.forEach(pageView => {
      if (pageView) {
        clearHighlightsForPage(pageView);
      }
    });
    if (searchDebounceHandle !== null) {
      window.clearTimeout(searchDebounceHandle);
      searchDebounceHandle = null;
    }
    searchMatchesByPage.clear();
    searchState.matches = [];
    searchState.activeIndex = -1;
    updateMatchesCounter();
    updateSearchControls();
  }

  async function applySearchQuery(rawValue, options = {}) {
    const value = typeof rawValue === 'string' ? rawValue : '';
    const query = value.trim();
    const force = Boolean(options.force);
    const isSameQuery = !force && query === searchState.query;
    const previousKey = isSameQuery ? getActiveMatchKey() : null;

    if (!isSameQuery) {
      searchState.query = query;
      if (!query) {
        searchState.activeIndex = -1;
      }
    }

    await recomputeAllMatches(previousKey);

    if (query && searchState.matches.length) {
      if (!isSameQuery) {
        await setActiveMatch(0, { scroll: options.scroll === true });
      } else if (options.scroll && searchState.activeIndex >= 0) {
        await updateActiveHighlight({ scroll: true });
        updateMatchesCounter();
      }
    }
  }

  async function recomputeAllMatches(previousKey) {
    pageViews.forEach(pageView => {
      if (pageView) {
        clearHighlightsForPage(pageView);
      }
    });

    searchMatchesByPage.clear();

    if (!pdfDoc || !searchState.query) {
      refreshGlobalMatches(previousKey);
      return;
    }

    const tasks = [];
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
      tasks.push(updateMatchesForPage(pageNumber));
    }

    await Promise.all(tasks);
    refreshGlobalMatches(previousKey);
  }

  async function updateMatchesForPage(pageNumber, options = {}) {
    if (!pdfDoc || !searchState.query) {
      searchMatchesByPage.set(pageNumber, []);
      return [];
    }

    const preferTextLayer = options.preferTextLayer !== false;
    const pageView = getPageView(pageNumber);
    let sourceText = '';

    if (preferTextLayer && pageView?.textLayerDiv?.textContent) {
      sourceText = pageView.textLayerDiv.textContent;
    }

    if (!sourceText) {
      sourceText = await ensureTextContentForPage(pageNumber);
    }

    if (!sourceText) {
      searchMatchesByPage.set(pageNumber, []);
      return [];
    }

    const existing = searchMatchesByPage.get(pageNumber) || [];
    const existingByOffset = new Map(existing.map(match => [match.startOffset, match]));
    const matches = computeTextMatches(sourceText, searchState.query);
    const next = matches.map(match => {
      const reused = existingByOffset.get(match.startOffset);
      if (reused) {
        reused.length = match.length;
        reused.element = null;
        reused.pageNumber = pageNumber;
        return reused;
      }
      return { pageNumber, startOffset: match.startOffset, length: match.length, element: null };
    });

    searchMatchesByPage.set(pageNumber, next);

    if (pageView) {
      applySearchHighlightsForPage(pageView, { suppressRefresh: true });
    }

    return next;
  }

  async function ensureTextContentForPage(pageNumber) {
    if (pageTextContent.has(pageNumber)) {
      return pageTextContent.get(pageNumber);
    }

    if (!pdfDoc) {
      return '';
    }

    try {
      const page = await pdfDoc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const extracted = extractTextFromTextContent(textContent);
      pageTextContent.set(pageNumber, extracted);
      return extracted;
    } catch (error) {
      console.error('Failed to read text for page', error);
      return '';
    }
  }

  function computeTextMatches(sourceText, query) {
    if (!sourceText || !query) {
      return [];
    }

    const lowerSource = sourceText.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (!lowerSource.includes(lowerQuery)) {
      return [];
    }

    const matches = [];
    const length = lowerQuery.length;
    let index = lowerSource.indexOf(lowerQuery);

    while (index !== -1) {
      matches.push({ startOffset: index, length });
      index = lowerSource.indexOf(lowerQuery, index + length);
    }

    return matches;
  }

  function applySearchHighlightsForPage(pageView, options = {}) {
    if (!pageView) {
      return;
    }

    const { suppressRefresh = false, previousKey = null } = options;
    clearHighlightsForPage(pageView);

    if (!supportsTextLayer || !searchState.query) {
      if (!suppressRefresh) {
        refreshGlobalMatches(previousKey);
      }
      return;
    }

    if (!pageView.textLayerDiv || !pageView.textLayerDiv.childNodes.length) {
      if (!suppressRefresh) {
        refreshGlobalMatches(previousKey);
      }
      return;
    }

    const matches = searchMatchesByPage.get(pageView.pageNumber) || [];
    if (!matches.length) {
      if (!suppressRefresh) {
        refreshGlobalMatches(previousKey);
      }
      return;
    }

    const highlighted = highlightMatchesForPage(pageView, matches);
    const byOffset = new Map(highlighted.map(entry => [entry.startOffset, entry.element]));
    matches.forEach(match => {
      match.element = byOffset.get(match.startOffset) ?? null;
    });
    pageView.searchHighlights = highlighted;

    if (!suppressRefresh) {
      refreshGlobalMatches(previousKey);
    }
  }

  function clearHighlightsForPage(pageView) {
    if (!pageView?.textLayerDiv) {
      return;
    }

    const highlights = pageView.textLayerDiv.querySelectorAll('.search-highlight');
    highlights.forEach(highlight => {
      const parent = highlight.parentNode;
      if (!parent) {
        return;
      }
      while (highlight.firstChild) {
        parent.insertBefore(highlight.firstChild, highlight);
      }
      parent.removeChild(highlight);
      if (parent instanceof Element) {
        parent.normalize();
      }
    });

    const matches = searchMatchesByPage.get(pageView.pageNumber);
    if (matches) {
      matches.forEach(match => {
        match.element = null;
      });
    }

    pageView.searchHighlights = [];
  }

  function highlightMatchesForPage(pageView, matches) {
    if (!Array.isArray(matches) || !matches.length) {
      return [];
    }

    const textLayer = pageView?.textLayerDiv;
    if (!textLayer) {
      return [];
    }

    const results = [];

    matches.forEach(match => {
      const startPosition = resolveTextPosition(textLayer, match.startOffset);
      const endPosition = resolveTextPosition(textLayer, match.startOffset + match.length);

      if (!startPosition || !endPosition) {
        return;
      }

      const range = document.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const highlight = document.createElement('span');
      highlight.className = 'search-highlight';

      try {
        range.surroundContents(highlight);
        results.push({ element: highlight, pageNumber: pageView.pageNumber, startOffset: match.startOffset });
      } catch (error) {
        console.error('Failed to highlight search match', error);
      } finally {
        range.detach?.();
      }
    });

    return results;
  }

  function resolveTextPosition(container, targetOffset) {
    if (!container) {
      return null;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let remaining = targetOffset;
    let node = walker.nextNode();
    let lastNode = null;

    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        return { node, offset: remaining };
      }
      remaining -= length;
      lastNode = node;
      node = walker.nextNode();
    }

    if (lastNode) {
      return { node: lastNode, offset: lastNode.textContent?.length ?? 0 };
    }

    return null;
  }

  function refreshGlobalMatches(previousKey) {
    const aggregated = [];

    searchMatchesByPage.forEach(pageMatches => {
      pageMatches.forEach(match => {
        aggregated.push(match);
      });
    });

    aggregated.sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) {
        return a.pageNumber - b.pageNumber;
      }
      return a.startOffset - b.startOffset;
    });

    searchState.matches = aggregated;

    let targetIndex = -1;
    if (previousKey) {
      targetIndex = aggregated.findIndex(
        match => match.pageNumber === previousKey.pageNumber && match.startOffset === previousKey.startOffset
      );
    }

    if (targetIndex === -1 && aggregated.length) {
      if (searchState.activeIndex >= 0 && searchState.activeIndex < aggregated.length) {
        targetIndex = searchState.activeIndex;
      } else {
        targetIndex = 0;
      }
    }

    if (aggregated.length) {
      searchState.activeIndex = Math.max(0, Math.min(targetIndex, aggregated.length - 1));
    } else {
      searchState.activeIndex = -1;
    }

    updateMatchesCounter();
    updateSearchControls();
    updateActiveHighlight({ scroll: false }).catch(error => {
      console.error('Failed to update active highlight', error);
    });
  }

  function getActiveMatchKey() {
    if (searchState.activeIndex < 0 || searchState.activeIndex >= searchState.matches.length) {
      return null;
    }

    const activeMatch = searchState.matches[searchState.activeIndex];
    if (!activeMatch) {
      return null;
    }

    return { pageNumber: activeMatch.pageNumber, startOffset: activeMatch.startOffset };
  }

  function updateMatchesCounter() {
    const total = searchState.matches.length;
    const current = total && searchState.activeIndex >= 0 ? searchState.activeIndex + 1 : 0;
    searchMatches.textContent = `${current} / ${total}`;
  }

  function updateSearchControls() {
    const hasMatches = searchState.matches.length > 0;
    const hasQuery = Boolean(searchState.query);

    searchPrevButton.disabled = !hasMatches;
    searchNextButton.disabled = !hasMatches;
    searchClearButton.disabled = !hasQuery;
    if (searchToggleButton instanceof HTMLButtonElement) {
      searchToggleButton.classList.toggle('toolbar__search-toggle--active', hasQuery);
    }
  }

  async function setActiveMatch(targetIndex, options = {}) {
    const total = searchState.matches.length;
    if (!total) {
      searchState.activeIndex = -1;
      await updateActiveHighlight({ scroll: false });
      updateMatchesCounter();
      updateSearchControls();
      return;
    }

    let index = Number.isFinite(targetIndex) ? targetIndex : 0;
    index = ((index % total) + total) % total;
    searchState.activeIndex = index;
    await updateActiveHighlight({ scroll: options.scroll !== false });
    updateMatchesCounter();
  }

  async function updateActiveHighlight(options = {}) {
    const { scroll = false } = options;
    const tasks = [];

    searchState.matches.forEach((match, idx) => {
      if (!match) {
        return;
      }

      if (idx === searchState.activeIndex) {
        tasks.push(
          ensureMatchElement(match).then(element => {
            if (element) {
              element.classList.add('is-active');
              if (scroll) {
                updatePageIndicator(match.pageNumber, { lock: true });
                scrollMatchIntoView(element);
              }
            }
          })
        );
      } else if (match.element) {
        match.element.classList.remove('is-active');
      }
    });

    await Promise.all(tasks);
  }

  async function ensureMatchElement(match) {
    if (!match) {
      return null;
    }

    if (match.element?.isConnected) {
      return match.element;
    }

    const pageView = await ensurePageViewMaterialized(match.pageNumber);
    if (!pageView) {
      return null;
    }

    scheduleVirtualizationUpdate();

    await updateMatchesForPage(match.pageNumber, { preferTextLayer: true });
    applySearchHighlightsForPage(pageView, { suppressRefresh: true });

    return match.element ?? null;
  }

  function scrollMatchIntoView(element) {
    if (!element || !element.isConnected) {
      return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }

  function lockPageIndicator(pageNumber, duration) {
    if (!Number.isFinite(pageNumber)) {
      return;
    }

    if (pageIndicatorLock.timeoutHandle) {
      window.clearTimeout(pageIndicatorLock.timeoutHandle);
      pageIndicatorLock.timeoutHandle = 0;
    }

    pageIndicatorLock.pageNumber = pageNumber;

    if (duration > 0) {
      pageIndicatorLock.timeoutHandle = window.setTimeout(() => {
        releasePageIndicatorLock();
      }, duration);
    }
  }

  function releasePageIndicatorLock() {
    if (pageIndicatorLock.timeoutHandle) {
      window.clearTimeout(pageIndicatorLock.timeoutHandle);
      pageIndicatorLock.timeoutHandle = 0;
    }
    pageIndicatorLock.pageNumber = null;
  }

  function refreshAnnotationState(data) {
    annotationsByPage.clear();

    if (!data || typeof data !== 'object') {
      setBookmarkedPages([]);
      renderAnnotationsForAllPages();
      renderAnnotationSidebar();
      return;
    }

    const notes = Array.isArray(data.notes) ? data.notes : [];
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];

    const processEntries = (entries, type) => {
      entries.forEach(entry => {
        if (!entry || typeof entry !== 'object') {
          return;
        }

        const page = normalizePageNumber(entry.page);
        if (page === null) {
          return;
        }

        const content = typeof entry.content === 'string' ? entry.content.trim() : '';
        if (!content) {
          return;
        }

        const record = getOrCreateAnnotationRecord(page);
        record[type].push(content);
      });
    };

    processEntries(notes, 'notes');
    processEntries(quotes, 'quotes');

    setBookmarkedPages(bookmarks);
    renderAnnotationsForAllPages();
    renderAnnotationSidebar();
  }

  function getOrCreateAnnotationRecord(page) {
    let record = annotationsByPage.get(page);
    if (!record) {
      record = { notes: [], quotes: [] };
      annotationsByPage.set(page, record);
    }
    return record;
  }

  function setBookmarkedPages(pages) {
    bookmarkedPages.clear();

    pages.forEach(page => {
      const normalized = normalizePageNumber(page);
      if (normalized !== null) {
        bookmarkedPages.add(normalized);
      }
    });

    applyBookmarksToPages();
    updateBookmarkButtonState();
  }

  function normalizePageNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  function applyBookmarksToPages() {
    pageViews.forEach(pageView => {
      if (pageView) {
        syncBookmarkStateToPageView(pageView);
      }
    });
  }

  function syncBookmarkStateToPageView(pageView) {
    if (!pageView) {
      return;
    }
    const isBookmarked = bookmarkedPages.has(pageView.pageNumber);
    pageView.wrapper.classList.toggle('pdf-page--bookmarked', isBookmarked);
  }

  function updateBookmarkButtonState() {
    if (!(bookmarkButton instanceof HTMLButtonElement)) {
      return;
    }

    const hasPdf = Boolean(pdfDoc);
    const page = Number.isFinite(currentPage) ? Math.trunc(currentPage) : null;
    const isBookmarked = Boolean(hasPdf && page && bookmarkedPages.has(page));

    bookmarkButton.classList.toggle('is-active', isBookmarked);
    bookmarkButton.setAttribute('aria-pressed', isBookmarked ? 'true' : 'false');

    if (bookmarkIcon) {
      bookmarkIcon.textContent = isBookmarked ? '★' : '☆';
    }

    if (hasPdf && page) {
      const action = isBookmarked ? 'Remove bookmark from page' : 'Bookmark page';
      const description = `${action} ${page}`;
      bookmarkButton.title = description;
      bookmarkButton.setAttribute('aria-label', description);
    } else {
      bookmarkButton.title = 'Bookmark current page';
      bookmarkButton.setAttribute('aria-label', 'Bookmark current page');
    }
  }

  function toggleBookmarkForCurrentPage() {
    toggleBookmarkForPage(currentPage);
  }

  function toggleBookmarkForPage(page) {
    const normalized = normalizePageNumber(page);
    if (normalized === null) {
      return;
    }

    if (bookmarkedPages.has(normalized)) {
      bookmarkedPages.delete(normalized);
    } else {
      bookmarkedPages.add(normalized);
    }

    applyBookmarksToPages();
    updateBookmarkButtonState();
    renderAnnotationSidebar();
  }

  function setBookmarkButtonEnabled(enabled) {
    if (!(bookmarkButton instanceof HTMLButtonElement)) {
      return;
    }

    bookmarkButton.disabled = !enabled;
    if (enabled) {
      bookmarkButton.removeAttribute('aria-disabled');
    } else {
      bookmarkButton.setAttribute('aria-disabled', 'true');
    }
  }

  function decodeBase64(data) {
    const raw = window.atob(data);
    const rawLength = raw.length;
    const array = new Uint8Array(new ArrayBuffer(rawLength));
    for (let i = 0; i < rawLength; i++) {
      array[i] = raw.charCodeAt(i);
    }
    return array;
  }

  function getPageView(pageNumber) {
    if (!Number.isFinite(pageNumber)) {
      return null;
    }
    return pageViews[pageNumber - 1] ?? null;
  }

  function getSlotRecord(pageNumber) {
    return virtualizationState.slots.get(pageNumber) ?? null;
  }

  function resetVirtualizationState() {
    virtualizationState.slots.forEach(record => {
      const element = record?.element;
      if (element) {
        intersectionObserver?.unobserve(element);
      }
    });
    virtualizationState.slots.clear();
    virtualizationState.lastRange = { start: 0, end: 0 };
    if (virtualizationState.pendingAnimationFrame) {
      window.cancelAnimationFrame(virtualizationState.pendingAnimationFrame);
      virtualizationState.pendingAnimationFrame = 0;
    }
  }

  function scheduleVirtualizationUpdate(options = {}) {
    const immediate =
      typeof options === 'boolean' ? options : Boolean(options?.immediate);

    if (!pdfDoc) {
      return;
    }

    if (immediate) {
      if (virtualizationState.pendingAnimationFrame) {
        window.cancelAnimationFrame(virtualizationState.pendingAnimationFrame);
        virtualizationState.pendingAnimationFrame = 0;
      }
      updateVirtualizedPages();
      return;
    }

    if (virtualizationState.pendingAnimationFrame) {
      return;
    }

    virtualizationState.pendingAnimationFrame = window.requestAnimationFrame(() => {
      virtualizationState.pendingAnimationFrame = 0;
      updateVirtualizedPages();
    });
  }

  function updateVirtualizedPages() {
    if (!pdfDoc) {
      return;
    }

    const estimated = Math.max(virtualizationState.estimatedPageHeight, 1);
    const visiblePages = Math.max(1, Math.ceil(main.clientHeight / estimated));
    const range = computeVirtualPageWindow({
      totalPages: pdfDoc.numPages,
      currentPage,
      visiblePages,
      bufferPages: virtualizationState.bufferPages
    });

    if (!range.start || !range.end) {
      return;
    }

    virtualizationState.lastRange = range;

    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
      if (pageNumber >= range.start && pageNumber <= range.end) {
        ensurePageView(pageNumber);
      } else {
        releasePageView(pageNumber);
      }
    }
  }

  function ensurePageView(pageNumber) {
    const slotRecord = getSlotRecord(pageNumber);
    if (!slotRecord) {
      return null;
    }

    let pageView = getPageView(pageNumber);
    if (pageView) {
      if (slotRecord.view !== pageView) {
        slotRecord.view = pageView;
        slotRecord.element.innerHTML = '';
        slotRecord.element.appendChild(pageView.wrapper);
      }
      return pageView;
    }

    pageView = createPageView(pageNumber);
    pageViews[pageNumber - 1] = pageView;
    slotRecord.view = pageView;
    slotRecord.element.innerHTML = '';
    slotRecord.element.appendChild(pageView.wrapper);
    syncBookmarkStateToPageView(pageView);
    renderAnnotationsForPage(pageView);
    pageView.renderPromise = renderPageView(pageView).catch(error => {
      if (error?.name !== 'RenderingCancelledException') {
        console.error('Failed to render page view', error);
      }
    });
    return pageView;
  }

  function releasePageView(pageNumber) {
    const slotRecord = getSlotRecord(pageNumber);
    const pageView = getPageView(pageNumber);
    if (!slotRecord || !pageView || slotRecord.view !== pageView) {
      return;
    }

    if (pageView.renderTask?.cancel) {
      try {
        pageView.renderTask.cancel();
      } catch (error) {
        console.error('Failed to cancel render task', error);
      }
    }

    if (pageView.textLayerTask?.cancel) {
      try {
        pageView.textLayerTask.cancel();
      } catch (error) {
        console.error('Failed to cancel text layer task', error);
      }
    }

    clearHighlightsForPage(pageView);
    if (pageView.annotationLayerDiv) {
      pageView.annotationLayerDiv.innerHTML = '';
    }

    const measured = pageView.wrapper.offsetHeight;
    const updatedHeight = Math.max(12, Math.round(measured || slotRecord.height || virtualizationState.estimatedPageHeight));
    slotRecord.height = updatedHeight;
    slotRecord.element.style.minHeight = `${updatedHeight}px`;

    if (pageView.wrapper.parentNode === slotRecord.element) {
      slotRecord.element.removeChild(pageView.wrapper);
    } else {
      pageView.wrapper.remove();
    }

    slotRecord.view = null;
    pageViews[pageNumber - 1] = null;
    pageView.renderPromise = null;
  }

  async function ensurePageViewMaterialized(pageNumber) {
    const pageView = ensurePageView(pageNumber);
    if (!pageView) {
      return null;
    }

    if (pageView.renderPromise) {
      try {
        await pageView.renderPromise;
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error('Failed to render page', error);
        }
      }
    }

    return pageView;
  }

  function updateSlotHeight(pageNumber, viewportHeight, options = {}) {
    const slotRecord = getSlotRecord(pageNumber);
    if (!slotRecord) {
      return;
    }

    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      return;
    }

    const paddedHeight = Math.max(12, Math.round(viewportHeight + 48));
    slotRecord.height = paddedHeight;
    slotRecord.element.style.minHeight = `${paddedHeight}px`;
    const providedBaseHeight = Number.isFinite(options.baseHeight) ? options.baseHeight : null;
    if (providedBaseHeight && providedBaseHeight > 0) {
      pageBaseViewportHeights.set(pageNumber, providedBaseHeight);
    } else {
      const baseHeight = viewportHeight / currentZoom;
      if (Number.isFinite(baseHeight) && baseHeight > 0) {
        pageBaseViewportHeights.set(pageNumber, baseHeight);
      }
    }
    virtualizationState.estimatedPageHeight = Math.round(
      (virtualizationState.estimatedPageHeight + paddedHeight) / 2
    );
  }

  function clearOutlineSidebar() {
    outlineElementsByPage.clear();
    activeOutlineElements.clear();
    outlineList.innerHTML = '';
    outlineToggle.disabled = true;
    outlineToggle.setAttribute('aria-expanded', 'false');
    outlinePanel.setAttribute('aria-hidden', 'true');
    outlinePanel.classList.add('outline--collapsed');
  }

  async function buildOutlineSidebar() {
    clearOutlineSidebar();

    if (!pdfDoc) {
      return;
    }

    try {
      const outline = await pdfDoc.getOutline();
      const normalized = normalizeOutline(outline, { idPrefix: 'outline' });
      if (!normalized.length) {
        return;
      }

      const fragment = document.createDocumentFragment();
      await appendOutlineNodes(normalized, 0, fragment);

      if (fragment.childNodes.length) {
        outlineList.appendChild(fragment);
        outlineToggle.disabled = false;
        outlinePanel.removeAttribute('aria-hidden');
        setOutlineVisibility(false);
        setActiveOutlineEntry(currentPage);
      }
    } catch (error) {
      console.error('Failed to build outline sidebar', error);
      outlineList.innerHTML = '';
      outlineToggle.disabled = true;
      outlinePanel.setAttribute('aria-hidden', 'true');
      outlinePanel.classList.add('outline--collapsed');
    }
  }

  async function appendOutlineNodes(nodes, depth, container) {
    for (const node of nodes) {
      if (!node) {
        continue;
      }

      const item = document.createElement('div');
      item.className = 'outline__item';

      const entryButton = document.createElement('button');
      entryButton.type = 'button';
      entryButton.className = 'outline__entry';
      entryButton.style.setProperty('--outline-depth', String(depth));
      entryButton.textContent = node.title || 'Untitled';
      entryButton.disabled = true;

      if (node.bold) {
        entryButton.style.fontWeight = '600';
      }
      if (node.italic) {
        entryButton.style.fontStyle = 'italic';
      }
      if (Array.isArray(node.color) && node.color.length === 3) {
        const [r, g, b] = node.color.map(component => Math.round(Math.max(0, Math.min(1, component ?? 0)) * 255));
        entryButton.style.color = `rgb(${r}, ${g}, ${b})`;
      }

      item.appendChild(entryButton);
      container.appendChild(item);

      if (node.dest) {
        try {
          const pageNumber = await resolveDestinationToPage(node.dest);
          if (pageNumber) {
            entryButton.disabled = false;
            entryButton.addEventListener('click', event => {
              event.preventDefault();
              navigateToDestination(node.dest);
            });

            let elements = outlineElementsByPage.get(pageNumber);
            if (!elements) {
              elements = [];
              outlineElementsByPage.set(pageNumber, elements);
            }
            elements.push(entryButton);
          }
        } catch (error) {
          console.error('Failed to resolve outline entry', error);
        }
      } else if (node.url) {
        entryButton.disabled = false;
        entryButton.addEventListener('click', event => {
          event.preventDefault();
          try {
            window.open(node.url, '_blank', 'noopener');
          } catch (error) {
            console.error('Failed to open outline link', error);
          }
        });
      }

      if (node.children?.length) {
        await appendOutlineNodes(node.children, depth + 1, container);
      }
    }
  }

  function toggleOutlinePanel() {
    if (outlineToggle.disabled) {
      return;
    }
    const isCollapsed = outlinePanel.classList.contains('outline--collapsed');
    setOutlineVisibility(isCollapsed);
  }

  function setOutlineVisibility(isOpen) {
    if (isOpen) {
      outlinePanel.classList.remove('outline--collapsed');
      outlinePanel.setAttribute('aria-hidden', 'false');
      outlineToggle.setAttribute('aria-expanded', 'true');
    } else {
      outlinePanel.classList.add('outline--collapsed');
      outlinePanel.setAttribute('aria-hidden', 'true');
      outlineToggle.setAttribute('aria-expanded', 'false');
    }
  }

  function setActiveOutlineEntry(pageNumber) {
    activeOutlineElements.forEach(element => {
      element.classList.remove('is-active');
    });
    activeOutlineElements.clear();

    const targets = outlineElementsByPage.get(pageNumber) || [];
    targets.forEach(element => {
      element.classList.add('is-active');
      activeOutlineElements.add(element);
    });
  }

  function toggleAnnotationSidebar() {
    if (annotationToggle.disabled || !(annotationSidebar instanceof HTMLElement)) {
      return;
    }

    const isCollapsed = annotationSidebar.classList.contains('annotation-sidebar--collapsed');
    setAnnotationSidebarVisibility(isCollapsed);
  }

  function setAnnotationSidebarVisibility(isOpen) {
    if (!(annotationSidebar instanceof HTMLElement) || !(annotationToggle instanceof HTMLButtonElement)) {
      return;
    }

    if (isOpen) {
      annotationSidebar.classList.remove('annotation-sidebar--collapsed');
      annotationSidebar.setAttribute('aria-hidden', 'false');
      annotationToggle.setAttribute('aria-expanded', 'true');
      if (annotationSections instanceof HTMLElement) {
        annotationSections.setAttribute('aria-hidden', 'false');
      }
    } else {
      annotationSidebar.classList.add('annotation-sidebar--collapsed');
      annotationSidebar.setAttribute('aria-hidden', 'true');
      annotationToggle.setAttribute('aria-expanded', 'false');
      if (annotationSections instanceof HTMLElement) {
        annotationSections.setAttribute('aria-hidden', 'true');
      }
    }
  }

  function setActiveAnnotationEntries(pageNumber) {
    activeAnnotationSidebarEntries.forEach(element => {
      if (element?.classList) {
        element.classList.remove('is-active');
      }
    });
    activeAnnotationSidebarEntries.clear();

    const normalized = normalizePageNumber(pageNumber);
    if (normalized === null) {
      return;
    }

    const entries = annotationEntryElementsByPage.get(normalized);
    if (!entries) {
      return;
    }

    entries.forEach(element => {
      if (element?.isConnected) {
        element.classList.add('is-active');
        activeAnnotationSidebarEntries.add(element);
      }
    });
  }

  function setupIntersectionObserver() {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
    }

    const thresholds = [0.1, 0.25, 0.5, 0.75, 0.9];
    intersectionObserver = new IntersectionObserver(entries => {
      let bestEntry = null;
      entries.forEach(entry => {
        if (!entry.isIntersecting) {
          return;
        }
        if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) {
          bestEntry = entry;
        }
      });

      if (bestEntry?.target) {
        const pageNumber = Number(bestEntry.target.getAttribute('data-page-number'));
        if (!Number.isNaN(pageNumber)) {
          const ratio = typeof bestEntry.intersectionRatio === 'number'
            ? bestEntry.intersectionRatio
            : 0;

          if (
            pageIndicatorLock.pageNumber !== null &&
            pageIndicatorLock.pageNumber !== pageNumber &&
            ratio < PAGE_LOCK_RELEASE_RATIO
          ) {
            return;
          }

          if (pageIndicatorLock.pageNumber === pageNumber && ratio >= PAGE_LOCK_RELEASE_RATIO) {
            releasePageIndicatorLock();
          }

          updatePageIndicator(pageNumber);
        }
      }
    }, {
      root: main,
      threshold: thresholds
    });
  }

  async function loadPdf(data) {
    pdfDoc = null;
    pageBaseViewportHeights.clear();
    pendingPageHeightMeasurements.clear();
    releasePageIndicatorLock();
    setBookmarkButtonEnabled(false);
    setBookmarkedPages([]);
    setPageJumpInputEnabled(false);
    updatePageJumpBounds(null);
    clearPageJumpFeedback();
    renderAnnotationSidebar();
    clearSearchStateBeforeDocumentChange();
    clearOutlineSidebar();
    resetVirtualizationState();
    pageTextContent.clear();
    searchMatchesByPage.clear();

    try {
      const pdfjsLib = await pdfjsReady;
      if (!pdfjsLib) {
        showError('PDF viewer failed to load. Please reload the editor.');
        return;
      }

      setStatus('Loading PDF…');
      hideContextMenu();
      const pdfData = decodeBase64(data);
      pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
      renderAnnotationSidebar();

      pageCountEl.textContent = pdfDoc.numPages.toString();
      updatePageJumpBounds(pdfDoc.numPages);
      setPageJumpInputEnabled(true);
      currentPage = 1;
      updatePageIndicator(currentPage, { lock: true });
      setupIntersectionObserver();
      pageViews.length = pdfDoc.numPages;
      pageViews.fill(null);

      const fragment = document.createDocumentFragment();

      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
        const slot = document.createElement('div');
        slot.className = 'pdf-page-slot';
        slot.setAttribute('data-page-number', String(pageNumber));
        slot.style.minHeight = `${virtualizationState.estimatedPageHeight}px`;
        virtualizationState.slots.set(pageNumber, {
          element: slot,
          pageNumber,
          view: null,
          height: virtualizationState.estimatedPageHeight
        });
        fragment.appendChild(slot);
        intersectionObserver?.observe(slot);
      }

      pdfContainer.innerHTML = '';
      pdfContainer.appendChild(fragment);
      main.scrollTo({ top: 0, left: 0, behavior: 'auto' });

      await buildOutlineSidebar();

      setBookmarkButtonEnabled(true);
      updateBookmarkButtonState();
      scheduleVirtualizationUpdate({ immediate: true });
      await applySearchQuery(searchInput.value, { force: true, scroll: false });
    } catch (error) {
      setBookmarkButtonEnabled(false);
      updateBookmarkButtonState();
      setPageJumpInputEnabled(false);
      updatePageJumpBounds(null);
      clearPageJumpFeedback();
      if (error?.name === 'RenderingCancelledException') {
        return;
      }
      showError(String(error));
    }
  }

  function createPageView(pageNumber) {
    const wrapper = document.createElement('section');
    wrapper.className = 'pdf-page';
    wrapper.setAttribute('data-page-number', String(pageNumber));

    const surface = document.createElement('div');
    surface.className = 'pdf-page__surface';

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';

    const annotationLayerDiv = document.createElement('div');
    annotationLayerDiv.className = 'annotationLayer';

    surface.appendChild(canvas);
    surface.appendChild(textLayerDiv);
    surface.appendChild(annotationLayerDiv);
    wrapper.appendChild(surface);

    const annotationsContainer = document.createElement('aside');
    annotationsContainer.className = 'pdf-page__annotations';
    annotationsContainer.setAttribute('role', 'region');
    annotationsContainer.setAttribute('aria-label', `Annotations for page ${pageNumber}`);
    annotationsContainer.hidden = true;
    wrapper.appendChild(annotationsContainer);

    const pageView = {
      pageNumber,
      wrapper,
      surface,
      canvas,
      textLayerDiv,
      annotationLayerDiv,
      annotationsContainer,
      renderTask: null,
      textLayerTask: null,
      textContent: '',
      searchHighlights: [],
      renderPromise: null
    };

    return pageView;
  }

  function rerenderPages() {
    if (!pdfDoc) {
      return;
    }

    pageViews.forEach(pageView => {
      if (pageView) {
        pageView.renderPromise = renderPageView(pageView);
      }
    });
    scheduleVirtualizationUpdate({ immediate: true });
  }

  function renderAnnotationsForAllPages() {
    pageViews.forEach(pageView => {
      if (pageView) {
        renderAnnotationsForPage(pageView);
      }
    });
  }

  function renderAnnotationsForPage(pageView) {
    if (!pageView) {
      return;
    }
    const container = pageView.annotationsContainer;
    if (!container) {
      return;
    }

    container.innerHTML = '';

    const annotations = annotationsByPage.get(pageView.pageNumber);
    const hasNotes = Boolean(annotations?.notes?.length);
    const hasQuotes = Boolean(annotations?.quotes?.length);

    if (!hasNotes && !hasQuotes) {
      container.hidden = true;
      container.setAttribute('aria-hidden', 'true');
      return;
    }

    container.hidden = false;
    container.setAttribute('aria-hidden', 'false');

    const fragment = document.createDocumentFragment();

    if (hasNotes) {
      fragment.appendChild(
        createAnnotationsSection(pageView.pageNumber, 'Notes', annotations.notes, 'notes')
      );
    }

    if (hasQuotes) {
      fragment.appendChild(
        createAnnotationsSection(pageView.pageNumber, 'Quotes', annotations.quotes, 'quotes')
      );
    }

    container.appendChild(fragment);
  }

  function createAnnotationsSection(pageNumber, title, entries, type) {
    const section = document.createElement('section');
    section.className = `pdf-annotations__section pdf-annotations__section--${type}`;

    const heading = document.createElement('h3');
    heading.className = 'pdf-annotations__heading';
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'pdf-annotations__list';

    entries.forEach(text => {
      const item = document.createElement('li');
      item.className = 'pdf-annotations__item';
      const content = typeof text === 'string' ? text.trim() : '';
      item.textContent = content;
      item.title = 'Right-click to edit or remove';
      registerAnnotationItemInteractions(item, {
        pageNumber,
        type,
        text: content
      });
      list.appendChild(item);
    });

    section.appendChild(list);
    return section;
  }

  function renderAnnotationSidebar() {
    if (
      !(annotationSidebar instanceof HTMLElement) ||
      !(annotationBookmarksList instanceof HTMLElement) ||
      !(annotationNotesList instanceof HTMLElement) ||
      !(annotationQuotesList instanceof HTMLElement) ||
      !(annotationBookmarksCount instanceof HTMLElement) ||
      !(annotationNotesCount instanceof HTMLElement) ||
      !(annotationQuotesCount instanceof HTMLElement) ||
      !(annotationBookmarksEmpty instanceof HTMLElement) ||
      !(annotationNotesEmpty instanceof HTMLElement) ||
      !(annotationQuotesEmpty instanceof HTMLElement)
    ) {
      return;
    }

    activeAnnotationSidebarEntries.forEach(element => {
      if (element?.classList) {
        element.classList.remove('is-active');
      }
    });
    activeAnnotationSidebarEntries.clear();
    annotationEntryElementsByPage.clear();

    const hasPdf = Boolean(pdfDoc);
    const collections = hasPdf ? buildAnnotationCollections() : buildEmptyAnnotationCollections();

    renderAnnotationSection(
      annotationBookmarksList,
      annotationBookmarksCount,
      annotationBookmarksEmpty,
      collections.bookmarks,
      'bookmark'
    );
    renderAnnotationSection(
      annotationNotesList,
      annotationNotesCount,
      annotationNotesEmpty,
      collections.notes,
      'note'
    );
    renderAnnotationSection(
      annotationQuotesList,
      annotationQuotesCount,
      annotationQuotesEmpty,
      collections.quotes,
      'quote'
    );

    const totalEntries =
      collections.bookmarks.length + collections.notes.length + collections.quotes.length;
    const hasAny = totalEntries > 0;

    if (!hasPdf) {
      annotationToggle.disabled = true;
      annotationToggle.setAttribute('aria-disabled', 'true');
      setAnnotationSidebarVisibility(false);
      return;
    }

    annotationToggle.disabled = false;
    annotationToggle.removeAttribute('aria-disabled');
    annotationSidebar.classList.toggle('annotation-sidebar--empty', !hasAny);

    if (!hasAny) {
      setAnnotationSidebarVisibility(false);
    }

    setActiveAnnotationEntries(currentPage);
  }

  function buildEmptyAnnotationCollections() {
    return { bookmarks: [], notes: [], quotes: [] };
  }

  function buildAnnotationCollections() {
    const bookmarks = Array.from(bookmarkedPages)
      .filter(page => Number.isFinite(page))
      .sort((a, b) => a - b)
      .map(pageNumber => ({
        pageNumber,
        type: 'bookmark',
        typeLabel: 'Bookmark',
        secondaryText: '',
        tooltip: `Go to page ${pageNumber}`,
        ariaLabel: `Bookmark on page ${pageNumber}`
      }));

    const notes = [];
    const quotes = [];

    const pages = Array.from(annotationsByPage.keys()).sort((a, b) => a - b);
    pages.forEach(pageNumber => {
      const record = annotationsByPage.get(pageNumber);
      if (!record) {
        return;
      }

      const appendEntry = (collection, value, typeLabel) => {
        const content = typeof value === 'string' ? value.trim() : '';
        if (!content) {
          return;
        }
        collection.push({
          pageNumber,
          type: typeLabel.toLowerCase(),
          typeLabel,
          secondaryText: content,
          tooltip: content,
          ariaLabel: `${typeLabel} on page ${pageNumber}: ${content}`
        });
      };

      if (Array.isArray(record.notes)) {
        record.notes.forEach(note => appendEntry(notes, note, 'Note'));
      }

      if (Array.isArray(record.quotes)) {
        record.quotes.forEach(quote => appendEntry(quotes, quote, 'Quote'));
      }
    });

    return { bookmarks, notes, quotes };
  }

  function renderAnnotationSection(listElement, countElement, emptyElement, entries, type) {
    if (!listElement) {
      return;
    }

    listElement.innerHTML = '';

    const items = Array.isArray(entries) ? entries : [];
    const itemCount = items.length;
    const hasEntries = itemCount > 0;

    if (countElement) {
      countElement.textContent = String(itemCount);
    }

    if (emptyElement) {
      emptyElement.hidden = hasEntries;
      emptyElement.setAttribute('aria-hidden', hasEntries ? 'true' : 'false');
    }

    listElement.hidden = !hasEntries;
    listElement.setAttribute('aria-hidden', hasEntries ? 'false' : 'true');

    if (!hasEntries) {
      return;
    }

    const fragment = document.createDocumentFragment();

    items.forEach(entry => {
      if (!entry || !Number.isFinite(entry.pageNumber)) {
        return;
      }

      const item = document.createElement('li');
      item.className = 'annotation-sidebar__item';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'annotation-sidebar__entry';
      button.dataset.page = String(entry.pageNumber);
      button.dataset.type = entry.type || type;
      button.title = entry.tooltip || `Go to page ${entry.pageNumber}`;
      const label = entry.ariaLabel || `${entry.typeLabel} on page ${entry.pageNumber}`;
      button.setAttribute('aria-label', label);

      button.addEventListener('click', event => {
        event.preventDefault();
        scrollToPage(entry.pageNumber);
      });

      registerAnnotationSidebarEntry(button, entry.pageNumber);

      if ((entry.type === 'note' || entry.type === 'quote') && entry.secondaryText) {
        registerAnnotationItemInteractions(button, {
          pageNumber: entry.pageNumber,
          type: entry.type === 'note' ? 'notes' : 'quotes',
          text: entry.secondaryText
        });
      } else {
        button.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          showContextMenu(event, entry.pageNumber);
        });
      }

      const meta = document.createElement('div');
      meta.className = 'annotation-sidebar__entry-meta';

      const pageSpan = document.createElement('span');
      pageSpan.className = 'annotation-sidebar__entry-page';
      pageSpan.textContent = `Page ${entry.pageNumber}`;
      meta.appendChild(pageSpan);

      const typeSpan = document.createElement('span');
      typeSpan.className = 'annotation-sidebar__entry-type';
      typeSpan.textContent = entry.typeLabel || type;
      meta.appendChild(typeSpan);

      button.appendChild(meta);

      if (entry.secondaryText) {
        const textSpan = document.createElement('span');
        textSpan.className = 'annotation-sidebar__entry-text';
        textSpan.textContent = entry.secondaryText;
        button.appendChild(textSpan);
      }

      item.appendChild(button);
      fragment.appendChild(item);
    });

    listElement.appendChild(fragment);
  }

  function registerAnnotationSidebarEntry(element, pageNumber) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    const normalized = normalizePageNumber(pageNumber);
    if (normalized === null) {
      return;
    }

    let bucket = annotationEntryElementsByPage.get(normalized);
    if (!bucket) {
      bucket = new Set();
      annotationEntryElementsByPage.set(normalized, bucket);
    }

    bucket.add(element);
  }

  function registerAnnotationItemInteractions(element, metadata) {
    const { pageNumber, type, text } = metadata;
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.dataset.annotationType = type;
    element.dataset.pageNumber = String(pageNumber);
    element.dataset.annotationText = text;

    element.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!contextMenu) {
        return;
      }

      storedSelectionText = text;
      updateContextMenuForAnnotation(type);
      showContextMenu(event, pageNumber, { annotationText: text, annotationType: type });
    });
  }

  async function renderLinkAnnotations(pageView, annotations, viewport) {
    const container = pageView.annotationLayerDiv;
    if (!container) {
      return;
    }

    container.innerHTML = '';

    const activeIds = new Set();
    if (!Array.isArray(annotations) || annotations.length === 0) {
      cleanupAnnotationDestinations(pageView.pageNumber, activeIds);
      return;
    }

    const tasks = [];

    annotations.forEach(annotation => {
      if (!annotation || annotation.subtype !== 'Link') {
        return;
      }

      if (!annotation.rect || !viewport?.convertToViewportRectangle) {
        return;
      }

      const rectangle = viewport.convertToViewportRectangle(annotation.rect);
      if (!Array.isArray(rectangle) || rectangle.length !== 4) {
        return;
      }

      const [x1, y1, x2, y2] = rectangle;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x1 - x2) || 16;
      const height = Math.abs(y1 - y2) || 16;

      const annotationId = annotation.id ? String(annotation.id) : `${pageView.pageNumber}-${activeIds.size}`;
      activeIds.add(annotationId);

      const overlay = document.createElement('button');
      overlay.type = 'button';
      overlay.className = 'pdf-link-annotation';
      overlay.style.left = `${left}px`;
      overlay.style.top = `${top}px`;
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;
      overlay.dataset.annotationId = annotationId;
      overlay.dataset.pageNumber = String(pageView.pageNumber);

      const classification = linkAnnotationHelpers?.classifyLinkAnnotation
        ? linkAnnotationHelpers.classifyLinkAnnotation(annotation)
        : null;
      const label = (classification?.label || annotation.title || annotation.contents || '').trim();
      if (label) {
        overlay.textContent = label;
        overlay.setAttribute('aria-label', label);
        overlay.title = label;
      } else if (annotation.url) {
        overlay.setAttribute('aria-label', annotation.url);
        overlay.title = annotation.url;
      } else {
        overlay.setAttribute('aria-label', 'Document link');
      }

      if (classification?.footnoteId) {
        overlay.dataset.footnoteId = classification.footnoteId;
      }

      if (annotation.url) {
        overlay.dataset.uri = annotation.url;
      }

      overlay.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        handleAnnotationActivation(overlay);
      });
      overlay.addEventListener('mouseenter', () => handleFootnoteHover(overlay, true));
      overlay.addEventListener('mouseleave', () => handleFootnoteHover(overlay, false));
      overlay.addEventListener('focus', () => handleFootnoteHover(overlay, true));
      overlay.addEventListener('blur', () => handleFootnoteHover(overlay, false));

      container.appendChild(overlay);

      const metadataPromise = resolveAnnotationDestination(annotation)
        .then(async destination => {
          if (!destination) {
            return;
          }

          annotationDestinations.set(annotationId, {
            ...destination,
            sourcePage: pageView.pageNumber
          });

          overlay.dataset.destPage = String(destination.pageNumber);

          if (typeof destination.zoom === 'number' && Number.isFinite(destination.zoom)) {
            overlay.dataset.destZoom = String(destination.zoom);
          }

          if (
            classification &&
            linkAnnotationHelpers?.TARGET_KINDS &&
            classification.kind === linkAnnotationHelpers.TARGET_KINDS.FOOTNOTE
          ) {
            const tooltipText = await extractFootnoteTooltip(destination);
            if (tooltipText) {
              overlay.title = tooltipText;
            }
          }
        })
        .catch(error => {
          console.error('Failed to resolve annotation destination', error);
        });

      tasks.push(metadataPromise);
    });

    cleanupAnnotationDestinations(pageView.pageNumber, activeIds);

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  async function renderPageView(pageView) {
    if (!pdfDoc) {
      return;
    }

    try {
      if (pageView.renderTask) {
        pageView.renderTask.cancel();
      }
      if (pageView.textLayerTask?.cancel) {
        pageView.textLayerTask.cancel();
      }

      const page = await pdfDoc.getPage(pageView.pageNumber);
      const viewport = page.getViewport({ scale: currentZoom });
      pageView.viewport = viewport;
      const outputScale = window.devicePixelRatio || 1;
      const canvas = pageView.canvas;
      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('Unable to acquire canvas rendering context');
      }

      const scaledWidth = Math.floor(viewport.width * outputScale);
      const scaledHeight = Math.floor(viewport.height * outputScale);

      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageView.surface.style.width = `${viewport.width}px`;
      pageView.surface.style.height = `${viewport.height}px`;
      const baseHeight = viewport.height / currentZoom;
      updateSlotHeight(pageView.pageNumber, viewport.height, { baseHeight });

      context.setTransform(1, 0, 0, 1, 0, 0);

      const renderContext = {
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
      };

      pageView.renderTask = page.render(renderContext);

      pageView.searchHighlights = [];
      pageView.textLayerDiv.innerHTML = '';
      pageView.textLayerDiv.style.width = `${viewport.width}px`;
      pageView.textLayerDiv.style.height = `${viewport.height}px`;
      if (pageView.annotationLayerDiv) {
        pageView.annotationLayerDiv.innerHTML = '';
        pageView.annotationLayerDiv.style.width = `${viewport.width}px`;
        pageView.annotationLayerDiv.style.height = `${viewport.height}px`;
      }

      const renderPromise = pageView.renderTask.promise;
      const annotationsPromise = page.getAnnotations({ intent: 'display' });
      const textContentPromise = page.getTextContent().then(textContent => {
        pageView.textContent = extractTextFromTextContent(textContent);
        pageTextContent.set(pageView.pageNumber, pageView.textContent);
        return textContent;
      });

      let textLayerPromise = textContentPromise.then(() => {});

      if (supportsTextLayer) {
        textLayerPromise = textContentPromise.then(textContent => {
          const task = window.pdfjsLib.renderTextLayer({
            textContent,
            container: pageView.textLayerDiv,
            viewport,
            textDivs: []
          });
          pageView.textLayerTask = task;
          const taskPromise = task.promise || task;
          return Promise.resolve(taskPromise).then(() => {
            if (pageView.textLayerDiv) {
              const renderedText = pageView.textLayerDiv.innerText.trim();
              if (renderedText) {
                pageView.textContent = renderedText;
                pageTextContent.set(pageView.pageNumber, renderedText);
              }
            }
          });
        });
      }

      const annotationPromise = annotationsPromise
        .then(annotations => renderLinkAnnotations(pageView, annotations, viewport))
        .catch(error => {
          console.error('Failed to render annotations for page', pageView.pageNumber, error);
        });

      await Promise.all([renderPromise, textLayerPromise, annotationPromise]);

      if (pageView.annotationLayerDiv) {
        await renderLinkAnnotations(pageView, page, viewport);
      }

      const activeKey = getActiveMatchKey();
      await updateMatchesForPage(pageView.pageNumber, { preferTextLayer: true });
      applySearchHighlightsForPage(pageView, { suppressRefresh: true });
      refreshGlobalMatches(activeKey);
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }
      showError(String(error));
    } finally {
      pageView.renderPromise = null;
    }
  }

  async function renderLinkAnnotations(pageView, page, viewport) {
    if (!pageView?.annotationLayerDiv) {
      return;
    }

    try {
      const annotations = await page.getAnnotations({ intent: 'display' });
      const container = pageView.annotationLayerDiv;
      container.innerHTML = '';

      annotations.forEach(annotation => {
        if (!annotation || annotation.subtype !== 'Link') {
          return;
        }

        const dest = annotation.dest ?? annotation.action ?? null;
        const url = typeof annotation.url === 'string' ? annotation.url : null;
        const rect = Array.isArray(annotation.rect) ? annotation.rect : null;
        if (!rect) {
          return;
        }

        const normalized = window.pdfjsLib?.Util?.normalizeRect
          ? window.pdfjsLib.Util.normalizeRect(rect)
          : rect;
        const [x1, y1, x2, y2] = normalized;
        const [left, top, right, bottom] = viewport.convertToViewportRectangle([x1, y1, x2, y2]);
        const width = Math.abs(right - left);
        const height = Math.abs(bottom - top);

        const link = document.createElement('a');
        link.className = 'pdf-link-annotation';
        link.style.left = `${Math.min(left, right)}px`;
        link.style.top = `${Math.min(top, bottom)}px`;
        link.style.width = `${Math.max(0, width)}px`;
        link.style.height = `${Math.max(0, height)}px`;

        if (dest) {
          link.href = '#';
          link.addEventListener('click', event => {
            event.preventDefault();
            navigateToDestination(dest);
          });
        } else if (url) {
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        } else {
          return;
        }

        container.appendChild(link);
      });
    } catch (error) {
      console.error('Failed to render link annotations', error);
    }
  }

  function handleAnnotationActivation(overlay) {
    if (!overlay) {
      return;
    }

    const uri = overlay.dataset?.uri;
    if (uri) {
      vscode.postMessage({ type: 'openExternal', url: uri });
      return;
    }

    const annotationId = overlay.dataset?.annotationId;
    if (!annotationId) {
      return;
    }

    const destination = annotationDestinations.get(annotationId);
    if (!destination) {
      return;
    }

    let delay = 0;
    if (typeof destination.zoom === 'number' && Number.isFinite(destination.zoom)) {
      if (Math.abs(destination.zoom - currentZoom) > 0.001) {
        setZoomLevel(destination.zoom);
        delay = 140;
      }
    }

    window.setTimeout(() => {
      scrollToDestination(destination);
    }, delay);
  }

  function handleFootnoteHover(overlay, isActive) {
    const footnoteId = overlay?.dataset?.footnoteId;
    if (!footnoteId) {
      return;
    }

    const escapedId = escapeCssIdentifier(footnoteId);
    const selector = `.pdf-link-annotation[data-footnote-id="${escapedId}"]`;
    const matching = document.querySelectorAll(selector);
    matching.forEach(element => {
      if (isActive) {
        element.classList.add('is-highlighted');
      } else {
        element.classList.remove('is-highlighted');
      }
    });
  }

  function cleanupAnnotationDestinations(pageNumber, activeIds) {
    for (const [annotationId, info] of annotationDestinations.entries()) {
      if (info?.sourcePage === pageNumber && !activeIds.has(annotationId)) {
        annotationDestinations.delete(annotationId);
      }
    }
  }

  async function resolveAnnotationDestination(annotation) {
    if (!pdfDoc || !annotation || annotation.url) {
      return null;
    }

    let destination = annotation.dest ?? annotation.destName ?? annotation.destination;
    let explicit = null;

    try {
      if (typeof destination === 'string' && destination) {
        explicit = await pdfDoc.getDestination(destination);
      } else if (Array.isArray(destination)) {
        explicit = destination;
      } else if (destination && typeof destination === 'object' && 'name' in destination) {
        const name = destination.name;
        if (typeof name === 'string') {
          explicit = await pdfDoc.getDestination(name);
        }
      } else if (typeof annotation.destName === 'string' && annotation.destName) {
        explicit = await pdfDoc.getDestination(annotation.destName);
      }
    } catch (error) {
      console.error('Failed to resolve PDF destination', error);
      return null;
    }

    if (!explicit) {
      return null;
    }

    const [ref, mode, left, top, zoom] = explicit;
    let pageIndex = null;

    if (typeof ref === 'object' && ref !== null) {
      try {
        pageIndex = await pdfDoc.getPageIndex(ref);
      } catch (error) {
        console.error('Failed to resolve destination page index', error);
        return null;
      }
    } else if (typeof ref === 'number' && Number.isFinite(ref)) {
      if (ref >= 1 && ref <= pdfDoc.numPages) {
        pageIndex = ref - 1;
      } else if (ref >= 0 && ref < pdfDoc.numPages) {
        pageIndex = ref;
      }
    }

    if (pageIndex === null || !Number.isFinite(pageIndex)) {
      return null;
    }

    const resolved = {
      pageNumber: pageIndex + 1,
      mode: typeof mode === 'string' ? mode : null,
      left: typeof left === 'number' ? left : null,
      top: typeof top === 'number' ? top : null,
      zoom: typeof zoom === 'number' && zoom > 0 ? zoom : null,
      destArray: explicit
    };

    return resolved;
  }

  async function extractFootnoteTooltip(destination) {
    if (!destination || typeof destination.top !== 'number' || !pdfDoc) {
      return '';
    }

    const cacheKey = `${destination.pageNumber}:${destination.left ?? ''}:${destination.top}`;
    if (footnoteTooltipCache.has(cacheKey)) {
      return footnoteTooltipCache.get(cacheKey);
    }

    try {
      const page = await pdfDoc.getPage(destination.pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = Array.isArray(textContent?.items) ? textContent.items : [];
      if (items.length === 0) {
        footnoteTooltipCache.set(cacheKey, '');
        return '';
      }

      const point = viewport.convertToViewportPoint(destination.left ?? 0, destination.top);
      const targetY = point[1];
      const lines = new Map();

      items.forEach(item => {
        if (!item || typeof item.str !== 'string' || !item.transform) {
          return;
        }
        const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const lineKey = Math.round(vy);
        let line = lines.get(lineKey);
        if (!line) {
          line = [];
          lines.set(lineKey, line);
        }
        line.push({ x: vx, text: item.str });
      });

      if (lines.size === 0) {
        footnoteTooltipCache.set(cacheKey, '');
        return '';
      }

      let chosenKey = null;
      let minDelta = Number.POSITIVE_INFINITY;
      lines.forEach((_, key) => {
        const delta = Math.abs(key - targetY);
        if (delta < minDelta) {
          minDelta = delta;
          chosenKey = key;
        }
      });

      if (chosenKey === null) {
        for (const key of lines.keys()) {
          if (chosenKey === null || key < chosenKey) {
            chosenKey = key;
          }
        }
      }

      const lineItems = lines.get(chosenKey) ?? [];
      lineItems.sort((a, b) => a.x - b.x);
      const text = lineItems
        .map(item => item.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();

      footnoteTooltipCache.set(cacheKey, text);
      return text;
    } catch (error) {
      console.error('Failed to extract footnote tooltip', error);
      footnoteTooltipCache.set(cacheKey, '');
      return '';
    }
  }

  function scrollToDestination(destination) {
    if (!destination) {
      return;
    }

    const targetView = pageViews.find(view => view.pageNumber === destination.pageNumber);
    if (!targetView) {
      return;
    }

    const wrapper = targetView.wrapper;
    if (!wrapper) {
      return;
    }

    let targetTop = wrapper.offsetTop;

    if (targetView.viewport && typeof destination.left === 'number' && typeof destination.top === 'number') {
      const [_, vy] = targetView.viewport.convertToViewportPoint(destination.left, destination.top);
      targetTop += vy;
    }

    main.scrollTo({ top: Math.max(0, targetTop - 48), behavior: 'smooth' });
    updatePageIndicator(destination.pageNumber, { lock: true });
  }

  async function scrollToPage(pageNumber, options = {}) {
    if (!pdfDoc) {
      return;
    }

    const normalized = normalizePageNumber(pageNumber);
    if (normalized === null) {
      return;
    }

    try {
      await ensureAccuratePageSlotHeights(normalized);
      await ensurePageViewMaterialized(normalized);
      scheduleVirtualizationUpdate({ immediate: true });

      const slotRecord = getSlotRecord(normalized);
      slotRecord?.element?.scrollIntoView({
        behavior: 'smooth',
        block: typeof options.block === 'string' ? options.block : 'start'
      });
      updatePageIndicator(normalized, { lock: true });
    } catch (error) {
      console.error('Failed to scroll to page', error);
    }
  }

  function changePage(delta) {
    if (!pdfDoc) {
      return;
    }

    const target = currentPage + delta;
    if (target < 1 || target > pdfDoc.numPages) {
      return;
    }

    ensurePageView(target);
    const slotRecord = getSlotRecord(target);
    const pageElement = slotRecord?.element;
    if (pageElement) {
      pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updatePageIndicator(target, { lock: true });
      scheduleVirtualizationUpdate();
    }
  }

  async function navigateToDestination(dest) {
    if (!pdfDoc || !dest) {
      return;
    }

    try {
      const pageNumber = await resolveDestinationToPage(dest);
      if (!pageNumber) {
        return;
      }

      await ensureAccuratePageSlotHeights(pageNumber);
      await ensurePageViewMaterialized(pageNumber);
      scheduleVirtualizationUpdate({ immediate: true });

      const slotRecord = getSlotRecord(pageNumber);
      slotRecord?.element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updatePageIndicator(pageNumber, { lock: true });
    } catch (error) {
      console.error('Failed to navigate to destination', error);
    }
  }

  async function resolveDestinationToPage(dest) {
    const destArray = await resolveDestinationArray(dest);
    if (!destArray || !destArray.length) {
      return null;
    }

    const ref = destArray[0];
    if (typeof ref === 'object' && ref !== null) {
      return (await pdfDoc.getPageIndex(ref)) + 1;
    }
    if (Number.isFinite(ref)) {
      return Number(ref) + 1;
    }
    return null;
  }

  async function resolveDestinationArray(dest) {
    if (!pdfDoc || !dest) {
      return null;
    }

    let explicitDest = dest;
    if (typeof explicitDest === 'string') {
      try {
        const resolved = await pdfDoc.getDestination(explicitDest);
        if (resolved) {
          explicitDest = resolved;
        }
      } catch (error) {
        console.error('Failed to resolve destination', error);
        return null;
      }
    }

    return Array.isArray(explicitDest) ? explicitDest : null;
  }

  function setTheme(theme) {
    if (!theme) {
      return;
    }

    document.body.setAttribute('data-theme', theme);
    themeButtons.forEach(button => {
      if (button.getAttribute('data-theme') === theme) {
        button.classList.add('active');
      } else {
        button.classList.remove('active');
      }
    });
  }

  function setBookmarkStyle(style) {
    if (typeof style !== 'string' || style.length === 0) {
      return;
    }

    document.body.setAttribute('data-bookmark-style', style);
  }

  function syncPageJumpInput(pageNumber) {
    if (!(pageJumpInput instanceof HTMLInputElement)) {
      return;
    }

    const value = String(pageNumber);
    if (pageJumpInput.value !== value) {
      pageJumpInput.value = value;
    }
  }

  function updatePageJumpBounds(totalPages) {
    if (!(pageJumpInput instanceof HTMLInputElement)) {
      return;
    }

    if (Number.isFinite(totalPages) && totalPages > 0) {
      pageJumpInput.max = String(Math.trunc(totalPages));
    } else {
      pageJumpInput.removeAttribute('max');
    }
  }

  function setPageJumpInputEnabled(enabled) {
    if (!(pageJumpInput instanceof HTMLInputElement)) {
      return;
    }

    pageJumpInput.disabled = !enabled;
    if (enabled) {
      pageJumpInput.removeAttribute('aria-disabled');
    } else {
      pageJumpInput.setAttribute('aria-disabled', 'true');
    }
  }

  function clearPageJumpFeedback() {
    if (pageJumpFeedbackTimer) {
      window.clearTimeout(pageJumpFeedbackTimer);
      pageJumpFeedbackTimer = 0;
    }

    if (pageJumpFeedback instanceof HTMLElement) {
      pageJumpFeedback.textContent = '';
      pageJumpFeedback.classList.remove('is-visible');
      pageJumpFeedback.setAttribute('aria-hidden', 'true');
    }

    if (pageJumpInput instanceof HTMLInputElement) {
      pageJumpInput.classList.remove('toolbar__page-jump-input--error');
    }
  }

  function showPageJumpFeedback(message, options) {
    if (!(pageJumpFeedback instanceof HTMLElement) || !(pageJumpInput instanceof HTMLInputElement)) {
      return;
    }

    if (pageJumpFeedbackTimer) {
      window.clearTimeout(pageJumpFeedbackTimer);
      pageJumpFeedbackTimer = 0;
    }

    const config = typeof options === 'object' && options !== null ? options : {};

    if (!message) {
      clearPageJumpFeedback();
      return;
    }

    pageJumpFeedback.textContent = message;
    pageJumpFeedback.classList.add('is-visible');
    pageJumpFeedback.setAttribute('aria-hidden', 'false');

    if (config.type === 'error') {
      pageJumpInput.classList.add('toolbar__page-jump-input--error');
    } else {
      pageJumpInput.classList.remove('toolbar__page-jump-input--error');
    }

    const parsedDuration = Number(config.duration);
    const duration = Number.isFinite(parsedDuration) ? parsedDuration : 2200;
    pageJumpFeedbackTimer = window.setTimeout(() => {
      clearPageJumpFeedback();
    }, duration);
  }

  async function handlePageJumpSubmission(rawValue) {
    if (!pdfDoc) {
      return;
    }

    const totalPages = pdfDoc.numPages;
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';

    if (!value) {
      syncPageJumpInput(currentPage);
      showPageJumpFeedback(`Enter a page number between 1 and ${totalPages}.`, { type: 'error' });
      return;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      syncPageJumpInput(currentPage);
      showPageJumpFeedback(`Enter a page number between 1 and ${totalPages}.`, { type: 'error' });
      return;
    }

    const clamped = Math.min(Math.max(parsed, 1), totalPages);
    if (clamped !== parsed) {
      showPageJumpFeedback(`Page must be between 1 and ${totalPages}.`, { type: 'error' });
    } else {
      clearPageJumpFeedback();
    }

    syncPageJumpInput(clamped);

    if (clamped === currentPage) {
      return;
    }

    await scrollToPage(clamped, { block: 'start' });
  }

  function updatePageIndicator(pageNumber, options = {}) {
    const normalized = normalizePageNumber(pageNumber);
    if (normalized === null) {
      return;
    }

    currentPage = normalized;
    pageNumberEl.textContent = normalized.toString();
    syncPageJumpInput(normalized);
    if (pageJumpInput instanceof HTMLInputElement) {
      pageJumpInput.classList.remove('toolbar__page-jump-input--error');
    }
    updateBookmarkButtonState();
    setActiveOutlineEntry(normalized);
    setActiveAnnotationEntries(normalized);

    const lock = typeof options === 'object' && options !== null && Boolean(options.lock);
    const lockDuration =
      typeof options.lockDuration === 'number' && options.lockDuration >= 0
        ? options.lockDuration
        : PAGE_LOCK_DURATION;

    if (lock) {
      lockPageIndicator(normalized, lockDuration);
    }
  }

  function adjustZoom(delta) {
    if (!Number.isFinite(delta)) {
      return;
    }

    const next = currentZoom + delta;
    setZoomLevel(next);
  }

  function setZoomLevel(scale, options = {}) {
    if (!Number.isFinite(scale) || scale <= 0) {
      return;
    }

    const clamped = Math.max(MIN_ZOOM, Math.min(scale, MAX_ZOOM));
    currentZoom = clamped;

    const sliderValue = Math.round(clamped * 100);
    if (zoomRange.value !== String(sliderValue)) {
      zoomRange.value = String(sliderValue);
    }

    updateZoomDisplay();
    updateZoomButtons();
    updateStoredSlotHeightsForZoom();

    if (!options.suppressRender) {
      rerenderPages();
    }
  }

  function updateZoomDisplay() {
    zoomValue.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  function updateZoomButtons() {
    const minReached = currentZoom <= MIN_ZOOM + 0.0001;
    const maxReached = currentZoom >= MAX_ZOOM - 0.0001;
    zoomOutButton.disabled = minReached;
    zoomInButton.disabled = maxReached;
  }

  updateZoomDisplay();
  updateZoomButtons();

  function showContextMenu(mouseEvent, pageNumber, options = {}) {
    if (!contextMenu) {
      return;
    }

    const { annotationText = '', annotationType = null } = options;

    if (annotationType) {
      updateContextMenuForAnnotation(annotationType);
      contextMenu.dataset.mode = 'annotation';
      contextMenu.dataset.annotationType = annotationType;
    } else {
      updateContextMenuForPage(pageNumber);
      contextMenu.dataset.mode = 'page';
      delete contextMenu.dataset.annotationType;
    }

    const { clientX, clientY } = mouseEvent;
    const selection = (window.getSelection()?.toString() ?? '').trim();
    storedSelectionText = contextMenuMode === 'annotation' ? annotationText || selection : selection;
    contextMenuPage = pageNumber;
    contextMenu.dataset.page = String(pageNumber);
    const datasetSelection =
      contextMenuMode === 'annotation'
        ? annotationText || selection
        : selection;
    contextMenu.dataset.selection = datasetSelection;
    contextMenu.hidden = false;
    contextMenu.setAttribute('aria-hidden', 'false');
    contextMenu.classList.add('is-visible');
    contextMenu.style.visibility = 'hidden';
    contextMenu.style.left = '0px';
    contextMenu.style.top = '0px';

    const rect = contextMenu.getBoundingClientRect();
    const padding = 8;
    let left = clientX;
    let top = clientY;

    if (left + rect.width + padding > window.innerWidth) {
      left = window.innerWidth - rect.width - padding;
    }
    if (top + rect.height + padding > window.innerHeight) {
      top = window.innerHeight - rect.height - padding;
    }

    left = Math.max(padding, left);
    top = Math.max(padding, top);

    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    contextMenu.style.visibility = 'visible';
    isContextMenuOpen = true;

    const firstButton = contextMenu.querySelector('button[data-command]:not([hidden])');
    if (firstButton instanceof HTMLElement) {
      firstButton.focus({ preventScroll: true });
    }
  }

  function hideContextMenu() {
    if (!contextMenu) {
      return;
    }

    contextMenu.classList.remove('is-visible');
    contextMenu.setAttribute('aria-hidden', 'true');
    contextMenu.hidden = true;
    delete contextMenu.dataset.page;
    delete contextMenu.dataset.selection;
    delete contextMenu.dataset.mode;
    delete contextMenu.dataset.annotationType;
    contextMenuPage = null;
    storedSelectionText = '';
    isContextMenuOpen = false;
    contextMenuMode = 'page';
  }

  async function copyPageText(pageNumber) {
    if (!pdfDoc || !Number.isFinite(pageNumber)) {
      return;
    }

    const pageView = getPageView(pageNumber);
    let text = pageView?.textLayerDiv?.innerText?.trim() ?? pageView?.textContent?.trim() ?? '';
    if (!text) {
      text = pageTextContent.get(pageNumber) ?? '';
    }

    if (!text) {
      try {
        text = await ensureTextContentForPage(pageNumber);
        if (pageView) {
          pageView.textContent = text;
        }
      } catch (error) {
        console.error('Failed to read text for page', error);
        return;
      }
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    try {
      await writeTextToClipboard(trimmedText);
    } catch (error) {
      console.error('Failed to write page text to clipboard', error);
    }
  }

  async function writeTextToClipboard(text) {
    if (!text) {
      return;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function escapeCssIdentifier(value) {
    const text = String(value ?? '');
    if (window.CSS?.escape) {
      return window.CSS.escape(text);
    }
    return text.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`);
  }

  function extractTextFromTextContent(textContent) {
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    if (!items.length) {
      return '';
    }

    const lines = [];
    let currentLine = '';

    items.forEach(item => {
      if (!item || typeof item.str !== 'string') {
        return;
      }

      currentLine += item.str;

      if (item.hasEOL) {
        lines.push(currentLine.trimEnd());
        currentLine = '';
      }
    });

    if (currentLine.trim().length) {
      lines.push(currentLine.trimEnd());
    }

    return lines.join('\n').replace(/\u00A0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  function setStatus(message) {
    setBookmarkButtonEnabled(false);
    updateBookmarkButtonState();
    setPageJumpInputEnabled(false);
    updatePageJumpBounds(null);
    syncPageJumpInput(1);
    clearPageJumpFeedback();
    pdfContainer.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = message;
    pdfContainer.appendChild(placeholder);
  }

  function showError(message) {
    setBookmarkButtonEnabled(false);
    updateBookmarkButtonState();
    setPageJumpInputEnabled(false);
    updatePageJumpBounds(null);
    syncPageJumpInput(1);
    clearPageJumpFeedback();
    pdfContainer.innerHTML = '';
    const errorBox = document.createElement('div');
    errorBox.className = 'error';
    errorBox.textContent = message;
    pdfContainer.appendChild(errorBox);
  }

  async function ensureAccuratePageSlotHeights(targetPageNumber) {
    if (!pdfDoc || !Number.isFinite(targetPageNumber)) {
      return;
    }

    const clamped = Math.max(1, Math.min(Math.floor(targetPageNumber), pdfDoc.numPages));
    const tasks = [];

    for (let pageNumber = 1; pageNumber <= clamped; pageNumber++) {
      if (pageBaseViewportHeights.has(pageNumber)) {
        continue;
      }

      let promise = pendingPageHeightMeasurements.get(pageNumber);
      if (!promise) {
        promise = measurePageHeight(pageNumber);
        pendingPageHeightMeasurements.set(pageNumber, promise);
      }

      tasks.push(promise);

      if (tasks.length >= 4) {
        await Promise.allSettled(tasks);
        tasks.length = 0;
      }
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  async function measurePageHeight(pageNumber) {
    const activePdfDoc = pdfDoc;
    if (!activePdfDoc) {
      pendingPageHeightMeasurements.delete(pageNumber);
      return null;
    }

    try {
      const page = await activePdfDoc.getPage(pageNumber);
      if (activePdfDoc !== pdfDoc) {
        if (typeof page.cleanup === 'function') {
          try {
            page.cleanup();
          } catch (cleanupError) {
            console.error('Failed to clean up page after document change', cleanupError);
          }
        }
        return null;
      }

      const viewport = page.getViewport({ scale: 1 });
      const baseHeight = viewport?.height;

      if (Number.isFinite(baseHeight) && baseHeight > 0) {
        pageBaseViewportHeights.set(pageNumber, baseHeight);
        updateSlotHeight(pageNumber, baseHeight * currentZoom, { baseHeight });
      }

      if (typeof page.cleanup === 'function') {
        try {
          page.cleanup();
        } catch (cleanupError) {
          console.error('Failed to clean up page resources', cleanupError);
        }
      }

      return baseHeight ?? null;
    } catch (error) {
      if (pdfDoc === activePdfDoc) {
        console.error('Failed to measure page height', error);
      }
      return null;
    } finally {
      pendingPageHeightMeasurements.delete(pageNumber);
    }
  }

  function updateStoredSlotHeightsForZoom() {
    if (!pdfDoc) {
      return;
    }

    pageBaseViewportHeights.forEach((baseHeight, pageNumber) => {
      if (!Number.isFinite(baseHeight) || baseHeight <= 0) {
        return;
      }
      updateSlotHeight(pageNumber, baseHeight * currentZoom, { baseHeight });
    });
  }

  vscode.postMessage({ type: 'ready' });

  setBookmarkStyle(document.body.getAttribute('data-bookmark-style') || 'pulse');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
