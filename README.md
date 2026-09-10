# apertus-writer

A WYSIWYG-first markdown editor with AI autocomplete and chat, powered by Apertus models.

Unlike traditional markdown editors, there is no code/preview split — you edit the **rendered document directly** and it saves as markdown (`.md`).

## Features

- **Direct rich-text editing** of markdown documents (TipTap/ProseMirror), with markdown round-trip via `marked` + `turndown`
- **Code view switcher**: toggle to an editable raw-markdown view with **Ctrl-Shift-M** or the **</> Code** toolbar button; switching back re-parses into the WYSIWYG editor
- **Toolbar ribbon**: bold, italic, strikethrough, inline code, code blocks, headings 1–4, bullet/numbered lists, blockquotes, tables, images, horizontal rules, undo/redo
- **CSS style themes**: edit fonts, colors, sizes, and page width live; save/load themes as standalone `.css` files
- **AI autocomplete**: press **Ctrl-Space** and a ghost-text suggestion appears (grey italic); **Tab** accepts it, any other key or action dismisses it — or enable the toolbar's **✨ Auto** toggle to get suggestions automatically after a short typing pause (persists across sessions). Defaults to `apertus-v1.1-4b` on a local LM Studio Server. Reference documents attached via 📎 Context (files or URLs) are wrapped in `<s>…</s>` document-boundary tokens and prepended to the prompt, so suggestions match their style and content. Long references are automatically compressed by the instruct model in the background (⏳ chip while summarizing) to fit the context window; if the prompt still overflows, autocomplete retries once without references
- **AI placeholder blocks & 🪄 Weave**: insert a placeholder block (**🧩 Placeholder**) anywhere and type a one-sentence description of what should go there. Hit **🪄 Weave** and the app walks every placeholder, generates **two candidate replacements** with the chat model (seeded with the surrounding document text so style and tense match), and shows them side by side — pick one, or dismiss both and write your own. Skipped blocks stay as placeholders; the editor is read-only while weaving and the run can be cancelled at any point (already-woven blocks are kept). Placeholders save to markdown as a standalone `[[ai: your description]]` line, so they survive save/open, session restore, and hand-editing in code view
- **Chat sidebar**: talk about your document with an AI model (defaults to `apertus-v1.1-4b-instruct` on LM Studio). The current document is included as context by default (toggleable); you can also attach other files (`.md`, `.txt`, `.pdf`, `.docx`, `.odt` — text is extracted from the binary formats) or paste URLs as extra context. The chat model also powers 🪄 Weave
- **Any OpenAI-compatible endpoint** works for both features (LM Studio, Public AI, OpenAI, Ollama…) — configure base URL, model, and API key in ⚙️ Settings, with a built-in "Test connection" button
- **Export to Word (.docx), OpenDocument (.odt), and PDF** with the active CSS theme applied — docx/odt are generated in-app with the theme mapped to native styles (fonts, colors, sizes, code shading, table styling), no external tools required; PDF is rendered from the themed HTML directly
- **Session restore** (Electron): the working document is autosaved ~1 second after your last edit and restored on relaunch, so the app reopens whatever you were working on — even after a restart or power cycle — instead of the welcome page. Closing with unsaved changes prompts the native "discard changes?" confirmation first

## Getting started

**Install as a Windows app (recommended for regular use)** — builds an NSIS installer that installs to your user profile (no admin rights needed) and adds Start Menu and Desktop shortcuts, so you can launch *Apertus Writer* like any other app:

```bash
npm install
npm run dist   # builds the web app and packages it → release\Apertus Writer Setup <version>.exe
```

Run the generated `.exe` from the `release` folder to install. To update later, bump `version` in `package.json`, re-run `npm run dist`, and install again — it replaces the previous version.

**Development with hot-reload** — runs in Electron, which makes API requests outside the browser sandbox, so **CORS never applies** and any endpoint works (local servers, third-party hosted APIs):

```bash
npm install
npm run dev:electron
```

**Plain browser** — works too, but the endpoint must allow cross-origin requests (LM Studio: enable CORS in server settings; Ollama: set `OLLAMA_ORIGINS`):

```bash
npm run dev   # then open http://localhost:5173
```

### Prerequisites

On first launch the app opens a built-in quick-start page with the setup steps below, so you can follow along without this README.

By default the app expects **LM Studio** with the local server running on port `1234` and these models loaded:
- `apertus-v1.1-4b` (autocomplete, base model — uses the raw `/completions` endpoint)
- `apertus-v1.1-4b-instruct` (chat — uses `/chat/completions`)

To use a different provider (e.g. the [Public AI Inference Utility](https://platform.publicai.co/api/~endpoints) for `Apertus-70B-instruct-2509`), open ⚙️ Settings and set the base URL, model name, and API key for each feature. Settings persist across sessions.

## Usage

| Action | How |
|---|---|
| Open document | "Open" button → pick a `.md` file |
| Save document | Ctrl-S or "Save" (downloads the `.md` file) |
| Request autocomplete | Ctrl-Space (or enable "✨ Auto" in the toolbar for suggestions on typing pause) |
| Accept suggestion | Tab |
| Dismiss suggestion | Esc (or just keep typing) |
| Toggle raw markdown code view | Ctrl-Shift-M or "</> Code" in the toolbar |
| Insert an AI placeholder block | "🧩 Placeholder" in the toolbar → type the one-sentence description in the box |
| Expand placeholders with AI | "🪄 Weave" in the toolbar → choose one of two candidates per block, or write your own |
| Style theme | 🎨 Styles panel → tweak values → "Save theme .css" |
| Chat | 💬 Chat sidebar → pick local or cloud model |

## Tech stack

Vite + React + TypeScript + Electron, TipTap (ProseMirror), marked/turndown for markdown conversion. Autocomplete uses the OpenAI-compatible `/completions` API (base models); chat uses `/chat/completions`. In Electron, API calls are routed through the main process via IPC so no CORS restrictions apply. Exports: docx via the `docx` library, odt via hand-built ODF XML zipped with `jszip` — both with theme styles applied — and PDF via Electron `printToPDF` (browser fallback: print → Save as PDF).
