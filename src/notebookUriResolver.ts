import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface NotebookUriResolverOptions {
  fileExists?: (uri: vscode.Uri) => Promise<boolean>;
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
}

async function defaultFileExists(uri: vscode.Uri): Promise<boolean> {
  const workspaceFs = vscode.workspace?.fs;
  if (workspaceFs && typeof workspaceFs.stat === 'function') {
    try {
      await workspaceFs.stat(uri);
      return true;
    } catch (error) {
      // Fall back to filesystem check below.
    }
  }

  if (uri.scheme === 'file') {
    return fs.existsSync(uri.fsPath);
  }

  return false;
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeWorkspaceRelativePath(value: string): string[] {
  return value
    .replace(/^[/\\]+/, '')
    .split(/[/\\]+/)
    .filter(segment => segment.length > 0);
}

export async function resolveNotebookUri(
  value: string | undefined,
  baseUri?: vscode.Uri,
  options: NotebookUriResolverOptions = {}
): Promise<vscode.Uri | undefined> {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const fileExists = options.fileExists ?? defaultFileExists;
  const workspaceFolders = options.workspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
  const candidates: vscode.Uri[] = [];
  const seen = new Set<string>();
  let fallback: vscode.Uri | undefined;

  const addCandidate = (candidate: vscode.Uri | undefined) => {
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

  let parsed: vscode.Uri | undefined;
  try {
    parsed = vscode.Uri.parse(trimmed, true);
  } catch (error) {
    // Ignore parse errors and continue with other strategies.
  }

  if (parsed?.scheme) {
    if (parsed.scheme === 'file') {
      addCandidate(parsed);
    } else if (isWindowsDrivePath(trimmed)) {
      addCandidate(vscode.Uri.file(trimmed));
    } else {
      return parsed;
    }
  } else if (isWindowsDrivePath(trimmed) || path.isAbsolute(trimmed)) {
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
    } catch (error) {
      // Ignore errors from the existence probe and continue.
    }
  }

  return fallback;
}
