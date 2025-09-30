# Dunkel PDF Viewer

Dunkel PDF Viewer is a Visual Studio Code extension that renders PDFs in a themed webview. It ships with three viewing modes—Regular, Dark, and Paper Sand—so you can choose the reading experience that best matches your environment.

## Features

- Registers as a custom editor for `.pdf` files inside VS Code.
- Toolbar controls for page navigation, zoom, and theme switching.
- Global commands to change the preferred PDF theme from the command palette.
- Remembers the last selected theme across workspaces.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (includes npm).
- [Visual Studio Code](https://code.visualstudio.com/) 1.85.0 or newer.
- (For publishing) A [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) publisher ID and a Personal Access Token (PAT).

### Install dependencies

From the project root (the folder that contains `package.json`):

```bash
npm install
```

### Compile the extension

Build the TypeScript sources into the `out/` directory:

Run from the same project root:

```bash
npm run compile
```

To recompile automatically on file changes:

```bash
npm run watch
```

### Troubleshooting

- **`npm ERR! enoent ENOENT: no such file or directory, open '.../package.json'`** – Run the npm commands from the Dunkel PDF project folder (the same directory that contains `package.json`). This error occurs when you execute `npm install` or `npm run compile` from a different path.

### Launch the extension in VS Code

1. Open the project folder in VS Code.
2. Press <kbd>F5</kbd> or run the **Debug: Start Debugging** command to open an Extension Development Host window.
3. Open any PDF file in the development host—VS Code will prompt you to use the **Dunkel PDF Viewer**.

### Commands

- `Dunkel PDF: Use Regular Theme`
- `Dunkel PDF: Use Dark Theme`
- `Dunkel PDF: Use Paper Sand Theme`

These commands update every open Dunkel PDF panel to use the selected theme. The same theme buttons are also available inside the viewer toolbar.

## Packaging and Publishing

1. **Sign in (first time only):** Create or select a publisher on the [VS Code Marketplace](https://marketplace.visualstudio.com/manage). Generate a Personal Access Token (PAT) with the `Marketplace (Publish)` scope.
2. **Login with vsce:**
   ```bash
   npx vsce login <publisher-name>
   ```
   When prompted, paste the PAT you generated in the previous step.
3. **Update `publisher` in `package.json`:** Replace the placeholder value (`"your-name"`) with the publisher identifier from the Marketplace.
4. **Bump the version:** Update the `version` field in `package.json` according to semantic versioning rules.
5. **Package the extension:**
   ```bash
   npm run package
   ```
   This creates a `.vsix` file you can share or upload manually.
6. **Publish to the Marketplace:**
   ```bash
   npx vsce publish
   ```

## Editing Tips

- All extension source code lives in `src/`. The entry point is `src/extension.ts`.
- Static assets for the webview live in `media/` (`viewer.js` and `viewer.css`).
- The PDF rendering relies on [`pdf.js`](https://mozilla.github.io/pdf.js/) loaded from a CDN. If you need offline support, bundle the library into the `media/` folder and update the script paths in `src/extension.ts`.
- For additional commands or configuration options, extend the `contributes` section in `package.json` and update the viewer script to listen for new messages.

## Testing Ideas

- Open a variety of PDF files and verify that each theme renders correctly.
- Confirm that zooming and page navigation work for multi-page documents.
- Test switching themes via both the toolbar buttons and the command palette.
- Disable your network connection and ensure PDFs cached by VS Code still render (if offline support is required, bundle `pdf.js`).

## License

This project is provided under the [MIT License](LICENSE) by default. Update the license file and metadata if you intend to distribute under different terms.
