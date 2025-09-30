import * as vscode from 'vscode';

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
  private currentTheme: ViewerTheme;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.currentTheme = context.globalState.get<ViewerTheme>('dunkelpdf.theme', 'regular');
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
    panel.onDidDispose(() => this.panels.delete(panel));

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    panel.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case 'ready': {
          const fileData = await vscode.workspace.fs.readFile(document.uri);
          const base64 = Buffer.from(fileData).toString('base64');
          panel.webview.postMessage({ type: 'loadPdf', data: base64 });
          this.sendTheme(panel);
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
        default:
          break;
      }
    });

    panel.webview.html = this.getHtml(panel.webview);
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
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'));
    const cspSource = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource}; script-src ${cspSource} https://unpkg.com; font-src ${cspSource};" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="${styleUri}" />
          <title>Dunkel PDF Viewer</title>
        </head>
        <body data-theme="regular">
          <header class="toolbar">
            <div class="toolbar__group">
              <button data-action="prev" title="Previous page">◀</button>
              <span class="page-info"><span id="pageNumber">1</span> / <span id="pageCount">1</span></span>
              <button data-action="next" title="Next page">▶</button>
            </div>
            <div class="toolbar__group">
              <button data-theme="regular">Regular</button>
              <button data-theme="dark">Dark</button>
              <button data-theme="paper">Paper Sand</button>
            </div>
            <div class="toolbar__group">
              <input id="zoomRange" type="range" min="50" max="200" value="100" />
              <span id="zoomValue">100%</span>
            </div>
          </header>
          <main>
            <canvas id="pdfCanvas"></canvas>
          </main>
          <script src="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.js"></script>
          <script src="${scriptUri}"></script>
        </body>
      </html>`;
  }
}

function isViewerTheme(value: unknown): value is ViewerTheme {
  return value === 'dark' || value === 'paper' || value === 'regular';
}
