import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, scrollPastEnd, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, indentWithTab, insertTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { getSearchQuery, highlightSelectionMatches, search, searchKeymap, SearchQuery, setSearchQuery } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { EditorSettings } from '../../shared/types.ts';
import { textmateExtensions } from './textmate.ts';

export const settingsCompartment = new Compartment();

// The default search panel listens to keyup/change. Input also covers paste,
// composition, speech and accessibility input before the next Enter keydown.
const searchInput = ViewPlugin.define(view => {
  const input = (event: Event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || !field.closest('.cm-search') || !['search', 'replace'].includes(field.name)) { return; }
    const query = new SearchQuery({ ...getSearchQuery(view.state), [field.name]: field.value });
    if (!query.eq(getSearchQuery(view.state))) { view.dispatch({ effects: setSearchQuery.of(query) }); }
  };
  view.dom.addEventListener('input', input);
  return { destroy: () => view.dom.removeEventListener('input', input) };
});

/** Popups live outside CodeMirror, so keep their resource-scoped font and theme in sync too. */
export function applySettingsAppearance(config: EditorSettings): void {
  const themeKind = config.themeKind ?? (document.body.classList.contains('vscode-high-contrast-light') ? 'hcLight'
    : document.body.classList.contains('vscode-high-contrast') ? 'hcDark'
    : document.body.classList.contains('vscode-light') ? 'light' : 'dark');
  document.body.dataset.omtTheme = themeKind;
  document.body.style.setProperty('--omt-editor-font-family', config.fontFamily);
  document.body.style.setProperty('--omt-editor-font-size', `${config.fontSize}px`);
  document.body.style.setProperty('--omt-editor-font-weight', config.fontWeight);
}

/** Base editor without CodeMirror history: undo/redo always go through the VS Code document. */
export function baseExtensions(extra: Extension[]): Extension[] {
  return [
    EditorState.lineSeparator.of('\n'),
    // Reserve viewport-sized space below the document in visual and source modes.
    // CodeMirror updates the padding when the editor or its panels change size.
    scrollPastEnd(),
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), drawSelection(), rectangularSelection(),
    highlightActiveLine(), bracketMatching(), highlightSelectionMatches(), search({ top: true }), searchInput,
    // drawSelection paints behind the lines. An opaque VS Code current-line
    // background would hide a selection on its head line, including mouse drags.
    EditorView.editorAttributes.of(view => ({
      class: view.state.selection.ranges.some(range => !range.empty) ? 'omt-has-selection' : '',
    })),
    ...textmateExtensions(),
    settingsCompartment.of([]),
    ...extra,
    keymap.of([...searchKeymap, ...defaultKeymap]),
    EditorView.theme({
      '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)' },
      '.cm-scroller': { fontFamily: 'inherit' },
      '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
      '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
      '&.omt-has-selection .cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-gutters': { backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--vscode-editor-selectionHighlightBackground)' },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
      '.cm-searchMatch': { backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--vscode-editor-findMatchBackground)' },
      '.cm-panels': { backgroundColor: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-editorWidget-foreground)' },
    }),
  ];
}

export function settingsExtensions(config: EditorSettings): Extension[] {
  const t = config.tokens, fg = 'var(--vscode-editor-foreground)';
  const dark = config.themeKind ? config.themeKind === 'dark' || config.themeKind === 'hcDark'
    : document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  return [
    EditorView.theme({
      '&': { fontSize: `${config.fontSize}px`, fontFamily: config.fontFamily, fontWeight: config.fontWeight,
        letterSpacing: `${config.letterSpacing ?? 0}px`,
        fontVariantLigatures: config.fontLigatures === false ? 'none' : 'normal',
        fontFeatureSettings: typeof config.fontLigatures === 'string' ? config.fontLigatures : config.fontLigatures === false ? '"liga" 0, "calt" 0' : 'normal' },
      '.cm-content, .cm-gutters': { lineHeight: `${config.lineHeight}px` },
      '.cm-content': { fontFamily: config.fontFamily },
    }, { dark }),
    EditorState.tabSize.of(config.tabSize),
    indentUnit.of(config.insertSpaces ? ' '.repeat(config.tabSize) : '\t'),
    keymap.of([config.insertSpaces ? indentWithTab : { key: 'Tab', run: insertTab }]),
    ...(config.wordWrap ? [EditorView.lineWrapping] : []),
    syntaxHighlighting(HighlightStyle.define([
      { tag: tags.tagName, color: t.command ?? fg },
      { tag: tags.comment, color: t.comment ?? 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
      { tag: [tags.bracket, tags.squareBracket, tags.brace], color: t.bracket ?? fg },
      { tag: [tags.keyword, tags.atom, tags.number, tags.string], color: t.math ?? fg },
      { tag: tags.variableName, color: t.math ?? fg },
    ])),
  ];
}
