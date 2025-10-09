import * as vscode from 'vscode';
import { AnnotationEntry, AnnotationManager, AnnotationState } from './annotations';

type ViewerTheme = 'dark' | 'paper' | 'regular';

interface PdfDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

class SimplePdfDocument implements PdfDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // nothing to dispose
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PdfViewerProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('dunkelpdf.viewer', provider, {
      supportsMultipleEditorsPerDocument: true
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dunkelpdf.theme.dark', () => provider.updateTheme('dark'))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dunkelpdf.theme.paper', () => provider.updateTheme('paper'))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dunkelpdf.theme.regular', () => provider.updateTheme('regular'))
  );
}

export function deactivate() {
  // Nothing to do here
}

class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly annotationManager = new AnnotationManager();
  private readonly annotationStates = new Map<string, AnnotationState>();
  private readonly documentPanels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly annotationFileToDocumentKey = new Map<string, string>();
  private readonly documentUris = new Map<string, vscode.Uri>();
  private currentTheme: ViewerTheme;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentTheme = context.globalState.get<ViewerTheme>('dunkelpdf.theme', 'regular');

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(document => {
        this.handleAnnotationFileSaved(document).catch(error => {
          console.error('Failed to refresh annotations from disk', error);
        });
      })
    );
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<PdfDocument> {
    return new SimplePdfDocument(uri);
  }

  async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.panels.add(panel);
    const documentKey = this.getDocumentKey(document.uri);
    const annotationUri = this.annotationManager.getAnnotationUri(document.uri);
    let panelsForDocument = this.documentPanels.get(documentKey);
    if (!panelsForDocument) {
      panelsForDocument = new Set<vscode.WebviewPanel>();
      this.documentPanels.set(documentKey, panelsForDocument);
    }
    panelsForDocument.add(panel);
    this.documentUris.set(documentKey, document.uri);
    this.annotationFileToDocumentKey.set(annotationUri.toString(), documentKey);

    panel.onDidDispose(() => {
      this.panels.delete(panel);
      panelsForDocument?.delete(panel);
      if (panelsForDocument && panelsForDocument.size === 0) {
        this.documentPanels.delete(documentKey);
        this.annotationStates.delete(documentKey);
        this.documentUris.delete(documentKey);
        this.annotationFileToDocumentKey.delete(annotationUri.toString());
      }
    });

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    panel.webview.onDidReceiveMessage(async message => {
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
        case 'editNote': {
          await this.handleEditNoteMessage(document, message);
          break;
        }
        case 'editQuote': {
          await this.handleEditQuoteMessage(document, message);
          break;
        }
        case 'removeNote': {
          await this.handleRemoveNoteMessage(document, message);
          break;
        }
        case 'removeQuote': {
          await this.handleRemoveQuoteMessage(document, message);
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

  private async handleReadyMessage(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
    let pdfMessageSent = false;
    try {
      const fileData = await vscode.workspace.fs.readFile(document.uri);
      const base64 = Buffer.from(fileData).toString('base64');
      await panel.webview.postMessage({ type: 'loadPdf', data: base64 });
      pdfMessageSent = true;
    } catch (error) {
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

  private async handleAddNoteMessage(document: PdfDocument, message: unknown): Promise<void> {
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

  private async handleAddQuoteMessage(document: PdfDocument, message: unknown): Promise<void> {
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

  private async handleEditNoteMessage(document: PdfDocument, message: unknown): Promise<void> {
    await this.handleEditAnnotationEntryMessage(document, message, 'notes');
  }

  private async handleEditQuoteMessage(document: PdfDocument, message: unknown): Promise<void> {
    await this.handleEditAnnotationEntryMessage(document, message, 'quotes');
  }

  private async handleRemoveNoteMessage(document: PdfDocument, message: unknown): Promise<void> {
    await this.handleRemoveAnnotationEntryMessage(document, message, 'notes');
  }

  private async handleRemoveQuoteMessage(document: PdfDocument, message: unknown): Promise<void> {
    await this.handleRemoveAnnotationEntryMessage(document, message, 'quotes');
  }

  private async handleToggleBookmarkMessage(document: PdfDocument, message: unknown): Promise<void> {
    const page = this.extractPageNumber(message);
    if (page === null) {
      vscode.window.showErrorMessage('Unable to toggle bookmark: invalid page number received.');
      return;
    }

    await this.updateAnnotations(document.uri, state => {
      const index = state.bookmarks.indexOf(page);
      if (index >= 0) {
        state.bookmarks.splice(index, 1);
      } else {
        state.bookmarks.push(page);
      }
    });
  }

  private extractPageNumber(message: unknown): number | null {
    if (typeof message !== 'object' || message === null) {
      return null;
    }

    const value = (message as { page?: unknown }).page;
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

  private extractTextValue(message: unknown): string | undefined {
    if (typeof message !== 'object' || message === null) {
      return undefined;
    }

    const candidates = message as {
      text?: unknown;
      content?: unknown;
      quote?: unknown;
      value?: unknown;
    };

    const candidate = candidates.text ?? candidates.content ?? candidates.quote ?? candidates.value;

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }

    return undefined;
  }

  private async handleRemoveAnnotationEntryMessage(
    document: PdfDocument,
    message: unknown,
    type: 'notes' | 'quotes'
  ): Promise<void> {
    const page = this.extractPageNumber(message);
    if (page === null) {
      const label = type === 'notes' ? 'note' : 'quote';
      vscode.window.showErrorMessage(`Unable to remove ${label}: invalid page number received.`);
      return;
    }

    const label = type === 'notes' ? 'note' : 'quote';
    const selectionText = this.extractTextValue(message);
    const target = await this.selectAnnotationEntry(
      document.uri,
      type,
      page,
      selectionText,
      'remove'
    );
    if (!target) {
      return;
    }

    await this.updateAnnotations(document.uri, state => {
      const entries = state[type];
      const { entry, index } = target;
      if (
        index >= 0 &&
        index < entries.length &&
        entries[index].page === entry.page &&
        entries[index].content === entry.content
      ) {
        entries.splice(index, 1);
        return;
      }

      const fallbackIndex = entries.findIndex(
        candidate => candidate.page === entry.page && candidate.content === entry.content
      );
      if (fallbackIndex >= 0) {
        entries.splice(fallbackIndex, 1);
      }
    });

    vscode.window.showInformationMessage(`Removed ${label} from page ${page}.`);
  }

  private async handleEditAnnotationEntryMessage(
    document: PdfDocument,
    message: unknown,
    type: 'notes' | 'quotes'
  ): Promise<void> {
    const page = this.extractPageNumber(message);
    if (page === null) {
      const label = type === 'notes' ? 'note' : 'quote';
      vscode.window.showErrorMessage(`Unable to edit ${label}: invalid page number received.`);
      return;
    }

    const label = type === 'notes' ? 'note' : 'quote';
    const selectionText = this.extractTextValue(message);
    const target = await this.selectAnnotationEntry(
      document.uri,
      type,
      page,
      selectionText,
      'edit'
    );
    if (!target) {
      return;
    }

    const currentContent = target.entry.content;
    const input = await vscode.window.showInputBox({
      prompt: `Edit the ${label} on page ${page}`,
      value: currentContent,
      valueSelection: [0, currentContent.length]
    });

    if (input === undefined) {
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      vscode.window.showInformationMessage(`The ${label} cannot be empty.`);
      return;
    }

    if (trimmed === currentContent.trim()) {
      return;
    }

    await this.updateAnnotations(document.uri, state => {
      const entries = state[type];
      const { entry, index } = target;
      if (
        index >= 0 &&
        index < entries.length &&
        entries[index].page === entry.page &&
        entries[index].content === entry.content
      ) {
        entries[index].content = trimmed;
        return;
      }

      const fallback = entries.find(
        candidate => candidate.page === entry.page && candidate.content === entry.content
      );
      if (fallback) {
        fallback.content = trimmed;
      }
    });

    vscode.window.showInformationMessage(`Updated ${label} on page ${page}.`);
  }

  private async selectAnnotationEntry(
    documentUri: vscode.Uri,
    type: 'notes' | 'quotes',
    page: number,
    selectionText: string | undefined,
    mode: 'remove' | 'edit'
  ): Promise<{ entry: AnnotationEntry; index: number } | undefined> {
    const label = type === 'notes' ? 'note' : 'quote';
    const pluralLabel = type === 'notes' ? 'notes' : 'quotes';
    const currentState = await this.getAnnotationsForDocument(documentUri);
    const candidates = currentState[type]
      .map((entry, index) => ({ entry, index }))
      .filter(candidate => candidate.entry.page === page);

    if (candidates.length === 0) {
      vscode.window.showInformationMessage(`No ${pluralLabel} found for page ${page}.`);
      return undefined;
    }

    const normalizedSelection = selectionText?.trim();
    if (normalizedSelection) {
      const match = candidates.find(candidate => candidate.entry.content === normalizedSelection);
      if (match) {
        if (mode === 'remove' && candidates.length === 1) {
          const confirmed = await this.confirmAnnotationRemoval(label, page);
          return confirmed ? match : undefined;
        }
        return match;
      }
    }

    return this.promptForAnnotationSelection(type, page, candidates, mode);
  }

  private async promptForAnnotationSelection(
    type: 'notes' | 'quotes',
    page: number,
    candidates: { entry: AnnotationEntry; index: number }[],
    mode: 'remove' | 'edit'
  ): Promise<{ entry: AnnotationEntry; index: number } | undefined> {
    const label = type === 'notes' ? 'note' : 'quote';

    if (candidates.length === 1) {
      if (mode === 'remove') {
        const confirmed = await this.confirmAnnotationRemoval(label, page);
        return confirmed ? candidates[0] : undefined;
      }
      return candidates[0];
    }

    interface AnnotationQuickPickItem extends vscode.QuickPickItem {
      entry: AnnotationEntry;
      entryIndex: number;
    }

    const items: AnnotationQuickPickItem[] = candidates.map((candidate, position) => {
      const content = candidate.entry.content.trim() || '(Empty)';
      const truncated = content.length > 80 ? `${content.slice(0, 77)}…` : content;
      return {
        label: truncated,
        description: `#${position + 1}`,
        detail: `Page ${candidate.entry.page}`,
        entry: candidate.entry,
        entryIndex: candidate.index
      };
    });

    const action = mode === 'remove' ? 'remove' : 'edit';
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: `Select a ${label} to ${action} from page ${page}`
    });

    if (!selection) {
      return undefined;
    }

    return { entry: selection.entry, index: selection.entryIndex };
  }

  private async confirmAnnotationRemoval(label: string, page: number): Promise<boolean> {
    const confirm = await vscode.window.showWarningMessage(
      `Remove the ${label} on page ${page}?`,
      { modal: true },
      'Remove'
    );
    return confirm === 'Remove';
  }

  private async updateAnnotations(
    documentUri: vscode.Uri,
    mutator: (state: AnnotationState) => void
  ): Promise<void> {
    const current = await this.getAnnotationsForDocument(documentUri);
    const updated = this.cloneAnnotationState(current);
    mutator(updated);
    this.normalizeAnnotationState(updated);

    try {
      await this.annotationManager.save(documentUri, updated);
      this.annotationStates.set(this.getDocumentKey(documentUri), updated);
      this.broadcastAnnotations(documentUri, updated);
    } catch (error) {
      console.error('Failed to write annotations', error);
      vscode.window.showErrorMessage(`Failed to save annotations: ${this.formatError(error)}`);
    }
  }

  private normalizeAnnotationState(state: AnnotationState): void {
    state.notes = this.normalizeEntries(state.notes);
    state.quotes = this.normalizeEntries(state.quotes);

    const uniqueBookmarks = Array.from(
      new Set(state.bookmarks.filter(page => Number.isFinite(page) && page > 0).map(page => Math.trunc(page)))
    );
    uniqueBookmarks.sort((a, b) => a - b);
    state.bookmarks = uniqueBookmarks;
  }

  private normalizeEntries(entries: AnnotationEntry[]): AnnotationEntry[] {
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

  private async getAnnotationsForDocument(documentUri: vscode.Uri): Promise<AnnotationState> {
    const key = this.getDocumentKey(documentUri);
    this.documentUris.set(key, documentUri);
    const annotationUri = this.annotationManager.getAnnotationUri(documentUri);
    this.annotationFileToDocumentKey.set(annotationUri.toString(), key);
    const existing = this.annotationStates.get(key);
    if (existing) {
      return existing;
    }

    try {
      const annotations = await this.annotationManager.load(documentUri);
      this.annotationStates.set(key, annotations);
      return annotations;
    } catch (error) {
      console.error('Failed to read annotations', error);
      vscode.window.showErrorMessage(`Failed to read annotations: ${this.formatError(error)}`);
      const fallback = this.annotationManager.createEmptyState();
      this.annotationStates.set(key, fallback);
      return fallback;
    }
  }

  private broadcastAnnotations(documentUri: vscode.Uri, annotations: AnnotationState): void {
    const panelsForDocument = this.documentPanels.get(this.getDocumentKey(documentUri));
    if (!panelsForDocument) {
      return;
    }

    const payload = this.cloneAnnotationState(annotations);
    for (const targetPanel of panelsForDocument) {
      targetPanel.webview.postMessage({ type: 'loadAnnotations', data: payload });
    }
  }

  private cloneAnnotationState(state: AnnotationState): AnnotationState {
    return {
      notes: state.notes.map(note => ({ ...note })),
      quotes: state.quotes.map(quote => ({ ...quote })),
      bookmarks: [...state.bookmarks]
    };
  }

  private async handleAnnotationFileSaved(document: vscode.TextDocument): Promise<void> {
    const documentKey = this.annotationFileToDocumentKey.get(document.uri.toString());
    if (!documentKey) {
      return;
    }

    const sourceDocumentUri = this.documentUris.get(documentKey);
    if (!sourceDocumentUri) {
      return;
    }

    try {
      const annotations = await this.annotationManager.load(sourceDocumentUri);
      this.normalizeAnnotationState(annotations);
      this.annotationStates.set(documentKey, annotations);
      this.broadcastAnnotations(sourceDocumentUri, annotations);
    } catch (error) {
      console.error('Failed to reload annotations from saved file', error);
      vscode.window.showErrorMessage(`Failed to reload annotations: ${this.formatError(error)}`);
    }
  }

  private getDocumentKey(uri: vscode.Uri): string {
    return uri.toString();
  }

  private formatError(error: unknown): string {
    if (error instanceof vscode.FileSystemError) {
      return error.message || error.name;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }


  async updateTheme(theme: ViewerTheme): Promise<void> {
    if (this.currentTheme === theme) {
      return;
    }

    this.currentTheme = theme;
    await this.context.globalState.update('dunkelpdf.theme', theme);
    this.sendTheme();
  }

  private sendTheme(target?: vscode.WebviewPanel) {
    const message = { type: 'setTheme', theme: this.currentTheme };

    if (target) {
      target.webview.postMessage(message);
      return;
    }

    for (const panel of this.panels) {
      panel.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.js'));
    const helpersUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer-helpers.js')
    );
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'));
    const pdfJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf.min.mjs')
    );
    const pdfWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf.worker.min.mjs')
    );
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
              <form id="pageJumpForm" class="toolbar__page-jump" autocomplete="off">
                <label class="toolbar__page-jump-label visually-hidden" for="pageJumpInput">Go to page</label>
                <input
                  id="pageJumpInput"
                  class="toolbar__page-jump-input"
                  type="number"
                  min="1"
                  step="1"
                  value="1"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  aria-describedby="pageJumpFeedback"
                  title="Go to page"
                  disabled
                />
                <span
                  id="pageJumpFeedback"
                  class="toolbar__page-jump-feedback"
                  role="status"
                  aria-live="polite"
                  aria-hidden="true"
                ></span>
              </form>
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
            <aside
              id="annotationSidebar"
              class="annotation-sidebar annotation-sidebar--collapsed"
              aria-label="Bookmarks and annotations"
              aria-hidden="true"
            >
              <div class="annotation-sidebar__header">
                <button
                  id="annotationToggle"
                  class="annotation-sidebar__toggle"
                  type="button"
                  aria-expanded="false"
                  aria-controls="annotationSections"
                >
                  <span class="annotation-sidebar__toggle-icon" aria-hidden="true">✎</span>
                  <span class="annotation-sidebar__toggle-text">Annotations</span>
                </button>
              </div>
              <div
                id="annotationSections"
                class="annotation-sidebar__sections"
                role="navigation"
                aria-labelledby="annotationToggle"
              >
                <section
                  class="annotation-sidebar__section"
                  aria-labelledby="annotationBookmarksTitle"
                >
                  <header class="annotation-sidebar__section-header">
                    <h2 id="annotationBookmarksTitle" class="annotation-sidebar__section-title">
                      Bookmarks
                    </h2>
                    <span
                      id="annotationBookmarksCount"
                      class="annotation-sidebar__count"
                      aria-live="polite"
                    >
                      0
                    </span>
                  </header>
                  <ul
                    id="annotationBookmarksList"
                    class="annotation-sidebar__list"
                    role="list"
                    aria-describedby="annotationBookmarksEmpty"
                  ></ul>
                  <p id="annotationBookmarksEmpty" class="annotation-sidebar__empty" role="note">
                    No bookmarks yet.
                  </p>
                </section>
                <section class="annotation-sidebar__section" aria-labelledby="annotationNotesTitle">
                  <header class="annotation-sidebar__section-header">
                    <h2 id="annotationNotesTitle" class="annotation-sidebar__section-title">Notes</h2>
                    <span
                      id="annotationNotesCount"
                      class="annotation-sidebar__count"
                      aria-live="polite"
                    >
                      0
                    </span>
                  </header>
                  <ul
                    id="annotationNotesList"
                    class="annotation-sidebar__list"
                    role="list"
                    aria-describedby="annotationNotesEmpty"
                  ></ul>
                  <p id="annotationNotesEmpty" class="annotation-sidebar__empty" role="note">
                    Notes you add will show up here.
                  </p>
                </section>
                <section class="annotation-sidebar__section" aria-labelledby="annotationQuotesTitle">
                  <header class="annotation-sidebar__section-header">
                    <h2 id="annotationQuotesTitle" class="annotation-sidebar__section-title">Quotes</h2>
                    <span
                      id="annotationQuotesCount"
                      class="annotation-sidebar__count"
                      aria-live="polite"
                    >
                      0
                    </span>
                  </header>
                  <ul
                    id="annotationQuotesList"
                    class="annotation-sidebar__list"
                    role="list"
                    aria-describedby="annotationQuotesEmpty"
                  ></ul>
                  <p id="annotationQuotesEmpty" class="annotation-sidebar__empty" role="note">
                    Save favourite passages to revisit them quickly.
                  </p>
                </section>
              </div>
            </aside>

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
            <button
              type="button"
              role="menuitem"
              data-command="editNote"
              aria-describedby="contextMenuDescription"
              aria-hidden="true"
              hidden
            >
              Edit note
            </button>
            <button
              type="button"
              role="menuitem"
              data-command="removeNote"
              aria-describedby="contextMenuDescription"
              aria-hidden="true"
              hidden
            >
              Remove note
            </button>
            <button type="button" role="menuitem" data-command="addQuote" aria-describedby="contextMenuDescription">
              Add quote
            </button>
            <button
              type="button"
              role="menuitem"
              data-command="editQuote"
              aria-describedby="contextMenuDescription"
              aria-hidden="true"
              hidden
            >
              Edit quote
            </button>
            <button
              type="button"
              role="menuitem"
              data-command="removeQuote"
              aria-describedby="contextMenuDescription"
              aria-hidden="true"
              hidden
            >
              Remove quote
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
          <script nonce="${nonce}" src="${helpersUri}" defer></script>
          <script nonce="${nonce}" src="${scriptUri}" defer></script>
        </body>
      </html>`;
  }

  private getNonce(): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
      const index = Math.floor(Math.random() * charset.length);
      result += charset.charAt(index);
    }
    return result;
  }

  private async handleOpenExternalMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }

    const payload = message as { url?: unknown; href?: unknown };
    const candidate = payload.url ?? payload.href;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return;
    }

    try {
      const uri = vscode.Uri.parse(candidate.trim());
      await vscode.env.openExternal(uri);
    } catch (error) {
      console.error('Failed to open external link', error);
      vscode.window.showErrorMessage(`Failed to open link: ${this.formatError(error)}`);
    }
  }
}

function isViewerTheme(value: unknown): value is ViewerTheme {
  return value === 'dark' || value === 'paper' || value === 'regular';
}
