# Dunkel PDF Viewer

Dunkel PDF Viewer brings calm, consistent PDF reading into Visual Studio Code. Open a document and you will find a focused interface that keeps the page front and centre while giving you quick controls for themes, zoom and lightweight annotations.

## Highlights
- **Three handcrafted looks** – Switch between Regular, Dark and Sand themes directly from the toolbar to match your lighting or preference.
- **Always-on toolbar** – Jump pages, fine-tune zoom or bookmark your current view without leaving the editor.
- **Right-click annotations** – Add notes, capture quotes, copy page text or mark a favourite page through an accessible context menu.
- **Auto-saved reading companion** – Notes, quotes and bookmarks sync into a side panel and are written to a Markdown file next to your PDF for later review.
- **Global theme commands** – Change every open Dunkel viewer at once from the Command Palette or your own keybindings.

## Quick start
1. Open the **Extensions** view in VS Code (`Ctrl` + `Shift` + `X` / `Cmd` + `Shift` + `X`).
2. Search for **Dunkel PDF Viewer** and click **Install**.
3. Open any `.pdf` file. When prompted, choose **Dunkel PDF Viewer** as the editor (you can make it the default via **Open With…**).

## Reading with Dunkel

### Navigate with ease
- Scroll naturally or use the ◀/▶ buttons to move one page at a time.
- A live indicator shows the current page and the total number of pages so you always know where you are.

### Control the view
- Use the zoom slider for quick scaling between 50 % and 200 %; the percentage readout updates in real time.
- Toggle between Regular, Dark and Sand themes from the toolbar. Dunkel remembers your last choice across workspaces.
- Prefer commands? Run `Dunkel PDF: Use Regular Theme`, `…Dark Theme`, or `…Sand Theme` from the Command Palette to apply a theme to every open viewer simultaneously.

### Capture what matters
- Right-click anywhere on a page to open the context menu.
  - **Add note** and **Add quote** prompt for text and pin it to the selected page.
  - **Toggle favourite** bookmarks the page so it stands out in the viewer and toolbar button.
  - **Copy page text** places the page’s text on your clipboard when available.
- An annotation column appears beside any page with saved notes or quotes, letting you skim your highlights as you read.
- Dunkel stores everything in a Markdown file (`<document>.dk.md`) next to your PDF so your annotations are portable, searchable and shareable outside the editor.

### Stay organised
- The bookmark button in the toolbar mirrors the context-menu favourite toggle, making it easy to mark the page you are viewing.
- Bookmarks, notes and quotes update instantly across all open tabs of the same document.

## Requirements
- Visual Studio Code **1.85.0** or newer
- No additional dependencies needed

## Need help?
Open an issue in the repository or contact the publisher through the VS Code Marketplace listing. Feedback on accessibility, readability or new theme ideas is always welcome.

## License
Dunkel PDF Viewer is released under the [MIT License](LICENSE).
