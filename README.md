# Dunkel PDF Viewer

Bring PDF reading into your Visual Studio Code workspace with a viewer that adapts to the way you work. Dunkel PDF Viewer replaces the stock PDF preview with a themed experience that keeps you focused whether you are reviewing contracts, design specs, or research papers.

## Why Dunkel?
- **Three crafted themes** – Switch instantly between Regular, Dark, and Sand modes to match your environment or reduce eye strain.
- **Full toolbar control** – Navigate pages, adjust zoom, and toggle themes without leaving the editor.
- **Command Palette ready** – Invoke theme commands globally so every open viewer updates in one step.
- **Persistent preferences** – The extension remembers your last-used theme across workspaces.

## Installation
1. Open the **Extensions** view in VS Code (`Ctrl+Shift+X` or `Cmd+Shift+X`).
2. Search for **"Dunkel PDF Viewer"** and choose **Install**.
3. Open any `.pdf` file and select **Dunkel PDF Viewer** when prompted to use the custom editor.

> **Tip:** Already using another PDF extension? Right-click a PDF in the Explorer and choose **Open With...** to make Dunkel the default.

## How It Works
- The extension registers as a custom editor for PDF files.
- When you open a PDF, a lightweight webview renders the document and exposes a toolbar for navigation, zoom, and theme selection.
- Global commands mirror the toolbar actions so you can script or keybind your preferred workflow.

## Commands
- `Dunkel PDF: Use Regular Theme`
- `Dunkel PDF: Use Dark Theme`
- `Dunkel PDF: Use Sand Theme`

Each command applies instantly to every active Dunkel PDF panel.

## Requirements
- Visual Studio Code **1.85.0** or newer
- No additional dependencies

## Development & Contribution
1. Clone the repository and install dependencies with `npm install`.
2. Run `npm run compile` (or `npm run watch`) to build the TypeScript sources.
3. Press `F5` in VS Code to launch an Extension Development Host and try the viewer against your own PDFs.

Pull requests are welcome—focus on accessibility improvements, new themes, or workflow enhancements.

## Publish Your Fork
Want to ship a customized version? Update the `publisher` field in `package.json`, bump the version, then run:
```bash
npx vsce login <publisher>
npm run package
npx vsce publish
```
A ready-to-use `.vscodeignore` keeps the VSIX lightweight for Marketplace uploads.

## License
Dunkel PDF Viewer is released under the [MIT License](LICENSE).
