# The `.dk.md` Annotation Format

The DunkelPDF extension writes your highlights, notes, and bookmarks to a Markdown
companion file whose name mirrors the original document with an added `.dk.md`
suffix (for example, `report.pdf` gains `report.dk.md`). The file always lives
next to the source document so that the two travel together when you move or
share the PDF.

## File structure

A `.dk.md` file is ordinary Markdown that follows a predictable section layout so
that the extension can load it back into the sidebar:

1. A title line: `# Annotations for <document name>`
2. A blank line for readability
3. Three sections introduced with second-level headings:
   - `## Notes`
   - `## Quotes`
   - `## Bookmarks`

Within each section the file contains simple bullet lists. When no entries exist
for a section the list consists of the placeholder `- _None_`. Otherwise each
bullet records the page number and, where applicable, free-form text that you
wrote while reading.

```markdown
# Annotations for experiment.pdf

## Notes
- Page 2: Double-check the variance calculation.
- Page 5: Compare methodology with Smith et al. 2021.

## Quotes
- Page 3: "This approach reduces memory pressure by 30%."

## Bookmarks
- Page 1
- Page 7
```

The format is intentionally simple Markdown so you can edit the file manually,
use standard diff tools, or sync it through Git without any special tooling.

## Supported entry types

The DunkelPDF annotation manager recognises three types of entries when parsing a
`.dk.md` file:

- **Notes** – free-form remarks pinned to a page (`- Page <number>: <text>`).
- **Quotes** – verbatim excerpts saved from the PDF (`- Page <number>: <text>`).
- **Bookmarks** – page references that only store the page number (`- Page <number>`).

Any other Markdown content is ignored by the parser, which keeps the format
forgiving if you want to add personal headings or comments outside the expected
sections. Entries are sorted automatically by page number when the file is read
back into the extension.

## Recommended usage

- Keep the `.dk.md` file in version control alongside the corresponding PDF so
your research notes remain searchable and reviewable.
- Because the format is Markdown, you can open it in any editor, share it with
collaborators, or process it with scripts that understand Markdown lists.
- If you remove a section or change its heading, the extension may not load
those entries, so retain the section titles or their synonyms (`Notes`, `Quotes`,
`Bookmarks`) when editing by hand.

By combining the PDF with this lightweight Markdown ledger, DunkelPDF preserves
context, annotations, and references in a portable, human-readable format.
