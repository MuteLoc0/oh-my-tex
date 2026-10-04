# TextMate browser fixtures

These fixtures pin the native VS Code inputs used by P6.3 browser tests, so the
tests do not depend on extensions installed on the machine running them.

- `LaTeX.tmLanguage.json` and `TeX.tmLanguage.json` are unmodified copies of
  `syntax/` in LaTeX Workshop 10.19.0 (`James-Yu.latex-workshop`). Workshop's
  `syntax/README.md` identifies [vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics)
  as their upstream source. See `Workshop-LICENSE.txt` for the distributed MIT
  notice, Copyright (c) 2016 James Yu.
- `ayu-dark-tokenColors.json` contains the complete `tokenColors` array extracted
  from `ayu-dark.json` in Ayu 1.1.11 (`teabyii.ayu`). Only JSON whitespace was
  changed. See `Ayu-LICENSE.txt` for its MIT notice, Copyright (c) 2016 Ike Kurghinyan.

Copied from the locally installed VS Code extensions on 2026-10-03. Fixtures are
test inputs only; the extension reads the user's installed Workshop and theme at
runtime and does not bundle these grammars or this theme.

SHA-256:

```text
126f4db457de3887972e9ba3462bfcf36f2ad19a6bbe5f34c2485c84750b203d  LaTeX.tmLanguage.json
ece74939cc365165a842f5ca8e9d794f7501af050ae6a65aa04883fe79f9d41b  TeX.tmLanguage.json
de1d258757736f2928f88e79d76cee1c76281023e3806de13d8908e8f6797741  ayu-dark-tokenColors.json
```
