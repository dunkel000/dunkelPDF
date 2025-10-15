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
exports.resolveNotebookUri = resolveNotebookUri;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
async function defaultFileExists(uri) {
    const workspaceFs = vscode.workspace?.fs;
    if (workspaceFs && typeof workspaceFs.stat === 'function') {
        try {
            await workspaceFs.stat(uri);
            return true;
        }
        catch (error) {
            // Fall back to filesystem check below.
        }
    }
    if (uri.scheme === 'file') {
        return fs.existsSync(uri.fsPath);
    }
    return false;
}
function isWindowsDrivePath(value) {
    return /^[A-Za-z]:[\\/]/.test(value);
}
function normalizeWorkspaceRelativePath(value) {
    return value
        .replace(/^[/\\]+/, '')
        .split(/[/\\]+/)
        .filter(segment => segment.length > 0);
}
async function resolveNotebookUri(value, baseUri, options = {}) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const fileExists = options.fileExists ?? defaultFileExists;
    const workspaceFolders = options.workspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
    const candidates = [];
    const seen = new Set();
    let fallback;
    const addCandidate = (candidate) => {
        if (!candidate) {
            return;
        }
        const key = candidate.toString();
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(candidate);
        }
        if (!fallback) {
            fallback = candidate;
        }
    };
    let parsed;
    try {
        parsed = vscode.Uri.parse(trimmed, true);
    }
    catch (error) {
        // Ignore parse errors and continue with other strategies.
    }
    if (parsed?.scheme) {
        if (parsed.scheme === 'file') {
            addCandidate(parsed);
        }
        else if (isWindowsDrivePath(trimmed)) {
            addCandidate(vscode.Uri.file(trimmed));
        }
        else {
            return parsed;
        }
    }
    else if (isWindowsDrivePath(trimmed) || path.isAbsolute(trimmed)) {
        addCandidate(vscode.Uri.file(trimmed));
    }
    if (baseUri?.scheme === 'file') {
        const baseDir = path.dirname(baseUri.fsPath);
        const resolved = path.resolve(baseDir, trimmed);
        addCandidate(vscode.Uri.file(resolved));
    }
    if (workspaceFolders.length > 0) {
        const segments = normalizeWorkspaceRelativePath(trimmed);
        for (const folder of workspaceFolders) {
            if (folder.uri.scheme !== 'file') {
                continue;
            }
            const candidate = vscode.Uri.joinPath(folder.uri, ...segments);
            addCandidate(candidate);
        }
    }
    for (const candidate of candidates) {
        if (candidate.scheme !== 'file') {
            return candidate;
        }
        try {
            if (await fileExists(candidate)) {
                return candidate;
            }
        }
        catch (error) {
            // Ignore errors from the existence probe and continue.
        }
    }
    return fallback;
}
//# sourceMappingURL=notebookUriResolver.js.map