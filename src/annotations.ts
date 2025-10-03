import * as path from 'path';
import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

export interface AnnotationEntry {
  page: number;
  content: string;
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
      const line = rawLine.trim();
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
        const contentText = match[2].trim();
        state[currentSection].push({ page, content: contentText });
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
        lines.push(`- Page ${note.page}: ${note.content}`);
      }
      lines.push('');
    }

    lines.push('## Quotes');
    if (state.quotes.length === 0) {
      lines.push('- _None_', '');
    } else {
      for (const quote of state.quotes) {
        lines.push(`- Page ${quote.page}: ${quote.content}`);
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

  private getDisplayName(documentUri: vscode.Uri): string {
    if (documentUri.scheme === 'file') {
      return path.basename(documentUri.fsPath);
    }
    const parsed = path.parse(documentUri.path);
    return parsed.base || documentUri.path;
  }
}
