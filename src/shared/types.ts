/** All offsets in the protocol are UTF-16 offsets into LF-normalised document text. */
export interface Change { from: number; to: number; insert: string }
export interface Patch extends Change { expected: string }

export interface MacroDef {
  name: string;               // without backslash
  arity: number;
  defaultArgument?: string;   // present when the first argument is optional
  body: string;               // TeX replacement text with #1..#9
  operator?: boolean;         // \DeclareMathOperator
  source?: { uri: string; from: number; to: number };
}

export interface Template { prefix: string; label: string; body: string; context: 'math' | 'prose' | 'both' }

export interface ProjectContext {
  /** Monotonic host request sequence; late replies retain their original version. */
  contextVersion: number;
  macros: MacroDef[];
  /** Display overrides only; never included in macro completion candidates. */
  renderMacros?: MacroDef[];
  templates: Template[];
  diagnostics: string[];
}

/** Raw theme rules are interpreted by vscode-textmate in the webview. */
export interface TextMateThemeRule {
  name?: string;
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

export interface TextMateGrammar {
  scopeName: 'text.tex.latex' | 'text.tex';
  content: string;
  format: 'json' | 'plist';
}

export interface EditorTokens {
  /** The four colors keep the existing stex fallback usable. */
  command?: string; comment?: string; bracket?: string; math?: string;
  grammars?: TextMateGrammar[];
  tokenColors?: TextMateThemeRule[];
  bracketPairs?: { enabled: boolean; independentColorPoolPerBracketType: boolean };
}

export interface EditorSettings {
  fontFamily: string; fontSize: number; fontWeight: string; lineHeight: number;
  fontLigatures?: boolean | string; letterSpacing?: number;
  themeKind?: 'light' | 'dark' | 'hcDark' | 'hcLight';
  tabSize: number; insertSpaces: boolean; wordWrap: boolean;
  quickSuggestions: boolean; suggestReplace: boolean; inlineShortcuts: boolean;
  completionAcceptOnEnter?: boolean;
  inlineShortcutOverrides?: Record<string, string>;
  mathCompletionAllowPatterns?: string[];
  quickSuggestionsDelay?: number; quickSuggestionsInComments?: boolean; quickSuggestionsInStrings?: boolean;
  triggerCharacters: string[];
  tokens: EditorTokens;
}
