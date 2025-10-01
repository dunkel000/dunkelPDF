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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
class SimplePdfDocument {
    constructor(uri) {
        this.uri = uri;
    }
    dispose() {
        // nothing to dispose
    }
}
function activate(context) {
    const provider = new PdfViewerProvider(context);
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('dunkelpdf.viewer', provider, {
        supportsMultipleEditorsPerDocument: true
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dunkelpdf.theme.dark', () => provider.updateTheme('dark')));
    context.subscriptions.push(vscode.commands.registerCommand('dunkelpdf.theme.paper', () => provider.updateTheme('paper')));
    context.subscriptions.push(vscode.commands.registerCommand('dunkelpdf.theme.regular', () => provider.updateTheme('regular')));
}
function deactivate() {
    // Nothing to do here
}
class PdfViewerProvider {
    constructor(context) {
        this.context = context;
        this.panels = new Set();
        this.currentTheme = context.globalState.get('dunkelpdf.theme', 'regular');
    }
    async openCustomDocument(uri, _openContext, _token) {
        return new SimplePdfDocument(uri);
    }
    async resolveCustomEditor(document, panel) {
        this.panels.add(panel);
        panel.onDidDispose(() => this.panels.delete(panel));
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };
        panel.webview.onDidReceiveMessage(async (message) => {
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
    async updateTheme(theme) {
        if (this.currentTheme === theme) {
            return;
        }
        this.currentTheme = theme;
        await this.context.globalState.update('dunkelpdf.theme', theme);
        this.sendTheme();
    }
    sendTheme(target) {
        const message = { type: 'setTheme', theme: this.currentTheme };
        if (target) {
            target.webview.postMessage(message);
            return;
        }
        for (const panel of this.panels) {
            panel.webview.postMessage(message);
        }
    }
    getHtml(webview) {
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
            <div id="pdfContainer" class="pdf-container">
              <div class="placeholder">Open a PDF document to start viewing.</div>
            </div>
          </main>
          <script src="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.js"></script>
          <script src="${scriptUri}"></script>
        </body>
      </html>`;
    }
}
function isViewerTheme(value) {
    return value === 'dark' || value === 'paper' || value === 'regular';
}
//# sourceMappingURL=extension.js.map