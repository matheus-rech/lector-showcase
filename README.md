# lector showcase

Single-file (~2.5 MB) React + pdfjs-dist PDF reader with:
- Drag-rectangle highlights in 4 colors with auto-extracted source quote + PDF coordinates (provenance trail)
- Search panel: text / fuzzy / regex modes — paints overlays directly on the rendered PDF
- Schema-driven extraction: paste a JSON schema (or use the default) and pull title / DOI / year / authors / abstract / keywords / custom regex fields
- MiniMap with proportional pages + colored highlight pills + click-to-jump
- Editorial paper / ink / brass theme (Fraunces + IBM Plex Sans + JetBrains Mono)
- Light + dark mode, zoom, page nav, JSON export

Open `index.html` in any modern browser. Drop a PDF anywhere on the window.

Built with Vite + React + TypeScript + Tailwind, bundled to a single HTML file via Parcel + html-inline.
