(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('pdfCanvas');
  const zoomRange = document.getElementById('zoomRange');
  const zoomValue = document.getElementById('zoomValue');
  const pageNumberEl = document.getElementById('pageNumber');
  const pageCountEl = document.getElementById('pageCount');
  const toolbar = document.querySelector('.toolbar');

  if (!canvas || !zoomRange || !zoomValue || !pageNumberEl || !pageCountEl || !toolbar) {
    vscode.postMessage({ type: 'ready' });
    throw new Error('Viewer failed to initialize');
  }

  const context = canvas.getContext('2d');
  if (!context) {
    vscode.postMessage({ type: 'ready' });
    throw new Error('Cannot acquire 2D rendering context');
  }

  const themeButtons = toolbar.querySelectorAll('button[data-theme]');

  let pdfDoc = null;
  let currentPage = 1;
  let currentZoom = 1.0;
  let renderTask = null;

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

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

  document.querySelectorAll('button[data-action]').forEach(button => {
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
    zoomValue.textContent = `${zoomRange.value}%`;
    renderPage();
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

  async function loadPdf(data) {
    try {
      const pdfData = decodeBase64(data);
      pdfDoc = await window.pdfjsLib.getDocument({ data: pdfData }).promise;
      pageCountEl.textContent = pdfDoc.numPages.toString();
      currentPage = 1;
      renderPage();
    } catch (error) {
      showError(String(error));
    }
  }

  function renderPage() {
    if (!pdfDoc) {
      return;
    }

    if (renderTask) {
      renderTask.cancel();
      renderTask = null;
    }

    pdfDoc
      .getPage(currentPage)
      .then(page => {
        const viewport = page.getViewport({ scale: currentZoom });
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const renderContext = {
          canvasContext: context,
          viewport
        };

        renderTask = page.render(renderContext);
        return renderTask.promise;
      })
      .then(() => {
        pageNumberEl.textContent = currentPage.toString();
      })
      .catch(error => {
        if (error?.name === 'RenderingCancelledException') {
          return;
        }
        showError(String(error));
      });
  }

  function changePage(delta) {
    if (!pdfDoc) {
      return;
    }

    const nextPage = currentPage + delta;
    if (nextPage < 1 || nextPage > pdfDoc.numPages) {
      return;
    }

    currentPage = nextPage;
    renderPage();
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

  function showError(message) {
    const main = document.querySelector('main');
    main.innerHTML = `<div class="error">${message}</div>`;
  }

  vscode.postMessage({ type: 'ready' });
})();
