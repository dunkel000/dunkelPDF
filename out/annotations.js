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
                lines.push(`- Page ${note.page}: ${note.content}`);
            }
            lines.push('');
        }
        lines.push('## Quotes');
        if (state.quotes.length === 0) {
            lines.push('- _None_', '');
        }
        else {
            for (const quote of state.quotes) {
                lines.push(`- Page ${quote.page}: ${quote.content}`);
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