# website-demos

A showcase repository of self-contained **static demo websites**, served via
GitHub Pages. A data-driven gallery landing page ("The Showroom") indexes every
demo from a single manifest.

No build tooling, no npm, no dependencies — just HTML, CSS, and a little vanilla
JavaScript. Every path inside a demo is **relative**, so the whole thing works
correctly under a GitHub Pages subpath.

## Structure

```
.
├── index.html          # Gallery landing page — fetches demos.json, renders a card per demo
├── demos.json          # The manifest: array of { slug, name, description, thumbnail }
├── shared/
│   └── reset.css       # Minimal CSS reset used by the gallery (truly universal files only)
├── demos/
│   └── hello-showroom/  # Example demo — self-contained hero landing page
│       ├── index.html
│       ├── style.css
│       └── assets/
│           └── thumbnail.svg
├── README.md
└── CLAUDE.md
```

Each demo lives in its own folder under `demos/` and is fully self-contained:
its own HTML, its own CSS, its own assets, relative paths only.

## Preview locally

The gallery loads `demos.json` at runtime via `fetch()`, which browsers block
when a page is opened directly from disk (`file://`). Serve it over HTTP
instead — from the repo root:

```
python3 -m http.server
```

Then open <http://localhost:8000>. (If you open `index.html` straight from disk,
the gallery detects the failure and shows a message telling you to do this.)

## How to add a new demo

1. Create a folder under `demos/` named after your demo's slug, e.g.
   `demos/my-cool-demo/`.
2. Build a self-contained static site inside it — `index.html`, its own CSS, any
   assets. **Use relative paths only** (`./style.css`, `assets/x.png`).
3. Add an entry to `demos.json`:

   ```json
   {
     "slug": "my-cool-demo",
     "name": "My Cool Demo",
     "description": "One line describing what it shows.",
     "thumbnail": "./demos/my-cool-demo/assets/thumbnail.svg"
   }
   ```

That's it — the gallery picks it up automatically on next load.
