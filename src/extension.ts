import * as path from 'path';
import * as vscode from 'vscode';
import {
  AnnotationEntry,
  AnnotationManager,
  AnnotationState,
  NotebookLink
} from './annotations';

type ViewerTheme = 'dark' | 'paper' | 'regular';
type BookmarkBorderStyle = 'pulse' | 'moving';

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

  context.subscriptions.push(
    vscode.commands.registerCommand('dunkelpdf.bookmarkStyle.pulse', () => provider.updateBookmarkStyle('pulse'))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dunkelpdf.bookmarkStyle.moving',
      () => provider.updateBookmarkStyle('moving')
    )
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
  private currentBookmarkStyle: BookmarkBorderStyle;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentTheme = context.globalState.get<ViewerTheme>('dunkelpdf.theme', 'regular');
    this.currentBookmarkStyle = context.globalState.get<BookmarkBorderStyle>(
      'dunkelpdf.bookmarkBorderStyle',
      'pulse'
    );

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
        case 'requestBookmarkStyleChange': {
          if (isBookmarkBorderStyle(message.style)) {
            await this.updateBookmarkStyle(message.style);
          }
          break;
        }
        case 'requestBookmarkStyle': {
          this.sendBookmarkStyle(panel);
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
        case 'linkNotebook': {
          await this.handleLinkNotebookMessage(document, message);
          break;
        }
        case 'editNotebookLink': {
          await this.handleEditNotebookLinkMessage(document, message);
          break;
        }
        case 'removeNotebookLink': {
          await this.handleRemoveNotebookLinkMessage(document, message);
          break;
        }
        case 'openNotebookLink': {
          await this.handleOpenNotebookLinkMessage(document, message);
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
      const base64Data = Buffer.from(fileData).toString('base64');
      await panel.webview.postMessage({ type: 'loadPdf', data: base64Data });
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
    this.sendBookmarkStyle(panel);
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

  private async handleLinkNotebookMessage(document: PdfDocument, message: unknown): Promise<void> {
    await this.manageNotebookLink(document, message, 'create');
  }

  private async handleEditNotebookLinkMessage(document: PdfDocument, message: unknown): Promise<void> {
    await this.manageNotebookLink(document, message, 'edit');
  }

  private async handleRemoveNotebookLinkMessage(
    document: PdfDocument,
    message: unknown
  ): Promise<void> {
    const page = this.extractPageNumber(message);
    const annotationType = this.extractAnnotationCategory(message);
    if (page === null || !annotationType) {
      vscode.window.showErrorMessage('Unable to remove notebook link: annotation context was invalid.');
      return;
    }

    const label = annotationType === 'notes' ? 'note' : 'quote';
    const selectionText = this.extractTextValue(message);
    const target = await this.selectAnnotationEntry(
      document.uri,
      annotationType,
      page,
      selectionText,
      'link'
    );
    if (!target) {
      return;
    }

    if (!target.entry.notebookLink) {
      vscode.window.showInformationMessage(
        `The ${label} on page ${page} is not linked to a notebook yet.`
      );
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove the notebook link from the ${label} on page ${page}?`,
      { modal: true },
      'Remove link'
    );
    if (confirm !== 'Remove link') {
      return;
    }

    await this.updateAnnotations(document.uri, state => {
      const entries = state[annotationType];
      const { entry, index } = target;
      const applyRemoval = (candidate: AnnotationEntry | undefined) => {
        if (candidate) {
          delete candidate.notebookLink;
        }
      };

      if (
        index >= 0 &&
        index < entries.length &&
        entries[index].page === entry.page &&
        entries[index].content === entry.content
      ) {
        delete entries[index].notebookLink;
        return;
      }

      const fallback = entries.find(
        candidate => candidate.page === entry.page && candidate.content === entry.content
      );
      applyRemoval(fallback);
    });

    vscode.window.showInformationMessage(
      `Removed the notebook link from the ${label} on page ${page}.`
    );
  }

  private async handleOpenNotebookLinkMessage(
    document: PdfDocument,
    message: unknown
  ): Promise<void> {
    const explicitLink = this.normalizeNotebookLink(this.extractNotebookLink(message));
    const annotationType = this.extractAnnotationCategory(message);
    const page = this.extractPageNumber(message);

    let resolvedLink = explicitLink;
    if (!resolvedLink && annotationType && page !== null) {
      const selectionText = this.extractTextValue(message);
      const target = await this.selectAnnotationEntry(
        document.uri,
        annotationType,
        page,
        selectionText,
        'link'
      );
      if (target?.entry.notebookLink) {
        resolvedLink = this.normalizeNotebookLink(target.entry.notebookLink);
      }
    }

    if (!resolvedLink) {
      vscode.window.showInformationMessage('No notebook link is associated with this annotation yet.');
      return;
    }

    try {
      await this.openNotebookLink(resolvedLink);
    } catch (error) {
      console.error('Failed to open linked notebook', error);
      vscode.window.showErrorMessage(`Failed to open notebook link: ${this.formatError(error)}`);
    }
  }

  private async manageNotebookLink(
    document: PdfDocument,
    message: unknown,
    mode: 'create' | 'edit'
  ): Promise<void> {
    const page = this.extractPageNumber(message);
    if (page === null) {
      const action = mode === 'edit' ? 'update' : 'create';
      vscode.window.showErrorMessage(`Unable to ${action} notebook link: annotation context was invalid.`);
      return;
    }

    const requestedType = this.extractAnnotationCategory(message);
    const annotationType = requestedType ?? 'notes';
    const label = annotationType === 'notes' ? 'note' : 'quote';
    const pluralLabel = annotationType === 'notes' ? 'notes' : 'quotes';
    const selectionText = this.extractTextValue(message);
    const trimmedSelection = selectionText?.trim() ?? '';

    let target: { entry: AnnotationEntry; index: number } | undefined;

    const currentState = await this.getAnnotationsForDocument(document.uri);
    const candidates = currentState[annotationType]
      .map((entry, index) => ({ entry, index }))
      .filter(candidate => candidate.entry.page === page);

    if (candidates.length === 0) {
      if (mode === 'edit') {
        vscode.window.showInformationMessage(`No ${pluralLabel} found for page ${page}.`);
        return;
      }
      target = { entry: { page, content: trimmedSelection }, index: -1 };
    } else {
      target = await this.selectAnnotationEntry(
        document.uri,
        annotationType,
        page,
        selectionText,
        'link'
      );
      if (!target) {
        return;
      }
    }

    if (!target) {
      return;
    }

    const existingLink = this.normalizeNotebookLink(target.entry.notebookLink);
    if (mode === 'edit' && !existingLink) {
      vscode.window.showInformationMessage(
        `The ${label} on page ${page} is not linked to a notebook yet.`
      );
      return;
    }

    const link = await this.promptForNotebookLink(target.entry, mode, existingLink);
    if (!link) {
      return;
    }

    await this.updateAnnotations(document.uri, state => {
      const entries = state[annotationType];
      const { entry, index } = target;
      const normalized = this.normalizeNotebookLink(link);
      if (!normalized) {
        return;
      }

      const applyLink = (candidate: AnnotationEntry | undefined) => {
        if (candidate) {
          candidate.notebookLink = normalized;
        }
      };

      if (
        index >= 0 &&
        index < entries.length &&
        entries[index].page === entry.page &&
        entries[index].content === entry.content
      ) {
        applyLink(entries[index]);
        return;
      }

      const fallback = entries.find(
        candidate => candidate.page === entry.page && candidate.content === entry.content
      );
      if (fallback) {
        applyLink(fallback);
        return;
      }

      entries.push({
        page: entry.page,
        content: entry.content.trim(),
        notebookLink: normalized
      });
    });

    const notebookDisplay = link.notebookLabel ?? this.getNotebookDisplayLabel(vscode.Uri.parse(link.notebookUri));
    vscode.window.showInformationMessage(
      `Linked the ${label} on page ${page} to ${notebookDisplay}.`
    );
  }

  private extractAnnotationCategory(message: unknown): 'notes' | 'quotes' | null {
    if (typeof message !== 'object' || message === null) {
      return null;
    }

    const payload = message as { annotationType?: unknown; type?: unknown };
    const candidate = payload.annotationType ?? payload.type;
    if (candidate === 'notes' || candidate === 'quotes') {
      return candidate;
    }
    return null;
  }

  private async promptForNotebookLink(
    entry: AnnotationEntry,
    mode: 'create' | 'edit',
    existing?: NotebookLink
  ): Promise<NotebookLink | undefined> {
    const notebookUri = await this.chooseNotebookUri(existing, mode);
    if (!notebookUri) {
      return undefined;
    }

    let notebookDocument: vscode.NotebookDocument;
    try {
      notebookDocument = await vscode.workspace.openNotebookDocument(notebookUri);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open notebook: ${this.formatError(error)}`);
      return undefined;
    }

    const cellSelection = await this.promptForNotebookCell(notebookDocument, existing);
    if (!cellSelection) {
      return undefined;
    }

    let targetCell: vscode.NotebookCell | undefined;
    let targetIndex = -1;
    if (cellSelection.kind === 'create') {
      const creation = await this.createNotebookSection(notebookUri, notebookDocument, entry);
      if (!creation) {
        return undefined;
      }
      targetCell = creation.cell;
      targetIndex = creation.index;
    } else {
      targetCell = cellSelection.cell;
      targetIndex = cellSelection.index;
    }

    if (!targetCell || targetIndex < 0) {
      return undefined;
    }

    const notebookLabel = this.getNotebookDisplayLabel(notebookUri);
    const cellLabel = this.getNotebookCellLabel(targetCell, targetIndex);

    return {
      notebookUri: notebookUri.toString(),
      notebookLabel,
      cellUri: targetCell.document.uri.toString(),
      cellLabel,
      cellIndex: targetIndex
    };
  }

  private async chooseNotebookUri(
    existing: NotebookLink | undefined,
    mode: 'create' | 'edit'
  ): Promise<vscode.Uri | undefined> {
    let existingUri = existing ? this.tryParseUri(existing.notebookUri) : undefined;

    if (mode === 'edit' && existingUri) {
      interface NotebookFileChoice extends vscode.QuickPickItem {
        action: 'current' | 'browse';
      }

      const currentLabel = this.getNotebookDisplayLabel(existingUri);
      const options: NotebookFileChoice[] = [
        {
          label: `Use current notebook (${currentLabel})`,
          description: 'Keep the existing notebook link',
          action: 'current'
        },
        {
          label: 'Choose a different notebook…',
          description: 'Select another .ipynb file',
          action: 'browse'
        }
      ];

      const selection = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select a notebook to link to'
      });

      if (!selection) {
        return undefined;
      }

      if (selection.action === 'current') {
        return existingUri;
      }
      existingUri = undefined;
    }

    const picker = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: existingUri,
      filters: { 'Jupyter Notebooks': ['ipynb'] },
      openLabel: 'Select notebook'
    });

    if (!picker || picker.length === 0) {
      return undefined;
    }

    return picker[0];
  }

  private tryParseUri(value: string | undefined): vscode.Uri | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return vscode.Uri.parse(value);
    } catch (error) {
      console.error('Failed to parse notebook URI from annotation', error);
      return undefined;
    }
  }

  private getNotebookDisplayLabel(uri: vscode.Uri): string {
    const workspaceLabel = vscode.workspace.asRelativePath(uri, false);
    if (workspaceLabel && workspaceLabel !== uri.toString()) {
      return workspaceLabel;
    }

    if (uri.scheme === 'file') {
      return path.basename(uri.fsPath);
    }

    return uri.toString();
  }

  private async promptForNotebookCell(
    notebook: vscode.NotebookDocument,
    existing?: NotebookLink
  ): Promise<
    | { kind: 'cell'; cell: vscode.NotebookCell; index: number }
    | { kind: 'create' }
    | undefined
  > {
    interface NotebookCellChoice extends vscode.QuickPickItem {
      choiceType: 'cell' | 'create';
      cellIndex?: number;
    }

    const items: NotebookCellChoice[] = notebook.getCells().map((cell, index) => ({
      choiceType: 'cell',
      cellIndex: index,
      label: this.getNotebookCellLabel(cell, index),
      description: cell.kind === vscode.NotebookCellKind.Markup ? 'Markdown cell' : 'Code cell',
      detail: this.getNotebookCellPreview(cell),
      picked: this.isCellMatchingLink(cell, existing)
    }));

    items.push({
      choiceType: 'create',
      label: '$(add) Create new markdown section…',
      description: 'Insert a new markdown cell for this annotation'
    });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a notebook section to link to',
      matchOnDetail: true
    });

    if (!selection) {
      return undefined;
    }

    if (selection.choiceType === 'create') {
      return { kind: 'create' };
    }

    const index = typeof selection.cellIndex === 'number' ? selection.cellIndex : 0;
    const cell = notebook.cellAt(Math.max(0, Math.min(index, notebook.cellCount - 1)));
    return { kind: 'cell', cell, index };
  }

  private isCellMatchingLink(cell: vscode.NotebookCell, link?: NotebookLink): boolean {
    if (!link) {
      return false;
    }

    if (link.cellUri && cell.document.uri.toString() === link.cellUri) {
      return true;
    }

    const index = this.findNotebookCellIndex(cell);
    if (typeof link.cellIndex === 'number' && index === Math.trunc(link.cellIndex)) {
      return true;
    }

    const targetLabel = this.normalizeNotebookCellLabel(link.cellLabel);
    if (!targetLabel || index < 0) {
      return false;
    }

    const cellLabel = this.normalizeNotebookCellLabel(this.getNotebookCellLabel(cell, index));
    return Boolean(cellLabel) && cellLabel === targetLabel;
  }

  private findNotebookCellIndex(cell: vscode.NotebookCell): number {
    const notebook = cell.notebook;
    if (!notebook) {
      return -1;
    }

    const cells = notebook.getCells();
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index] === cell) {
        return index;
      }
    }
    return -1;
  }

  private getNotebookCellLabel(cell: vscode.NotebookCell, index: number): string {
    const text = cell.document.getText();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 0) {
      const first = lines[0].replace(/^#+\s*/, '').trim();
      if (first) {
        return first.length > 80 ? `${first.slice(0, 77)}…` : first;
      }
    }
    return `Cell ${index + 1}`;
  }

  private getNotebookCellPreview(cell: vscode.NotebookCell): string {
    const text = cell.document.getText().trim();
    if (!text) {
      return 'Empty cell';
    }
    const snippet = text.replace(/\s+/g, ' ').slice(0, 120);
    return snippet.length < text.length ? `${snippet}…` : snippet;
  }

  private async createNotebookSection(
    notebookUri: vscode.Uri,
    notebook: vscode.NotebookDocument,
    entry: AnnotationEntry
  ): Promise<{ cell: vscode.NotebookCell; index: number; document: vscode.NotebookDocument } | undefined> {
    const defaultTitle = entry.content.trim().slice(0, 60) || `Page ${entry.page}`;
    const title = await vscode.window.showInputBox({
      prompt: 'Title for the new notebook section',
      value: defaultTitle
    });

    if (title === undefined) {
      return undefined;
    }

    const trimmedTitle = title.trim() || defaultTitle;
    const content = this.buildNotebookCellContent(trimmedTitle, entry);
    const cellData = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      content,
      'markdown'
    );

    const insertionIndex = notebook.cellCount;
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(notebookUri, [
      vscode.NotebookEdit.insertCells(insertionIndex, [cellData])
    ]);

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      vscode.window.showErrorMessage('Failed to insert a new notebook cell.');
      return undefined;
    }

    const updatedDocument = await vscode.workspace.openNotebookDocument(notebookUri);
    const cell = updatedDocument.cellAt(Math.min(insertionIndex, updatedDocument.cellCount - 1));
    return { cell, index: insertionIndex, document: updatedDocument };
  }

  private buildNotebookCellContent(title: string, entry: AnnotationEntry): string {
    const header = title.startsWith('#') ? title : `## ${title}`;
    const body = entry.content.trim();
    return body ? `${header}\n\n${body}\n` : `${header}\n`;
  }

  private async openNotebookLink(link: NotebookLink): Promise<void> {
    const targetUri = this.tryParseUri(link.notebookUri);
    if (!targetUri) {
      throw new Error('Notebook link is invalid.');
    }

    const notebookDocument = await vscode.workspace.openNotebookDocument(targetUri);
    const editor = await vscode.window.showNotebookDocument(notebookDocument, {
      preview: false
    });

    const resolvedIndex = this.resolveNotebookCellIndex(notebookDocument, link);
    if (resolvedIndex >= 0) {
      const range = new vscode.NotebookRange(resolvedIndex, resolvedIndex + 1);
      editor.selections = [range];
      editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
    }
  }

  private resolveNotebookCellIndex(document: vscode.NotebookDocument, link: NotebookLink): number {
    if (link.cellUri) {
      const index = document
        .getCells()
        .findIndex(cell => cell.document.uri.toString() === link.cellUri);
      if (index >= 0) {
        return index;
      }
    }

    if (typeof link.cellIndex === 'number' && link.cellIndex >= 0) {
      const normalized = Math.trunc(link.cellIndex);
      if (normalized < document.cellCount) {
        return normalized;
      }
    }

    const targetLabel = this.normalizeNotebookCellLabel(link.cellLabel);
    if (targetLabel) {
      const index = document
        .getCells()
        .findIndex((cell, position) => {
          const label = this.normalizeNotebookCellLabel(this.getNotebookCellLabel(cell, position));
          return Boolean(label) && label === targetLabel;
        });
      if (index >= 0) {
        return index;
      }
    }

    return -1;
  }

  private normalizeNotebookCellLabel(label?: string): string {
    if (typeof label !== 'string') {
      return '';
    }

    const trimmed = label.trim();
    if (!trimmed || /^cell\s+\d+$/i.test(trimmed)) {
      return '';
    }

    return trimmed.replace(/\s+/g, ' ').toLowerCase();
  }

  private extractNotebookLink(message: unknown): NotebookLink | undefined {
    if (typeof message !== 'object' || message === null) {
      return undefined;
    }

    const payload = message as { link?: unknown };
    if (!payload.link || typeof payload.link !== 'object') {
      return undefined;
    }

    const candidate = payload.link as Record<string, unknown>;
    const notebookUri = typeof candidate.notebookUri === 'string' ? candidate.notebookUri.trim() : '';
    if (!notebookUri) {
      return undefined;
    }

    const link: NotebookLink = { notebookUri };
    if (typeof candidate.notebookLabel === 'string' && candidate.notebookLabel.trim()) {
      link.notebookLabel = candidate.notebookLabel.trim();
    }
    if (typeof candidate.cellUri === 'string' && candidate.cellUri.trim()) {
      link.cellUri = candidate.cellUri.trim();
    }
    if (typeof candidate.cellLabel === 'string' && candidate.cellLabel.trim()) {
      link.cellLabel = candidate.cellLabel.trim();
    }
    if (typeof candidate.cellIndex === 'number' && Number.isFinite(candidate.cellIndex)) {
      link.cellIndex = Math.max(0, Math.trunc(candidate.cellIndex));
    }
    return link;
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
    mode: 'remove' | 'edit' | 'link'
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
    mode: 'remove' | 'edit' | 'link'
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

    const action =
      mode === 'remove' ? 'remove' : mode === 'link' ? 'link to a notebook' : 'edit';
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
      .map(entry => ({
        page: Math.trunc(entry.page),
        content: entry.content.trim(),
        notebookLink: this.normalizeNotebookLink(entry.notebookLink)
      }));

    filtered.sort((a, b) => {
      if (a.page === b.page) {
        return a.content.localeCompare(b.content);
      }
      return a.page - b.page;
    });

    return filtered;
  }

  private normalizeNotebookLink(link?: NotebookLink): NotebookLink | undefined {
    if (!link || typeof link !== 'object') {
      return undefined;
    }

    const notebookUri = typeof link.notebookUri === 'string' ? link.notebookUri.trim() : '';
    if (!notebookUri) {
      return undefined;
    }

    const normalized: NotebookLink = { notebookUri };

    if (typeof link.notebookLabel === 'string') {
      const label = link.notebookLabel.trim();
      if (label) {
        normalized.notebookLabel = label;
      }
    }

    if (typeof link.cellUri === 'string') {
      const cellUri = link.cellUri.trim();
      if (cellUri) {
        normalized.cellUri = cellUri;
      }
    }

    if (typeof link.cellLabel === 'string') {
      const cellLabel = link.cellLabel.trim();
      if (cellLabel) {
        normalized.cellLabel = cellLabel;
      }
    }

    if (typeof link.cellIndex === 'number' && Number.isFinite(link.cellIndex)) {
      normalized.cellIndex = Math.max(0, Math.trunc(link.cellIndex));
    }

    return normalized;
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
      notes: state.notes.map(note => ({
        ...note,
        notebookLink: note.notebookLink ? { ...note.notebookLink } : undefined
      })),
      quotes: state.quotes.map(quote => ({
        ...quote,
        notebookLink: quote.notebookLink ? { ...quote.notebookLink } : undefined
      })),
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

  async updateBookmarkStyle(style: BookmarkBorderStyle): Promise<void> {
    if (this.currentBookmarkStyle === style) {
      return;
    }

    this.currentBookmarkStyle = style;
    await this.context.globalState.update('dunkelpdf.bookmarkBorderStyle', style);
    this.sendBookmarkStyle();
  }

  private sendBookmarkStyle(target?: vscode.WebviewPanel) {
    const message = { type: 'setBookmarkStyle', style: this.currentBookmarkStyle };

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
        <body
          data-theme="regular"
          data-bookmark-style="pulse"
          data-pdfjs-lib="${pdfJsUri}"
          data-pdfjs-worker="${pdfWorkerUri}"
        >
          <header class="toolbar">
            <div class="toolbar__group">
              <button data-action="prev" title="Previous page">◀</button>
              <span class="page-info"><span id="pageNumber">1</span> / <span id="pageCount">1</span></span>
              <form id="pageJumpForm" class="toolbar__page-jump" autocomplete="off" novalidate>
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
                <span class="toolbar__search-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                    <circle cx="11" cy="11" r="6" />
                    <line x1="16.5" y1="16.5" x2="21" y2="21" />
                  </svg>
                </span>
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
                <section
                  class="annotation-sidebar__section"
                  aria-labelledby="annotationNotebookLinksTitle"
                >
                  <header class="annotation-sidebar__section-header">
                    <h2
                      id="annotationNotebookLinksTitle"
                      class="annotation-sidebar__section-title"
                    >
                      Jupyter Notebook
                    </h2>
                    <span
                      id="annotationNotebookLinksCount"
                      class="annotation-sidebar__count"
                      aria-live="polite"
                    >
                      0
                    </span>
                  </header>
                  <ul
                    id="annotationNotebookLinksList"
                    class="annotation-sidebar__list"
                    role="list"
                    aria-describedby="annotationNotebookLinksEmpty"
                  ></ul>
                  <p
                    id="annotationNotebookLinksEmpty"
                    class="annotation-sidebar__empty"
                    role="note"
                  >
                    Jupyter Notebook entries you add will show up here.
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
            <button
              type="button"
              role="menuitem"
              data-command="linkNotebook"
              aria-describedby="contextMenuDescription"
              aria-hidden="true"
              hidden
            >
              Link to Jupyter Notebook
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

function isBookmarkBorderStyle(value: unknown): value is BookmarkBorderStyle {
  return value === 'pulse' || value === 'moving';
}
