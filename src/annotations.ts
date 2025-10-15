import * as path from 'path';
import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

export interface NotebookLink {
  notebookUri: string;
  notebookLabel?: string;
  cellUri?: string;
  cellLabel?: string;
  cellIndex?: number;
}

export interface AnnotationEntry {
  page: number;
  content: string;
  notebookLink?: NotebookLink;
}

export interface AnnotationState {
  notes: AnnotationEntry[];
  quotes: AnnotationEntry[];
  bookmarks: number[];
}

export class AnnotationManager {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  async annotationFileExists(documentUri: vscode.Uri): Promise<boolean> {
    const annotationUri = this.getAnnotationUri(documentUri);
    return this.fileExists(annotationUri);
  }

  getAnnotationUri(documentUri: vscode.Uri): vscode.Uri {
    if (documentUri.scheme !== 'file') {
      return documentUri.with({ path: `${documentUri.path}.dk.md` });
    }

    const parsed = path.parse(documentUri.fsPath);
    const annotationPath = path.join(parsed.dir, `${parsed.name}.dk.md`);
    return vscode.Uri.file(annotationPath);
  }

  createEmptyState(): AnnotationState {
    return {
      notes: [],
      quotes: [],
      bookmarks: []
    };
  }

  async load(documentUri: vscode.Uri): Promise<AnnotationState> {
    const annotationUri = this.getAnnotationUri(documentUri);
    if (!(await this.fileExists(annotationUri))) {
      return this.createEmptyState();
    }

    const fileData = await vscode.workspace.fs.readFile(annotationUri);
    const content = this.decoder.decode(fileData);
    return this.parseMarkdown(content);
  }

  async save(documentUri: vscode.Uri, state: AnnotationState): Promise<void> {
    const annotationUri = this.getAnnotationUri(documentUri);
    const markdown = this.generateMarkdown(state, documentUri);
    await vscode.workspace.fs.writeFile(annotationUri, this.encoder.encode(markdown));
  }

  private parseMarkdown(content: string): AnnotationState {
    const state = this.createEmptyState();

    const lines = content.split(/\r?\n/);
    let currentSection: 'notes' | 'quotes' | 'bookmarks' | null = null;

    for (const rawLine of lines) {
      const { normalizedLine, notebookLink } = this.extractNotebookLinkMetadata(rawLine);
      const line = normalizedLine.trim();
      if (!line) {
        continue;
      }

      if (line.startsWith('## ')) {
        currentSection = this.resolveSectionType(line);
        continue;
      }

      if (!line.startsWith('-')) {
        continue;
      }

      if (currentSection === 'notes' || currentSection === 'quotes') {
        const match = /^-\s*Page\s+(\d+)\s*:\s*(.*)$/.exec(line);
        if (!match) {
          continue;
        }
        const page = Number.parseInt(match[1], 10);
        if (Number.isNaN(page)) {
          continue;
        }
        const contentText = this.stripNotebookDisplayTag(match[2], Boolean(notebookLink));
        const entry: AnnotationEntry = { page, content: contentText };
        const normalizedLink = this.normalizeNotebookLink(notebookLink);
        if (normalizedLink) {
          entry.notebookLink = normalizedLink;
        }
        state[currentSection].push(entry);
      } else if (currentSection === 'bookmarks') {
        const match = /^-\s*Page\s+(\d+)\s*$/.exec(line);
        if (!match) {
          continue;
        }
        const page = Number.parseInt(match[1], 10);
        if (!Number.isNaN(page)) {
          state.bookmarks.push(page);
        }
      }
    }

    state.notes.sort((a, b) => a.page - b.page);
    state.quotes.sort((a, b) => a.page - b.page);
    state.bookmarks.sort((a, b) => a - b);

    return state;
  }

  private resolveSectionType(line: string): 'notes' | 'quotes' | 'bookmarks' | null {
    const normalized = line
      .replace(/^##\s*/i, '')
      .replace(/[()]/g, ' ')
      .toLowerCase()
      .trim();

    if (!normalized) {
      return null;
    }

    if (normalized.startsWith('note')) {
      return 'notes';
    }

    if (normalized.startsWith('quote')) {
      return 'quotes';
    }

    if (
      normalized.startsWith('bookmark') ||
      normalized.startsWith('mark') ||
      normalized.startsWith('favourite') ||
      normalized.startsWith('favorite')
    ) {
      return 'bookmarks';
    }

    return null;
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return false;
      }
      throw error;
    }
  }

  private generateMarkdown(state: AnnotationState, documentUri?: vscode.Uri): string {
    const lines: string[] = [];
    const title = documentUri
      ? `# Annotations for ${this.getDisplayName(documentUri)}`
      : '# Annotations';
    lines.push(title, '');

    lines.push('## Notes');
    if (state.notes.length === 0) {
      lines.push('- _None_', '');
    } else {
      for (const note of state.notes) {
        lines.push(this.formatAnnotationLine(note, documentUri));
      }
      lines.push('');
    }

    lines.push('## Quotes');
    if (state.quotes.length === 0) {
      lines.push('- _None_', '');
    } else {
      for (const quote of state.quotes) {
        lines.push(this.formatAnnotationLine(quote, documentUri));
      }
      lines.push('');
    }

    lines.push('## Bookmarks');
    if (state.bookmarks.length === 0) {
      lines.push('- _None_', '');
    } else {
      for (const page of state.bookmarks) {
        lines.push(`- Page ${page}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatAnnotationLine(entry: AnnotationEntry, documentUri?: vscode.Uri): string {
    const trimmedContent = entry.content.trim();
    const base = trimmedContent
      ? `- Page ${entry.page}: ${trimmedContent}`
      : `- Page ${entry.page}:`;
    if (!entry.notebookLink) {
      return base;
    }

    const display = this.formatNotebookDisplay(entry.notebookLink, documentUri);
    const parts = [base];
    if (display) {
      parts.push(` [Notebook: ${display}]`);
    }

    const encoded = this.encodeNotebookLink(entry.notebookLink);
    if (encoded) {
      parts.push(` <!--notebook-link ${encoded}-->`);
    }

    return parts.join('');
  }

  private stripNotebookDisplayTag(content: string, hadNotebookLink: boolean): string {
    if (!hadNotebookLink) {
      return content.trim();
    }

    const withoutDisplay = content.replace(/\[Notebook:[^\]]*\]\s*$/i, '');
    return withoutDisplay.trim();
  }

  private extractNotebookLinkMetadata(rawLine: string): {
    normalizedLine: string;
    notebookLink?: NotebookLink;
  } {
    const commentPattern = /<!--\s*notebook-link\s*(\{[^]*?\})\s*-->/i;
    const match = commentPattern.exec(rawLine);
    if (!match) {
      return { normalizedLine: rawLine };
    }

    const payload = match[1];
    const notebookLink = this.parseNotebookLinkPayload(payload);
    const normalizedLine = rawLine.replace(commentPattern, '');
    return { normalizedLine, notebookLink };
  }

  private parseNotebookLinkPayload(payload: string): NotebookLink | undefined {
    try {
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== 'object') {
        return undefined;
      }

      const notebookUri = typeof (parsed as { notebookUri?: unknown }).notebookUri === 'string'
        ? (parsed as { notebookUri: string }).notebookUri.trim()
        : '';
      if (!notebookUri) {
        return undefined;
      }

      const link: NotebookLink = { notebookUri };
      if (typeof (parsed as { notebookLabel?: unknown }).notebookLabel === 'string') {
        const label = (parsed as { notebookLabel: string }).notebookLabel.trim();
        if (label) {
          link.notebookLabel = label;
        }
      }
      if (typeof (parsed as { cellUri?: unknown }).cellUri === 'string') {
        const cellUri = (parsed as { cellUri: string }).cellUri.trim();
        if (cellUri) {
          link.cellUri = cellUri;
        }
      }
      if (typeof (parsed as { cellLabel?: unknown }).cellLabel === 'string') {
        const cellLabel = (parsed as { cellLabel: string }).cellLabel.trim();
        if (cellLabel) {
          link.cellLabel = cellLabel;
        }
      }
      if (typeof (parsed as { cellIndex?: unknown }).cellIndex === 'number') {
        const rawIndex = (parsed as { cellIndex: number }).cellIndex;
        if (Number.isFinite(rawIndex)) {
          link.cellIndex = Math.max(0, Math.trunc(rawIndex));
        }
      }
      return link;
    } catch (error) {
      console.error('Failed to parse notebook link metadata from annotations', error);
      return undefined;
    }
  }

  private encodeNotebookLink(link: NotebookLink): string {
    const payload: Record<string, unknown> = { notebookUri: link.notebookUri };
    if (link.notebookLabel) {
      payload.notebookLabel = link.notebookLabel;
    }
    if (link.cellUri) {
      payload.cellUri = link.cellUri;
    }
    if (link.cellLabel) {
      payload.cellLabel = link.cellLabel;
    }
    if (typeof link.cellIndex === 'number') {
      payload.cellIndex = link.cellIndex;
    }
    return JSON.stringify(payload);
  }

  private formatNotebookDisplay(link: NotebookLink, documentUri?: vscode.Uri): string {
    const label = link.notebookLabel?.trim() || this.deriveNotebookLabel(link.notebookUri, documentUri);
    const cellLabel = link.cellLabel?.trim();

    if (label && cellLabel) {
      return `${label} • ${cellLabel}`;
    }
    return label || cellLabel || '';
  }

  private deriveNotebookLabel(notebookUri: string, documentUri?: vscode.Uri): string {
    try {
      const uri = vscode.Uri.parse(notebookUri);
      if (uri.scheme === 'file') {
        const workspaceLabel = vscode.workspace.asRelativePath(uri, false);
        if (workspaceLabel && workspaceLabel !== notebookUri) {
          return workspaceLabel;
        }
        return path.basename(uri.fsPath);
      }

      if (documentUri?.scheme === uri.scheme) {
        const segments = uri.path.split('/').filter(Boolean);
        if (segments.length > 0) {
          return segments[segments.length - 1];
        }
      }
    } catch (error) {
      console.error('Failed to derive notebook label for annotation metadata', error);
    }

    return notebookUri;
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

  private getDisplayName(documentUri: vscode.Uri): string {
    if (documentUri.scheme === 'file') {
      return path.basename(documentUri.fsPath);
    }
    const parsed = path.parse(documentUri.path);
    return parsed.base || documentUri.path;
  }
}
