const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request === 'vscode') {
    return stubPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const { URI } = require('vscode-uri');
const { resolveNotebookUri } = require('../out/notebookUriResolver.js');

test('resolves existing absolute file paths', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-resolver-'));
  try {
    const notebookPath = path.join(tempDir, 'notes.ipynb');
    fs.writeFileSync(notebookPath, '# notebook');

    const resolved = await resolveNotebookUri(notebookPath);
    assert.ok(resolved, 'Expected a resolved URI');
    assert.equal(resolved.scheme, 'file');
    assert.equal(path.normalize(resolved.fsPath), path.normalize(notebookPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolves notebook paths relative to the PDF', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-resolver-'));
  try {
    const pdfDir = path.join(tempDir, 'papers');
    const notebookDir = path.join(pdfDir, 'notebooks');
    fs.mkdirSync(notebookDir, { recursive: true });

    const pdfUri = URI.file(path.join(pdfDir, 'paper.pdf'));
    const relativeNotebook = path.join('notebooks', 'summary.ipynb');
    const expectedPath = path.join(notebookDir, 'summary.ipynb');
    fs.writeFileSync(expectedPath, '# notes');

    const resolved = await resolveNotebookUri(relativeNotebook, pdfUri);
    assert.ok(resolved, 'Expected a resolved URI');
    assert.equal(resolved.scheme, 'file');
    assert.equal(path.normalize(resolved.fsPath), path.normalize(expectedPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolves notebook paths relative to the workspace root', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-resolver-'));
  try {
    const workspaceNotebook = path.join(tempDir, 'docs', 'workspace-notes.ipynb');
    fs.mkdirSync(path.dirname(workspaceNotebook), { recursive: true });
    fs.writeFileSync(workspaceNotebook, '# workspace');

    const vscode = require('vscode');
    vscode.workspace.workspaceFolders = [
      { uri: URI.file(tempDir) }
    ];

    const resolved = await resolveNotebookUri('docs/workspace-notes.ipynb');
    assert.ok(resolved, 'Expected a resolved URI');
    assert.equal(resolved.scheme, 'file');
    assert.equal(path.normalize(resolved.fsPath), path.normalize(workspaceNotebook));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
