const fs = require('node:fs/promises');
const path = require('node:path');
const { URI } = require('vscode-uri');

function joinPath(base, ...segments) {
  const normalizedSegments = segments
    .map(segment => segment.replace(/^[/\\]+/, ''))
    .filter(segment => segment.length > 0);

  if (base.scheme === 'file') {
    const joinedFsPath = path.join(base.fsPath, ...normalizedSegments);
    return URI.file(joinedFsPath);
  }

  const joinedPath = path.posix.join(base.path || '/', ...normalizedSegments);
  return base.with({ path: joinedPath });
}

module.exports = {
  Uri: Object.assign(URI, { joinPath }),
  workspace: {
    fs: {
      stat: async uri => fs.stat(uri.fsPath)
    },
    workspaceFolders: []
  }
};
