# Link Hover Reveal

An [Obsidian](https://obsidian.md) plugin that keeps markdown links collapsed to just their title text in Live Preview — even while your cursor moves through the document.

## Problem

By default, Obsidian's Live Preview expands a markdown link to its raw `[text](url)` form whenever the cursor touches it — including just landing on the edge of the link while arrowing between lines. If your notes are lists of links (e.g. bookmarks, task lists with reference URLs), reordering or navigating them causes constant, disruptive expand/collapse flicker.

## What it does

- Links render as plain title text, e.g. `[My bookmark title](https://example.com)` shows as just `My bookmark title`.
- The title is real, editable text — move the cursor through it and edit words freely with the keyboard.
- The `[`, `]`, `(url)` syntax stays hidden at all times; the cursor skips over it instead of landing inside, so navigating between lines never expands a link.
- Hover a link to see a small popup with the (truncated) URL and three actions: copy, open, and edit.

## Installation

### Community Plugins (recommended)

1. In Obsidian, go to **Settings → Community plugins → Browse**.
2. Search for **Link Hover Reveal**.
3. Click **Install**, then **Enable**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/link-hover-reveal/`.
3. Reload Obsidian and enable **Link Hover Reveal** in Community Plugins.

### From source

```bash
npm install --legacy-peer-deps
node esbuild.config.mjs production
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder as above.

## License

[MIT](LICENSE)
