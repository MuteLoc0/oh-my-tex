import * as vscode from 'vscode';
import { parse } from 'jsonc-parser';
import { customizationRules, editorLineHeight, themeScopedCustomizations, tokenColors, type ThemeRule } from '../core/themeTokens.ts';
import type { EditorSettings } from '../shared/types.ts';
import { workshopGrammars } from './grammar.ts';

interface Theme { include?: string; tokenColors?: ThemeRule[]; colors?: Record<string, string> }

/** Load inherited rules first while retaining all settings, including fontStyle. */
export async function loadTheme(uri: vscode.Uri): Promise<{ tokenColors: ThemeRule[]; colors: Record<string, string> }> {
  const rules: ThemeRule[] = [], colors: Record<string, string> = {};
  const seen = new Set<string>();
  async function read(uri: vscode.Uri, depth = 0): Promise<void> {
    if (depth > 8 || seen.has(uri.toString())) { return; }
    seen.add(uri.toString());
    try {
      const theme = parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as Theme | null;
      if (!theme || typeof theme !== 'object') { return; }
      if (typeof theme.include === 'string') { await read(vscode.Uri.joinPath(uri, '..', theme.include), depth + 1); }
      if (Array.isArray(theme.tokenColors)) { rules.push(...theme.tokenColors); }
      if (theme.colors && typeof theme.colors === 'object') {
        for (const [name, color] of Object.entries(theme.colors)) { if (typeof color === 'string') { colors[name] = color; } }
      }
    } catch { /* CSS variables and stex remain a usable fallback. */ }
  }
  await read(uri);
  return { tokenColors: rules, colors };
}

async function themeRules(document: vscode.TextDocument): Promise<ThemeRule[]> {
  const themeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  const rules: ThemeRule[] = [];
  const colors: Record<string, string> = {};
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON.contributes?.themes as { id?: string; label?: string; path: string }[] | undefined;
    const theme = themes?.find(t => t.id === themeName || t.label === themeName);
    if (theme) {
      const loaded = await loadTheme(vscode.Uri.joinPath(extension.extensionUri, theme.path));
      rules.push(...loaded.tokenColors); Object.assign(colors, loaded.colors); break;
    }
  }
  const customColors = vscode.workspace.getConfiguration('workbench').get<Record<string, unknown>>('colorCustomizations', {});
  Object.assign(colors, customColors, themeScopedCustomizations(customColors, themeName));
  const defaults: NonNullable<ThemeRule['settings']> = {};
  for (const [color, setting] of [['editor.foreground', 'foreground'], ['editor.background', 'background']] as const) {
    if (typeof colors[color] === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(colors[color]!)) { defaults[setting] = colors[color]; }
  }
  // VS Code derives default token colors from editor colors. Put this after any
  // legacy unscoped token rule, whose background may differ from the editor.
  if (Object.keys(defaults).length) { rules.push({ settings: defaults }); }
  const custom = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: 'latex' }).get<unknown>('tokenColorCustomizations', {});
  rules.push(...customizationRules(custom, themeName));
  return rules;
}

export async function editorSettings(document: vscode.TextDocument): Promise<EditorSettings> {
  const editor = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: 'latex' });
  const workshop = vscode.workspace.getConfiguration('latex-workshop', document.uri);
  const ours = vscode.workspace.getConfiguration('oh-my-tex', document.uri);
  const fontSize = editor.get<number>('fontSize', 14), configuredHeight = editor.get<number>('lineHeight', 0);
  const lineHeight = editorLineHeight(fontSize, configuredHeight);
  const themeKind: EditorSettings['themeKind'] = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light'
    : vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast ? 'hcDark'
    : vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight ? 'hcLight' : 'dark';
  const quick = editor.get<boolean | string | Record<string, string | boolean>>('quickSuggestions', true);
  const quickSuggestions = typeof quick === 'object' ? quick.other !== 'off' && quick.other !== false : quick !== false && quick !== 'off';
  const quickContext = (name: 'comments' | 'strings') => typeof quick === 'object' ? quick[name] !== 'off' && quick[name] !== false : quickSuggestions;
  const triggers = workshop.get<unknown>('intellisense.triggers.latex', ['\\', '{', ',', '}']);
  const rawShortcuts = ours.get<unknown>('math.inlineShortcutOverrides', {});
  const inlineShortcutOverrides = rawShortcuts && typeof rawShortcuts === 'object' && !Array.isArray(rawShortcuts)
    ? Object.fromEntries(Object.entries(rawShortcuts).filter(([key, value]) => key.length > 0 && typeof value === 'string')) as Record<string, string> : {};
  const rawPatterns = ours.get<unknown>('math.completionAllowPatterns', []);
  const mathCompletionAllowPatterns = Array.isArray(rawPatterns) ? rawPatterns.filter((pattern): pattern is string => typeof pattern === 'string') : [];
  const [rules, grammars] = await Promise.all([themeRules(document), workshopGrammars()]);
  return {
    fontFamily: editor.get('fontFamily', 'monospace'), fontSize, fontWeight: String(editor.get('fontWeight', 'normal')), lineHeight,
    fontLigatures: editor.get<boolean | string>('fontLigatures', false), letterSpacing: editor.get<number>('letterSpacing', 0), themeKind,
    tabSize: Number(editor.get('tabSize', 4)) || 4, insertSpaces: editor.get('insertSpaces', true), wordWrap: editor.get('wordWrap', 'off') !== 'off',
    quickSuggestions, suggestReplace: editor.get<string>('suggest.insertMode', 'insert') === 'replace',
    completionAcceptOnEnter: ours.get('completion.acceptOnEnter', false),
    quickSuggestionsDelay: Math.max(0, editor.get<number>('quickSuggestionsDelay', 10)),
    quickSuggestionsInComments: quickContext('comments'), quickSuggestionsInStrings: quickContext('strings'),
    inlineShortcuts: ours.get('math.inlineShortcuts', true), inlineShortcutOverrides, mathCompletionAllowPatterns,
    triggerCharacters: Array.isArray(triggers) ? triggers.filter((c): c is string => typeof c === 'string' && [...c].length === 1) : [],
    tokens: {
      ...tokenColors(rules), grammars, tokenColors: rules,
      bracketPairs: {
        enabled: editor.get('bracketPairColorization.enabled', true),
        independentColorPoolPerBracketType: editor.get('bracketPairColorization.independentColorPoolPerBracketType', false),
      },
    },
  };
}
