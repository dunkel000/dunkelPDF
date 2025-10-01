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

  if (!main || !pdfContainer || !zoomRange || !zoomValue || !pageNumberEl || !pageCountEl || !toolbar) {
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
  let contextMenuPage = null;
  let storedSelectionText = '';
  let isContextMenuOpen = false;
  const bookmarkedPages = new Set();

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  const supportsTextLayer = Boolean(window.pdfjsLib?.renderTextLayer);

  setBookmarkButtonEnabled(false);
  updateBookmarkButtonState();

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
      button.addEventListener('click', () => {
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

        vscode.postMessage({
          type: command,
          page: savedPage,
          text: selection
        });
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

  function refreshAnnotationState(data) {
    if (!data || typeof data !== 'object') {
      setBookmarkedPages([]);
      return;
    }

    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
    setBookmarkedPages(bookmarks);
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
    if (!Number.isFinite(currentPage)) {
      return;
    }

    const page = Math.trunc(currentPage);
    if (bookmarkedPages.has(page)) {
      bookmarkedPages.delete(page);
    } else {
      bookmarkedPages.add(page);
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
      setBookmarkButtonEnabled(true);
      updateBookmarkButtonState();
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

    surface.appendChild(canvas);
    surface.appendChild(textLayerDiv);
    wrapper.appendChild(surface);

    const pageView = {
      pageNumber,
      wrapper,
      surface,
      canvas,
      textLayerDiv,
      renderTask: null,
      textLayerTask: null
    };

    syncBookmarkStateToPageView(pageView);

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

      context.setTransform(1, 0, 0, 1, 0, 0);

      const renderContext = {
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
      };

      pageView.renderTask = page.render(renderContext);

      pageView.textLayerDiv.innerHTML = '';
      pageView.textLayerDiv.style.width = `${viewport.width}px`;
      pageView.textLayerDiv.style.height = `${viewport.height}px`;

      const renderPromise = pageView.renderTask.promise;
      let textLayerPromise = Promise.resolve();

      if (supportsTextLayer) {
        textLayerPromise = page
          .getTextContent()
          .then(textContent => {
            const task = window.pdfjsLib.renderTextLayer({
              textContent,
              container: pageView.textLayerDiv,
              viewport,
              textDivs: []
            });
            pageView.textLayerTask = task;
            return task.promise || task;
          });
      }

      await Promise.all([renderPromise, textLayerPromise]);
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }
      showError(String(error));
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
