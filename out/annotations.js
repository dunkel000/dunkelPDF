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
exports.AnnotationManager = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const util_1 = require("util");
class AnnotationManager {
    constructor() {
        this.encoder = new util_1.TextEncoder();
        this.decoder = new util_1.TextDecoder();
    }
    async annotationFileExists(documentUri) {
        const annotationUri = this.getAnnotationUri(documentUri);
        return this.fileExists(annotationUri);
    }
    getAnnotationUri(documentUri) {
        if (documentUri.scheme !== 'file') {
            return documentUri.with({ path: `${documentUri.path}.dk.md` });
        }
        const parsed = path.parse(documentUri.fsPath);
        const annotationPath = path.join(parsed.dir, `${parsed.name}.dk.md`);
        return vscode.Uri.file(annotationPath);
    }
    createEmptyState() {
        return {
            notes: [],
            quotes: [],
            bookmarks: []
        };
    }
    async load(documentUri) {
        const annotationUri = this.getAnnotationUri(documentUri);
        if (!(await this.fileExists(annotationUri))) {
            return this.createEmptyState();
        }
        const fileData = await vscode.workspace.fs.readFile(annotationUri);
        const content = this.decoder.decode(fileData);
        return this.parseMarkdown(content);
    }
    async save(documentUri, state) {
        const annotationUri = this.getAnnotationUri(documentUri);
        const markdown = this.generateMarkdown(state, documentUri);
        await vscode.workspace.fs.writeFile(annotationUri, this.encoder.encode(markdown));
    }
    parseMarkdown(content) {
        const state = this.createEmptyState();
        const lines = content.split(/\r?\n/);
        let currentSection = null;
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
                const entry = { page, content: contentText };
                const normalizedLink = this.normalizeNotebookLink(notebookLink);
                if (normalizedLink) {
                    entry.notebookLink = normalizedLink;
                }
                state[currentSection].push(entry);
            }
            else if (currentSection === 'bookmarks') {
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
    resolveSectionType(line) {
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
        if (normalized.startsWith('bookmark') ||
            normalized.startsWith('mark') ||
            normalized.startsWith('favourite') ||
            normalized.startsWith('favorite')) {
            return 'bookmarks';
        }
        return null;
    }
    async fileExists(uri) {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        }
        catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                return false;
            }
            throw error;
        }
    }
    generateMarkdown(state, documentUri) {
        const lines = [];
        const title = documentUri
            ? `# Annotations for ${this.getDisplayName(documentUri)}`
            : '# Annotations';
        lines.push(title, '');
        lines.push('## Notes');
        if (state.notes.length === 0) {
            lines.push('- _None_', '');
        }
        else {
            for (const note of state.notes) {
                lines.push(this.formatAnnotationLine(note, documentUri));
            }
            lines.push('');
        }
        lines.push('## Quotes');
        if (state.quotes.length === 0) {
            lines.push('- _None_', '');
        }
        else {
            for (const quote of state.quotes) {
                lines.push(this.formatAnnotationLine(quote, documentUri));
            }
            lines.push('');
        }
        lines.push('## Bookmarks');
        if (state.bookmarks.length === 0) {
            lines.push('- _None_', '');
        }
        else {
            for (const page of state.bookmarks) {
                lines.push(`- Page ${page}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }
    formatAnnotationLine(entry, documentUri) {
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
    stripNotebookDisplayTag(content, hadNotebookLink) {
        if (!hadNotebookLink) {
            return content.trim();
        }
        const withoutDisplay = content.replace(/\[Notebook:[^\]]*\]\s*$/i, '');
        return withoutDisplay.trim();
    }
    extractNotebookLinkMetadata(rawLine) {
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
    parseNotebookLinkPayload(payload) {
        try {
            const parsed = JSON.parse(payload);
            if (!parsed || typeof parsed !== 'object') {
                return undefined;
            }
            const notebookUri = typeof parsed.notebookUri === 'string'
                ? parsed.notebookUri.trim()
                : '';
            if (!notebookUri) {
                return undefined;
            }
            const link = { notebookUri };
            if (typeof parsed.notebookLabel === 'string') {
                const label = parsed.notebookLabel.trim();
                if (label) {
                    link.notebookLabel = label;
                }
            }
            if (typeof parsed.cellUri === 'string') {
                const cellUri = parsed.cellUri.trim();
                if (cellUri) {
                    link.cellUri = cellUri;
                }
            }
            if (typeof parsed.cellLabel === 'string') {
                const cellLabel = parsed.cellLabel.trim();
                if (cellLabel) {
                    link.cellLabel = cellLabel;
                }
            }
            if (typeof parsed.cellIndex === 'number') {
                const rawIndex = parsed.cellIndex;
                if (Number.isFinite(rawIndex)) {
                    link.cellIndex = Math.max(0, Math.trunc(rawIndex));
                }
            }
            return link;
        }
        catch (error) {
            console.error('Failed to parse notebook link metadata from annotations', error);
            return undefined;
        }
    }
    encodeNotebookLink(link) {
        const payload = { notebookUri: link.notebookUri };
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
    formatNotebookDisplay(link, documentUri) {
        const label = link.notebookLabel?.trim() || this.deriveNotebookLabel(link.notebookUri, documentUri);
        const cellLabel = link.cellLabel?.trim();
        if (label && cellLabel) {
            return `${label} • ${cellLabel}`;
        }
        return label || cellLabel || '';
    }
    deriveNotebookLabel(notebookUri, documentUri) {
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
        }
        catch (error) {
            console.error('Failed to derive notebook label for annotation metadata', error);
        }
        return notebookUri;
    }
    normalizeNotebookLink(link) {
        if (!link || typeof link !== 'object') {
            return undefined;
        }
        const notebookUri = typeof link.notebookUri === 'string' ? link.notebookUri.trim() : '';
        if (!notebookUri) {
            return undefined;
        }
        const normalized = { notebookUri };
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
    getDisplayName(documentUri) {
        if (documentUri.scheme === 'file') {
            return path.basename(documentUri.fsPath);
        }
        const parsed = path.parse(documentUri.path);
        return parsed.base || documentUri.path;
    }
}
exports.AnnotationManager = AnnotationManager;
//# sourceMappingURL=annotations.js.map