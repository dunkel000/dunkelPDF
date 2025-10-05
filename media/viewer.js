(function () {
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
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
    !(searchMatches instanceof HTMLElement)
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
  const annotationsByPage = new Map();
  const annotationDestinations = new Map();
  const footnoteTooltipCache = new Map();
  const linkAnnotationHelpers = window.dunkelPdfLinkAnnotations || null;
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

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  const supportsTextLayer = Boolean(window.pdfjsLib?.renderTextLayer);

  setBookmarkButtonEnabled(false);
  updateBookmarkButtonState();
  setupSearchControls();

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
    const parsed = Number.parseInt(zoomRange.value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setZoomLevel(parsed / 100);
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
            setActiveMatch(searchState.activeIndex - 1, { scroll: true });
          } else {
            setActiveMatch(searchState.activeIndex + 1, { scroll: true });
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
          setActiveMatch(searchState.activeIndex - 1, { scroll: true });
        }
      });
    }

    if (searchNextButton instanceof HTMLButtonElement) {
      searchNextButton.addEventListener('click', () => {
        flushSearch(false);
        if (searchState.matches.length) {
          setActiveMatch(searchState.activeIndex + 1, { scroll: true });
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
      clearHighlightsForPage(pageView);
    });
    if (searchDebounceHandle !== null) {
      window.clearTimeout(searchDebounceHandle);
      searchDebounceHandle = null;
    }
    searchState.matches = [];
    searchState.activeIndex = -1;
    updateMatchesCounter();
    updateSearchControls();
  }

  function applySearchQuery(rawValue, options = {}) {
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

    pageViews.forEach(pageView => {
      applySearchHighlightsForPage(pageView, { suppressRefresh: true });
    });

    refreshGlobalMatches(previousKey);

    if (query && searchState.matches.length) {
      if (!isSameQuery) {
        setActiveMatch(0, { scroll: options.scroll === true });
      } else if (options.scroll && searchState.activeIndex >= 0) {
        updateActiveHighlight({ scroll: true });
        updateMatchesCounter();
      }
    }
  }

  function applySearchHighlightsForPage(pageView, options = {}) {
    const { suppressRefresh = false, previousKey = null } = options;

    clearHighlightsForPage(pageView);

    if (!supportsTextLayer || !searchState.query) {
      if (!suppressRefresh) {
        refreshGlobalMatches(previousKey);
      }
      return;
    }

    if (!pageView?.textLayerDiv || !pageView.textLayerDiv.childNodes.length) {
      pageView.searchHighlights = [];
      if (!suppressRefresh) {
        refreshGlobalMatches(previousKey);
      }
      return;
    }

    pageView.searchHighlights = highlightMatchesForPage(pageView, searchState.query);

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

    pageView.searchHighlights = [];
  }

  function highlightMatchesForPage(pageView, query) {
    if (!query || !query.length) {
      return [];
    }

    const textLayer = pageView?.textLayerDiv;
    if (!textLayer) {
      return [];
    }

    const sourceText = textLayer.textContent || '';
    if (!sourceText) {
      return [];
    }

    const lowerSource = sourceText.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (!lowerSource.includes(lowerQuery)) {
      return [];
    }

    const matches = [];
    let index = 0;

    while (index !== -1) {
      index = lowerSource.indexOf(lowerQuery, index);
      if (index === -1) {
        break;
      }

      const startPosition = resolveTextPosition(textLayer, index);
      const endPosition = resolveTextPosition(textLayer, index + query.length);

      if (!startPosition || !endPosition) {
        break;
      }

      const range = document.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const highlight = document.createElement('span');
      highlight.className = 'search-highlight';

      try {
        range.surroundContents(highlight);
        matches.push({ element: highlight, pageNumber: pageView.pageNumber, startOffset: index });
      } catch (error) {
        console.error('Failed to highlight search match', error);
        range.detach?.();
        break;
      }

      range.detach?.();

      index += query.length;
    }

    return matches;
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

    pageViews.forEach(pageView => {
      const pageMatches = Array.isArray(pageView.searchHighlights) ? pageView.searchHighlights : [];
      pageMatches.forEach(match => {
        if (match && match.element) {
          aggregated.push(match);
        }
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

    updateActiveHighlight({ scroll: false });
    updateMatchesCounter();
    updateSearchControls();
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

  function setActiveMatch(targetIndex, options = {}) {
    const total = searchState.matches.length;
    if (!total) {
      searchState.activeIndex = -1;
      updateActiveHighlight({ scroll: false });
      updateMatchesCounter();
      updateSearchControls();
      return;
    }

    let index = Number.isFinite(targetIndex) ? targetIndex : 0;
    index = ((index % total) + total) % total;
    searchState.activeIndex = index;
    updateActiveHighlight({ scroll: options.scroll !== false });
    updateMatchesCounter();
  }

  function updateActiveHighlight(options = {}) {
    const { scroll = false } = options;

    searchState.matches.forEach((match, idx) => {
      if (!match?.element) {
        return;
      }

      if (idx === searchState.activeIndex) {
        match.element.classList.add('is-active');
        if (scroll) {
          scrollMatchIntoView(match.element);
        }
      } else {
        match.element.classList.remove('is-active');
      }
    });
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
      syncBookmarkStateToPageView(pageView);
    });
  }

  function syncBookmarkStateToPageView(pageView) {
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
      pageViews.length = 0;

      const fragment = document.createDocumentFragment();

      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
        const pageView = createPageView(pageNumber);
        pageViews.push(pageView);
        fragment.appendChild(pageView.wrapper);
        intersectionObserver?.observe(pageView.wrapper);
      }

      pdfContainer.innerHTML = '';
      pdfContainer.appendChild(fragment);
      main.scrollTo({ top: 0, left: 0, behavior: 'auto' });

      rerenderPages();
      renderAnnotationsForAllPages();
      setBookmarkButtonEnabled(true);
      updateBookmarkButtonState();
      applySearchQuery(searchInput.value, { force: true, scroll: false });
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
    annotationLayerDiv.className = 'pdf-annotation-layer';

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
      viewport: null,
      searchHighlights: []
    };

    syncBookmarkStateToPageView(pageView);
    renderAnnotationsForPage(pageView);

    return pageView;
  }

  function rerenderPages() {
    if (!pdfDoc) {
      return;
    }

    pageViews.forEach(pageView => {
      renderPageView(pageView);
    });
  }

  function renderAnnotationsForAllPages() {
    pageViews.forEach(pageView => {
      renderAnnotationsForPage(pageView);
    });
  }

  function renderAnnotationsForPage(pageView) {
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
      if (pageView.annotationLayerDiv) {
        pageView.annotationLayerDiv.innerHTML = '';
        pageView.annotationLayerDiv.style.width = `${viewport.width}px`;
        pageView.annotationLayerDiv.style.height = `${viewport.height}px`;
      }

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

      const renderPromise = pageView.renderTask.promise;
      const annotationsPromise = page.getAnnotations({ intent: 'display' });
      const textContentPromise = page.getTextContent().then(textContent => {
        pageView.textContent = extractTextFromTextContent(textContent);
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

      const activeKey = getActiveMatchKey();
      applySearchHighlightsForPage(pageView, { suppressRefresh: true });
      refreshGlobalMatches(activeKey);
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }
      showError(String(error));
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
    updatePageIndicator(destination.pageNumber);
  }

  function changePage(delta) {
    if (!pdfDoc) {
      return;
    }

    const target = currentPage + delta;
    if (target < 1 || target > pdfDoc.numPages) {
      return;
    }

    const pageElement = pdfContainer.querySelector(`[data-page-number="${target}"]`);
    if (pageElement) {
      pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updatePageIndicator(target);
    }
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
  }

  function setZoomLevel(scale, options = {}) {
    if (!Number.isFinite(scale) || scale <= 0) {
      return;
    }

    const clamped = Math.max(0.5, Math.min(scale, 2));
    currentZoom = clamped;

    const sliderValue = Math.round(clamped * 100);
    if (zoomRange.value !== String(sliderValue)) {
      zoomRange.value = String(sliderValue);
    }

    updateZoomDisplay();

    if (!options.suppressRender) {
      rerenderPages();
    }
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

    const pageView = pageViews.find(view => view.pageNumber === pageNumber);
    let text = pageView?.textLayerDiv?.innerText?.trim() ?? pageView?.textContent?.trim() ?? '';

    if (!text) {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        const textContent = await page.getTextContent();
        text = extractTextFromTextContent(textContent);
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
