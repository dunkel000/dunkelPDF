(function () {
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
  const pdfContainer = document.getElementById('pdfContainer');
  const zoomRange = document.getElementById('zoomRange');
  const zoomValue = document.getElementById('zoomValue');
  const pageNumberEl = document.getElementById('pageNumber');
  const pageCountEl = document.getElementById('pageCount');
  const toolbar = document.querySelector('.toolbar');

  if (!main || !pdfContainer || !zoomRange || !zoomValue || !pageNumberEl || !pageCountEl || !toolbar) {
    vscode.postMessage({ type: 'ready' });
    throw new Error('Viewer failed to initialize');
  }

  const themeButtons = toolbar.querySelectorAll('button[data-theme]');
  const navigationButtons = toolbar.querySelectorAll('button[data-action]');

  let pdfDoc = null;
  let currentPage = 1;
  let currentZoom = 1.0;
  let intersectionObserver = null;
  const pageViews = [];

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  const supportsTextLayer = Boolean(window.pdfjsLib?.renderTextLayer);

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
    try {
      if (!window.pdfjsLib) {
        showError('PDF viewer failed to load. Please reload the editor.');
        return;
      }

      setStatus('Loading PDF…');
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
    } catch (error) {
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

    return {
      pageNumber,
      wrapper,
      surface,
      canvas,
      textLayerDiv,
      renderTask: null,
      textLayerTask: null
    };
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
  }

  function updateZoomDisplay() {
    zoomValue.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  updateZoomDisplay();

  function setStatus(message) {
    pdfContainer.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = message;
    pdfContainer.appendChild(placeholder);
  }

  function showError(message) {
    pdfContainer.innerHTML = '';
    const errorBox = document.createElement('div');
    errorBox.className = 'error';
    errorBox.textContent = message;
    pdfContainer.appendChild(errorBox);
  }

  vscode.postMessage({ type: 'ready' });
})();
