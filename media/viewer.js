(function () {
  const vscode = acquireVsCodeApi();
  const main = document.getElementById('viewerViewport');
  const pdfContainer = document.getElementById('pdfContainer');
  const zoomRange = document.getElementById('zoomRange');
  const zoomValue = document.getElementById('zoomValue');
  const pageNumberEl = document.getElementById('pageNumber');
  const pageCountEl = document.getElementById('pageCount');
  const toolbar = document.querySelector('.toolbar');
  const contextMenu = document.getElementById('contextMenu');
  const contextMenuButtons = contextMenu
    ? Array.from(contextMenu.querySelectorAll('button[data-command]'))
    : [];
  const searchInput = document.getElementById('searchInput');
  const searchPrevButton = document.getElementById('searchPrev');
  const searchNextButton = document.getElementById('searchNext');
  const searchClearButton = document.getElementById('searchClear');
  const searchMatches = document.getElementById('searchMatches');
  const outlinePanel = document.getElementById('outlinePanel');
  const outlineToggle = document.getElementById('outlineToggle');
  const outlineList = document.getElementById('outlineList');

  if (
    !main ||
    !pdfContainer ||
    !zoomRange ||
    !zoomValue ||
    !pageNumberEl ||
    !pageCountEl ||
    !toolbar ||
    !(searchInput instanceof HTMLInputElement) ||
    !(searchPrevButton instanceof HTMLButtonElement) ||
    !(searchNextButton instanceof HTMLButtonElement) ||
    !(searchClearButton instanceof HTMLButtonElement) ||
    !(searchMatches instanceof HTMLElement) ||
    !(outlinePanel instanceof HTMLElement) ||
    !(outlineToggle instanceof HTMLButtonElement) ||
    !(outlineList instanceof HTMLElement)
  ) {
    vscode.postMessage({ type: 'ready' });
    throw new Error('Viewer failed to initialize');
  }

  const themeButtons = toolbar.querySelectorAll('button[data-theme]');
  const navigationButtons = toolbar.querySelectorAll('button[data-action]');
  const bookmarkButton = toolbar.querySelector('#bookmarkToggle');
  const bookmarkIcon = bookmarkButton?.querySelector('.toolbar__bookmark-icon');

  let pdfDoc = null;
  let currentPage = 1;
  let currentZoom = 1.0;
  let intersectionObserver = null;
  const pageViews = [];
  const pageTextContent = new Map();
  const searchMatchesByPage = new Map();
  const outlineElementsByPage = new Map();
  const activeOutlineElements = new Set();
  const virtualizationState = {
    slots: new Map(),
    bufferPages: 3,
    estimatedPageHeight: 960,
    pendingAnimationFrame: 0,
    lastRange: { start: 0, end: 0 }
  };
  const annotationsByPage = new Map();
  let contextMenuPage = null;
  let storedSelectionText = '';
  let isContextMenuOpen = false;
  const bookmarkedPages = new Set();
  const SEARCH_DEBOUNCE_MS = 200;
  let searchDebounceHandle = null;
  const searchState = {
    query: '',
    matches: [],
    activeIndex: -1
  };
  const sharedHelpers = window.ViewerShared || {};
  const normalizeOutline =
    typeof sharedHelpers.normalizeOutline === 'function' ? sharedHelpers.normalizeOutline : () => [];
  const computeVirtualPageWindow =
    typeof sharedHelpers.computeVirtualPageWindow === 'function'
      ? sharedHelpers.computeVirtualPageWindow
      : () => ({ start: 1, end: 1 });

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  const supportsTextLayer = Boolean(window.pdfjsLib?.renderTextLayer);

  setBookmarkButtonEnabled(false);
  updateBookmarkButtonState();
  setupSearchControls();
  outlineToggle.addEventListener('click', () => {
    toggleOutlinePanel();
  });
  main.addEventListener('scroll', () => {
    scheduleVirtualizationUpdate();
  });
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

  themeButtons.forEach(button => {
    button.addEventListener('click', () => {
      const theme = button.getAttribute('data-theme');
      setTheme(theme);
      vscode.postMessage({ type: 'requestThemeChange', theme });
    });
  });

  zoomRange.addEventListener('input', () => {
    currentZoom = parseInt(zoomRange.value, 10) / 100;
    updateZoomDisplay();
    rerenderPages();
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

  function refreshAnnotationState(data) {
    annotationsByPage.clear();

    if (!data || typeof data !== 'object') {
      setBookmarkedPages([]);
      renderAnnotationsForAllPages();
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

  function updateSlotHeight(pageNumber, viewportHeight) {
    const slotRecord = getSlotRecord(pageNumber);
    if (!slotRecord) {
      return;
    }

    const paddedHeight = Math.max(12, Math.round(viewportHeight + 48));
    slotRecord.height = paddedHeight;
    slotRecord.element.style.minHeight = `${paddedHeight}px`;
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
      outlinePanel.setAttribute('aria-hidden', outlineToggle.disabled ? 'true' : 'false');
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
    setBookmarkButtonEnabled(false);
    setBookmarkedPages([]);
    clearSearchStateBeforeDocumentChange();
    clearOutlineSidebar();
    resetVirtualizationState();
    pageTextContent.clear();
    searchMatchesByPage.clear();

    try {
      if (!window.pdfjsLib) {
        showError('PDF viewer failed to load. Please reload the editor.');
        return;
      }

      setStatus('Loading PDF…');
      hideContextMenu();
      const pdfData = decodeBase64(data);
      pdfDoc = await window.pdfjsLib.getDocument({ data: pdfData }).promise;

      pageCountEl.textContent = pdfDoc.numPages.toString();
      currentPage = 1;
      updatePageIndicator(currentPage);
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
      fragment.appendChild(createAnnotationsSection('Notes', annotations.notes, 'notes'));
    }

    if (hasQuotes) {
      fragment.appendChild(createAnnotationsSection('Quotes', annotations.quotes, 'quotes'));
    }

    container.appendChild(fragment);
  }

  function createAnnotationsSection(title, entries, type) {
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
      item.textContent = text;
      list.appendChild(item);
    });

    section.appendChild(list);
    return section;
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
      updateSlotHeight(pageView.pageNumber, viewport.height);

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

      await Promise.all([renderPromise, textLayerPromise]);

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
      updatePageIndicator(target);
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

      await ensurePageViewMaterialized(pageNumber);
      scheduleVirtualizationUpdate({ immediate: true });

      const slotRecord = getSlotRecord(pageNumber);
      slotRecord?.element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updatePageIndicator(pageNumber);
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

  function updatePageIndicator(pageNumber) {
    currentPage = pageNumber;
    pageNumberEl.textContent = pageNumber.toString();
    updateBookmarkButtonState();
    setActiveOutlineEntry(pageNumber);
  }

  function updateZoomDisplay() {
    zoomValue.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  updateZoomDisplay();

  function showContextMenu(mouseEvent, pageNumber) {
    if (!contextMenu) {
      return;
    }

    const { clientX, clientY } = mouseEvent;
    const selection = (window.getSelection()?.toString() ?? '').trim();
    storedSelectionText = selection;
    contextMenuPage = pageNumber;
    contextMenu.dataset.page = String(pageNumber);
    contextMenu.dataset.selection = selection;
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

    const firstButton = contextMenu.querySelector('button[data-command]');
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
    contextMenuPage = null;
    storedSelectionText = '';
    isContextMenuOpen = false;
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
    pdfContainer.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = message;
    pdfContainer.appendChild(placeholder);
  }

  function showError(message) {
    setBookmarkButtonEnabled(false);
    updateBookmarkButtonState();
    pdfContainer.innerHTML = '';
    const errorBox = document.createElement('div');
    errorBox.className = 'error';
    errorBox.textContent = message;
    pdfContainer.appendChild(errorBox);
  }

  vscode.postMessage({ type: 'ready' });
})();
