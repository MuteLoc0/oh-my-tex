# Oh My TeX

**Edit LaTeX formulas visually, right inside your source.**

[![VS Code](https://img.shields.io/badge/VS_Code-1.100%2B-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MathLive](https://img.shields.io/badge/powered_by-MathLive-blue)](https://github.com/arnog/mathlive)

English · [简体中文](doc/README_zh.md)

[GitHub](https://github.com/MuteLoc0/oh-my-tex) · [Releases](https://github.com/MuteLoc0/oh-my-tex/releases) · [Report an issue](https://github.com/MuteLoc0/oh-my-tex/issues)

Oh My TeX is a VS Code extension that puts LaTeX prose and editable, rendered formulas on the same page. Keep writing your document as source text, then click a formula to work with fractions, subscripts, matrices and more through [MathLive](https://github.com/arnog/mathlive).

The extension adds a visual formula editor built with [CodeMirror 6](https://github.com/codemirror/dev). Your `.tex` document remains the source of truth. Untouched formulas are never rewritten, and visual edits aim to preserve your existing LaTeX spelling and formatting. Connect [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) for compilation, PDF viewing and SyncTeX.

## Demo

> Demo GIFs coming soon.

<!--
![Edit formulas in place](images/demos/visual-editing.gif)
![Complete commands and edit macro arguments](images/demos/macros-and-completion.gif)
![Switch to source and jump to the PDF](images/demos/source-and-pdf.gif)
-->

## Contents

- [Features](#features)
- [Installation](#installation)
- [How to use](#how-to-use)
- [Keyboard shortcuts and commands](#keyboard-shortcuts-and-commands)
- [Configuration](#configuration)
- [Compatibility and limitations](#compatibility-and-limitations)
- [Development](#development)
- [Built with and acknowledgements](#built-with-and-acknowledgements)
- [Contributing](#contributing)
- [License](#license)

## Features

- **In-place visual math.** Edit inline and display formulas, including common `equation`, `align`, `gather` and `multline` environments, without leaving the document.
- **Project macros.** Discover definitions such as `\newcommand`, `\DeclareMathOperator` and `\def` through the root document and its `\input` / `\include` files. Edit supported macro arguments in a dedicated popover, including optional and nested arguments.
- **Completion and templates.** Combine MathLive commands, project macros, custom snippets and available VS Code / LaTeX Workshop completion providers.
- **Theme integration.** Follow your VS Code theme and editor font settings. When Workshop is installed, use its TextMate grammars for LaTeX source highlighting; otherwise use basic highlighting.
- **PDF workflow.** Build, view the PDF and run forward SyncTeX from the visual editor through LaTeX Workshop.

## Installation

### Requirements

- **VS Code 1.100 or later** for Oh My TeX. LaTeX Workshop may require a newer version; check its [installation guide](https://github.com/James-Yu/LaTeX-Workshop/wiki/Install).
- **LaTeX Workshop** is recommended for richer completion and highlighting, and required for the SyncTeX commands.
- **A working TeX distribution** configured for Workshop is required to compile PDFs. Visual formula editing itself does not require a TeX installation.

## How to use

### 1. Open the visual editor

Open a `.tex` file, then choose **Reopen Editor With… → Oh My TeX** from the editor tab's context menu. You can also run **Oh My TeX: Open Visual Editor / Toggle Source Mode** from the Command Palette to enter the extension's visual editor.

The shortcut is `Cmd+Option+Shift+M` on macOS or `Ctrl+Alt+Shift+M` on Windows / Linux. Once the visual editor is open, the same command switches the page between visual and source modes.

### 2. Write prose and edit formulas

Write prose and document commands as LaTeX source. Click a rendered formula, or move into it with the arrow keys, to edit it visually.

Press **Esc** in an active formula to reveal its source. If a completion list or macro argument popover is open, Esc closes that first. For native VS Code source editing at the current position, run **Oh My TeX: Open Native Source at Cursor**.

### 3. Complete commands and edit macro arguments

Type a command prefix, or press **Ctrl+Space**, to request completion. Select a candidate with **↑ / ↓** and accept it with **Tab**. Enter keeps its normal editing behavior by default; enable `oh-my-tex.completion.acceptOnEnter` to accept with Enter too.

For commands with multiple arguments, use **Tab / Shift+Tab** to move between arguments. In an active formula, click a rendered macro or its toolbar button to open the argument editor. You can also place the cursor after the macro and press **Alt+Enter** (`Option+Enter` on macOS). In the argument popover, Tab / Shift+Tab moves between arguments; Enter or Esc finishes the argument session. The original macro call is retained in the source.

### 4. Build and navigate the PDF

In the current version, actions such as **Oh My TeX: Build with LaTeX Workshop**, **Oh My TeX: View PDF with LaTeX Workshop** and **Oh My TeX: SyncTeX from Cursor** may activate the native text editor, making the workflow cumbersome. Improvements may be considered for future versions.

### 5. Work with multiple files

Open the project folder in VS Code. In an included chapter, identify its root using a path relative to that chapter:

```tex
% !TeX root = ../main.tex
```

Alternatively, run **Oh My TeX: Choose Root Document**. The magic comment takes priority over a saved manual selection. Without either, Oh My TeX looks for a unique workspace root that includes the current file.

If Workshop is viewing the wrong project's PDF, run **Oh My TeX: Sync Workshop Root and View PDF**. This explicitly refreshes Workshop's root context and opens the PDF.

## Keyboard shortcuts and commands

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Open visual editor / toggle page source mode | `Cmd+Option+Shift+M` | `Ctrl+Alt+Shift+M` |
| Build with LaTeX Workshop | `Cmd+Option+B` | `Ctrl+Alt+B` |
| View PDF with LaTeX Workshop | `Cmd+Option+V` | `Ctrl+Alt+V` |
| Forward SyncTeX from cursor | `Cmd+Option+J` | `Ctrl+Alt+J` |
| Find / replace (`Find in Visual Editor`) | `Cmd+F` | `Ctrl+F` |
| Save | `Cmd+S` | `Ctrl+S` |
| Undo / redo | `Cmd+Z` / `Cmd+Shift+Z` | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Request completion | `Ctrl+Space` | `Ctrl+Space` |
| Edit macro arguments at cursor | `Option+Enter` | `Alt+Enter` |

On macOS, Option is the Alt key. Ctrl+Space may be assigned to input-source switching by macOS; use a typed command prefix or adjust that system shortcut if necessary.

In addition to the actions above, commands include **Open Native Source at Cursor**, **Choose Root Document** and **Sync Workshop Root and View PDF**.

## Configuration

Search for **Oh My TeX** in VS Code Settings, or add options to your workspace's `.vscode/settings.json`:

```json
{
  "oh-my-tex.completion.acceptOnEnter": false,
  "oh-my-tex.macros": {
    "\\R": "\\mathbb{R}"
  },
  "oh-my-tex.renderMacros": {
    "\\slashed": { "args": 1, "def": "\\cancel{#1}" }
  },
  "oh-my-tex.templates": [
    {
      "prefix": "\\sumn",
      "label": "Sum from n to N",
      "body": "\\sum_{${1:n=1}}^{${2:N}} $0",
      "context": "math"
    }
  ],
  "oh-my-tex.math.inlineShortcutOverrides": {
    "alpha": "\\alpha"
  }
}
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `oh-my-tex.completion.acceptOnEnter` | `false` | Also accept completion candidates with Enter. Tab always accepts. |
| `oh-my-tex.macros` | `{}` | Additional editor macros; discovered project definitions take priority. |
| `oh-my-tex.renderMacros` | `{}` | Display-only overrides, taking priority over project, compatibility and built-in definitions. Adds no completion candidates and changes no source. |
| `oh-my-tex.templates` | `[]` | Completion templates using VS Code snippet syntax; context is `math`, `prose` or `both`. |
| `oh-my-tex.math.inlineShortcuts` | `true` | Enable the symbolic shortcuts `<=`, `>=`, `!=` and `->`. |
| `oh-my-tex.math.inlineShortcutOverrides` | `{}` | Add or override inline shortcuts; an empty value disables a default shortcut. |
| `oh-my-tex.math.completionAllowPatterns` | `[]` | Regular-expression sources allowing additional formula completion candidates. |
| `oh-my-tex.workshop.nativeEditorColumn` | `"beside"` | Open native source beside the visual editor, or use `"same"`. |
| `oh-my-tex.workshop.returnToVisualEditor` | `true` | Return focus after forward SyncTeX. |
| `oh-my-tex.workshop.primeRoot` | `true` | Activate the root's native source editor before Workshop actions. |

Editor macros affect visual rendering and completion; they do not define commands for your TeX compiler. Keep the required definitions and packages in the document too. Some display mappings, such as the `\slashed` example, approximate a package's typesetting.

For Workshop's build-on-save workflow, set `"latex-workshop.latex.autoBuild.run": "onSave"`. Oh My TeX uses your existing Workshop recipes and does not change them automatically.

## Compatibility and limitations

- This editor renders math while keeping prose as LaTeX source. Use the compiled PDF to check page layout, numbering, references, figures and package-specific output.
- Common delimiters (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and supported math environments render in place. `alignat` and `eqnarray`, formulas containing comments, `\verb` or dynamic TeX code, and other unsupported constructs stay editable as source.
- Unknown or unsupported commands can appear as source-preserving chips. Macro discovery is a static analysis of the project, so arbitrary TeX expansion and every package definition are outside its scope.
- For an edited formula, write-back may fall back from token changes to an enclosing group or formula body. If parsing or serialization makes a body replacement unsafe, the edit is refused with an explanation and the formula switches to source editing. Formatting preservation is therefore best-effort for edits.
- The current SyncTeX workflow is cumbersome.
- Changing theme colors while a formula is active may recreate its field and end the editing session.

## Development

Use **Node.js 24 and npm**. After cloning the repository:

```sh
npm ci
npm run build
code --extensionDevelopmentPath="$PWD" examples/main.tex
```

In the Extension Development Host, run **Oh My TeX: Open Visual Editor / Toggle Source Mode**. For webview debugging, run **Developer: Open Webview Developer Tools**. Run `npm run watch` during development, then reload the development window after rebuilding.

| Command | Purpose |
| --- | --- |
| `npm run build` | Build host and webview bundles, copy math fonts and Oniguruma WASM, and check bundle activation. |
| `npm run watch` | Rebuild bundles as source files change. |
| `npm run check-types` | Check core, host and webview TypeScript. |
| `npm run test:unit` | Run core and synchronization unit tests. |
| `npm run test:browser` | Run the real webview bundle in Chromium with a mock host. Install Chromium first with `npx playwright install chromium`. |
| `npm test` | Build and run VS Code integration tests. Workshop / TeX-dependent cases require those tools in the test environment. |
| `npm run vsix` | Build and package an installable extension. |

See [`package.json`](package.json) for the complete scripts and [`examples/`](examples/) for sample documents. The project separates pure parsing / write-back logic in `src/core`, VS Code integration in `src/host`, and the visual editor in `src/webview`.

## Built with and acknowledgements

Oh My TeX builds on these open-source projects:

| Project | Role in Oh My TeX |
| --- | --- |
| [MathLive](https://github.com/arnog/mathlive) | Visual math fields, formula rendering and math editing. This project pins MathLive **0.110.0**. |
| [CodeMirror 6](https://github.com/codemirror/dev) | The webview's source editor, selection, search and formula decorations. |
| [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) | Optional installed extension supplying completion, TextMate grammars, compilation, PDF viewing and SyncTeX. |
| [vscode-textmate](https://github.com/microsoft/vscode-textmate) | TextMate tokenization for LaTeX source highlighting. |
| [vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma) | The WebAssembly regular-expression engine used by TextMate. |
| [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) | Read JSON-with-comments theme data. |

The browser regression tests also use LaTeX Workshop grammar fixtures, whose upstream is [vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics), and [Ayu](https://github.com/ayu-theme/vscode-ayu) theme fixtures. Their versions, origins and license notices are documented in the [fixture README](test/fixtures/textmate/README.md). These fixtures are test inputs; the extension uses the installed Workshop and theme at runtime.

Thank you to the maintainers and contributors of these projects. Third-party components retain their own licenses.

## Contributing

Bug reports and pull requests are welcome at [MuteLoc0/oh-my-tex](https://github.com/MuteLoc0/oh-my-tex). When [reporting an issue](https://github.com/MuteLoc0/oh-my-tex/issues), include a minimal `.tex` example, the expected and actual behavior, your OS and extension versions, and whether LaTeX Workshop is installed.

## License

[MIT](LICENSE) © 2026 MuteLoc0.
