"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const annotations_1 = require("./annotations");
class SimplePdfDocument {
    constructor(uri) {
        this.uri = uri;
    }
    dispose() {
        // nothing to dispose
    }
}
function activate(context) {
    const provider = new PdfViewerProvider(context);
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('dunkelpdf.viewer', provider, {
        supportsMultipleEditorsPerDocument: true
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dunkelpdf.theme.dark', () => provider.updateTheme('dark')));
    context.subscriptions.push(vscode.commands.registerCommand('dunkelpdf.theme.paper', () => provider.updateTheme('paper')));
    context.subscriptions.push(vscode.commands.registerCommand('dunkelpdf.theme.regular', () => provider.updateTheme('regular')));
}
function deactivate() {
    // Nothing to do here
}
class PdfViewerProvider {
    constructor(context) {
        this.context = context;
        this.panels = new Set();
        this.annotationManager = new annotations_1.AnnotationManager();
        this.annotationStates = new Map();
        this.documentPanels = new Map();
        this.currentTheme = context.globalState.get('dunkelpdf.theme', 'regular');
    }
    async openCustomDocument(uri, _openContext, _token) {
        return new SimplePdfDocument(uri);
    }
    async resolveCustomEditor(document, panel) {
        this.panels.add(panel);
        const documentKey = this.getDocumentKey(document.uri);
        let panelsForDocument = this.documentPanels.get(documentKey);
        if (!panelsForDocument) {
            panelsForDocument = new Set();
            this.documentPanels.set(documentKey, panelsForDocument);
        }
        panelsForDocument.add(panel);
        panel.onDidDispose(() => {
            this.panels.delete(panel);
            panelsForDocument?.delete(panel);
            if (panelsForDocument && panelsForDocument.size === 0) {
                this.documentPanels.delete(documentKey);
                this.annotationStates.delete(documentKey);
            }
        });
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message?.type) {
                case 'ready': {
                    await this.handleReadyMessage(document, panel);
                    break;
                }
                case 'requestThemeChange': {
                    if (isViewerTheme(message.theme)) {
                        await this.updateTheme(message.theme);
                    }
                    break;
                }
                case 'requestTheme': {
                    this.sendTheme(panel);
                    break;
                }
                case 'addNote': {
                    await this.handleAddNoteMessage(document, message);
                    break;
                }
                case 'addQuote': {
                    await this.handleAddQuoteMessage(document, message);
                    break;
                }
                case 'toggleBookmark': {
                    await this.handleToggleBookmarkMessage(document, message);
                    break;
                }
                case 'openExternal': {
                    await this.handleOpenExternalMessage(message);
                    break;
                }
                default:
                    break;
            }
        });
        panel.webview.html = this.getHtml(panel.webview);
    }
    async handleReadyMessage(document, panel) {
        let pdfMessageSent = false;
        try {
            const fileData = await vscode.workspace.fs.readFile(document.uri);
            const base64 = Buffer.from(fileData).toString('base64');
            await panel.webview.postMessage({ type: 'loadPdf', data: base64 });
            pdfMessageSent = true;
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to load PDF: ${this.formatError(error)}`);
        }
        if (pdfMessageSent) {
            const hasAnnotationFile = await this.annotationManager.annotationFileExists(document.uri);
            const annotations = hasAnnotationFile
                ? await this.getAnnotationsForDocument(document.uri)
                : this.annotationManager.createEmptyState();
            if (!hasAnnotationFile) {
                this.annotationStates.set(this.getDocumentKey(document.uri), annotations);
            }
            await panel.webview.postMessage({
                type: 'loadAnnotations',
                data: this.cloneAnnotationState(annotations)
            });
        }
        this.sendTheme(panel);
    }
    async handleAddNoteMessage(document, message) {
        const page = this.extractPageNumber(message);
        if (page === null) {
            vscode.window.showErrorMessage('Unable to add note: invalid page number received.');
            return;
        }
        const defaultValue = this.extractTextValue(message);
        const input = await vscode.window.showInputBox({
            prompt: `Enter a note for page ${page}`,
            value: defaultValue
        });
        if (input === undefined) {
            return;
        }
        await this.updateAnnotations(document.uri, state => {
            state.notes.push({ page, content: input.trim() });
        });
    }
    async handleAddQuoteMessage(document, message) {
        const page = this.extractPageNumber(message);
        if (page === null) {
            vscode.window.showErrorMessage('Unable to add quote: invalid page number received.');
            return;
        }
        const defaultValue = this.extractTextValue(message);
        const input = await vscode.window.showInputBox({
            prompt: `Enter a quote for page ${page}`,
            value: defaultValue
        });
        if (input === undefined) {
            return;
        }
        await this.updateAnnotations(document.uri, state => {
            state.quotes.push({ page, content: input.trim() });
        });
    }
    async handleToggleBookmarkMessage(document, message) {
        const page = this.extractPageNumber(message);
        if (page === null) {
            vscode.window.showErrorMessage('Unable to toggle bookmark: invalid page number received.');
            return;
        }
        await this.updateAnnotations(document.uri, state => {
            const index = state.bookmarks.indexOf(page);
            if (index >= 0) {
                state.bookmarks.splice(index, 1);
            }
            else {
                state.bookmarks.push(page);
            }
        });
    }
    extractPageNumber(message) {
        if (typeof message !== 'object' || message === null) {
            return null;
        }
        const value = message.page;
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
    extractTextValue(message) {
        if (typeof message !== 'object' || message === null) {
            return undefined;
        }
        const candidates = message;
        const candidate = candidates.text ?? candidates.content ?? candidates.quote ?? candidates.value;
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
        return undefined;
    }
    async updateAnnotations(documentUri, mutator) {
        const current = await this.getAnnotationsForDocument(documentUri);
        const updated = this.cloneAnnotationState(current);
        mutator(updated);
        this.normalizeAnnotationState(updated);
        try {
            await this.annotationManager.save(documentUri, updated);
            this.annotationStates.set(this.getDocumentKey(documentUri), updated);
            this.broadcastAnnotations(documentUri, updated);
        }
        catch (error) {
            console.error('Failed to write annotations', error);
            vscode.window.showErrorMessage(`Failed to save annotations: ${this.formatError(error)}`);
        }
    }
    normalizeAnnotationState(state) {
        state.notes = this.normalizeEntries(state.notes);
        state.quotes = this.normalizeEntries(state.quotes);
        const uniqueBookmarks = Array.from(new Set(state.bookmarks.filter(page => Number.isFinite(page) && page > 0).map(page => Math.trunc(page))));
        uniqueBookmarks.sort((a, b) => a - b);
        state.bookmarks = uniqueBookmarks;
    }
    normalizeEntries(entries) {
        const filtered = entries
            .filter(entry => Number.isFinite(entry.page) && entry.page > 0)
            .map(entry => ({ page: Math.trunc(entry.page), content: entry.content.trim() }));
        filtered.sort((a, b) => {
            if (a.page === b.page) {
                return a.content.localeCompare(b.content);
            }
            return a.page - b.page;
        });
        return filtered;
    }
    async getAnnotationsForDocument(documentUri) {
        const key = this.getDocumentKey(documentUri);
        const existing = this.annotationStates.get(key);
        if (existing) {
            return existing;
        }
        try {
            const annotations = await this.annotationManager.load(documentUri);
            this.annotationStates.set(key, annotations);
            return annotations;
        }
        catch (error) {
            console.error('Failed to read annotations', error);
            vscode.window.showErrorMessage(`Failed to read annotations: ${this.formatError(error)}`);
            const fallback = this.annotationManager.createEmptyState();
            this.annotationStates.set(key, fallback);
            return fallback;
        }
    }
    broadcastAnnotations(documentUri, annotations) {
        const panelsForDocument = this.documentPanels.get(this.getDocumentKey(documentUri));
        if (!panelsForDocument) {
            return;
        }
        const payload = this.cloneAnnotationState(annotations);
        for (const targetPanel of panelsForDocument) {
            targetPanel.webview.postMessage({ type: 'loadAnnotations', data: payload });
        }
    }
    cloneAnnotationState(state) {
        return {
            notes: state.notes.map(note => ({ ...note })),
            quotes: state.quotes.map(quote => ({ ...quote })),
            bookmarks: [...state.bookmarks]
        };
    }
    getDocumentKey(uri) {
        return uri.toString();
    }
    formatError(error) {
        if (error instanceof vscode.FileSystemError) {
            return error.message || error.name;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    async updateTheme(theme) {
        if (this.currentTheme === theme) {
            return;
        }
        this.currentTheme = theme;
        await this.context.globalState.update('dunkelpdf.theme', theme);
        this.sendTheme();
    }
    sendTheme(target) {
        const message = { type: 'setTheme', theme: this.currentTheme };
        if (target) {
            target.webview.postMessage(message);
            return;
        }
        for (const panel of this.panels) {
            panel.webview.postMessage(message);
        }
    }
    getHtml(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.js'));
        const helpersUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer-helpers.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'));
        const pdfJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf.min.mjs'));
        const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf.worker.min.mjs'));
        const cspSource = webview.cspSource;
        const nonce = this.getNonce();
        return /* html */ `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource}; script-src 'nonce-${nonce}' ${cspSource}; font-src ${cspSource} data: blob:; worker-src ${cspSource} blob:;"
          />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="${styleUri}" />
          <title>Dunkel PDF Viewer</title>
        </head>
        <body data-theme="regular" data-pdfjs-lib="${pdfJsUri}" data-pdfjs-worker="${pdfWorkerUri}">
          <header class="toolbar">
            <div class="toolbar__group">
              <button data-action="prev" title="Previous page">◀</button>
              <span class="page-info"><span id="pageNumber">1</span> / <span id="pageCount">1</span></span>
              <button
                id="bookmarkToggle"
                class="toolbar__bookmark"
                type="button"
                title="Bookmark current page"
                aria-label="Bookmark current page"
                aria-pressed="false"
                aria-disabled="true"
                disabled
              >
                <span class="toolbar__bookmark-icon" aria-hidden="true">☆</span>
              </button>
              <button data-action="next" title="Next page">▶</button>
            </div>
            <div class="toolbar__group">
              <button data-theme="regular">Regular</button>
              <button data-theme="dark">Dark</button>
              <button data-theme="paper">Sand</button>
            </div>
            <div class="toolbar__group toolbar__group--zoom">
              <button
                id="zoomOut"
                class="toolbar__zoom-button"
                type="button"
                title="Zoom out"
                aria-label="Zoom out"
              >
                −
              </button>
              <input id="zoomRange" type="range" min="50" max="200" value="100" step="5" />
              <button
                id="zoomIn"
                class="toolbar__zoom-button"
                type="button"
                title="Zoom in"
                aria-label="Zoom in"
              >
                +
              </button>
              <span id="zoomValue">100%</span>
            </div>
            <div class="toolbar__group toolbar__group--search">
              <button
                id="searchToggle"
                class="toolbar__search-toggle"
                type="button"
                aria-label="Find in document"
                aria-haspopup="dialog"
                aria-expanded="false"
                aria-controls="searchPopover"
                title="Find in document"
              >
                <span aria-hidden="true">🔍</span>
              </button>
              <div
                id="searchPopover"
                class="toolbar__search-popover"
                role="dialog"
                aria-label="Find in document"
                aria-modal="false"
                aria-hidden="true"
                hidden
              >
                <label class="toolbar__search-label visually-hidden" for="searchInput">Find in document</label>
                <div class="toolbar__search-controls">
                  <input
                    id="searchInput"
                    class="toolbar__search-input"
                    type="search"
                    placeholder="Find in document"
                    autocomplete="off"
                  />
                  <div class="toolbar__search-nav" role="group" aria-label="Search navigation">
                    <button id="searchPrev" type="button" title="Previous match" aria-label="Previous match">↑</button>
                    <button id="searchNext" type="button" title="Next match" aria-label="Next match">↓</button>
                  </div>
                  <span id="searchMatches" class="toolbar__search-matches" aria-live="polite">0 / 0</span>
                  <button
                    id="searchClear"
                    class="toolbar__search-clear"
                    type="button"
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          </header>
          <main class="viewer-shell">
            <aside id="outlinePanel" class="outline outline--collapsed" aria-label="Document outline">
              <div class="outline__header">
                <button
                  id="outlineToggle"
                  class="outline__toggle"
                  type="button"
                  aria-expanded="false"
                  aria-controls="outlineList"
                >
                  <span class="outline__toggle-icon" aria-hidden="true">☰</span>
                  <span class="outline__toggle-text">Outline</span>
                </button>
              </div>
              <nav id="outlineList" class="outline__list" role="tree" aria-labelledby="outlineToggle"></nav>
            </aside>
            <section id="viewerViewport" class="viewer-shell__content" tabindex="0">
              <div id="pdfContainer" class="pdf-container">
                <div class="placeholder">Open a PDF document to start viewing.</div>
              </div>
            </section>
          </main>
          <div
            id="contextMenu"
            class="context-menu"
            role="menu"
            aria-label="Page actions"
            aria-hidden="true"
            hidden
          >
            <span id="contextMenuDescription" class="visually-hidden">Actions for the current page selection</span>
            <button type="button" role="menuitem" data-command="addNote" aria-describedby="contextMenuDescription">
              Add note
            </button>
            <button type="button" role="menuitem" data-command="addQuote" aria-describedby="contextMenuDescription">
              Add quote
            </button>
            <button type="button" role="menuitem" data-command="copyPageText" aria-describedby="contextMenuDescription">
              Copy page text
            </button>
            <button
              type="button"
              role="menuitem"
              data-command="toggleBookmark"
              aria-describedby="contextMenuDescription"
            >
              Toggle favourite
            </button>
          </div>
          <script nonce="${nonce}" src="${helpersUri}"></script>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>`;
    }
    getNonce() {
        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) {
            const index = Math.floor(Math.random() * charset.length);
            result += charset.charAt(index);
        }
        return result;
    }
    async handleOpenExternalMessage(message) {
        if (typeof message !== 'object' || message === null) {
            return;
        }
        const payload = message;
        const candidate = payload.url ?? payload.href;
        if (typeof candidate !== 'string' || candidate.trim().length === 0) {
            return;
        }
        try {
            const uri = vscode.Uri.parse(candidate.trim());
            await vscode.env.openExternal(uri);
        }
        catch (error) {
            console.error('Failed to open external link', error);
            vscode.window.showErrorMessage(`Failed to open link: ${this.formatError(error)}`);
        }
    }
}
function isViewerTheme(value) {
    return value === 'dark' || value === 'paper' || value === 'regular';
}
//# sourceMappingURL=extension.js.map