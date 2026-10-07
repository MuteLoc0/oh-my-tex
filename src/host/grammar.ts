import * as vscode from 'vscode';
import type { TextMateGrammar } from '../shared/types.ts';

type GrammarExtension = Pick<vscode.Extension<unknown>, 'extensionUri' | 'packageJSON'>;
type GrammarContribution = { scopeName?: unknown; path?: unknown };
let fallbackUri: vscode.Uri | undefined;

/** The UI host cannot enumerate a Workshop running on an SSH host. */
export function configureGrammarFallback(extensionUri: vscode.Uri): void { fallbackUri = extensionUri; }

function bundledGrammar(): GrammarExtension | undefined {
  return fallbackUri ? {
    extensionUri: vscode.Uri.joinPath(fallbackUri, 'dist', 'grammars'),
    packageJSON: { version: '10.19.0-bundled', contributes: { grammars: [
      { scopeName: 'text.tex.latex', path: 'LaTeX.tmLanguage.json' },
      { scopeName: 'text.tex', path: 'TeX.tmLanguage.json' },
    ] } },
  } : undefined;
}

/** One read per Workshop installation/version, shared by all visual editors. */
export class WorkshopGrammarLoader {
  private readonly cache = new Map<string, Promise<TextMateGrammar[] | undefined>>();
  private readonly resolve: () => GrammarExtension | undefined;
  private readonly read: (uri: vscode.Uri) => Thenable<Uint8Array>;
  private readonly fallback: () => GrammarExtension | undefined;

  constructor(
    resolve: () => GrammarExtension | undefined = () => vscode.extensions.getExtension('James-Yu.latex-workshop'),
    read: (uri: vscode.Uri) => Thenable<Uint8Array> = uri => vscode.workspace.fs.readFile(uri),
    fallback: () => GrammarExtension | undefined = bundledGrammar,
  ) { this.resolve = resolve; this.read = read; this.fallback = fallback; }

  async load(): Promise<TextMateGrammar[] | undefined> {
    const extension = this.resolve();
    const primary = extension && await this.cached(extension);
    if (primary) { return primary; }
    const fallback = this.fallback();
    return fallback ? this.cached(fallback) : undefined;
  }

  private cached(extension: GrammarExtension): Promise<TextMateGrammar[] | undefined> {
    const key = `${extension.extensionUri.toString()}@${String(extension.packageJSON.version ?? '')}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.readGrammars(extension).then(grammars => {
        // Failed reads must recover after resources/connection become ready.
        if (!grammars) { this.cache.delete(key); }
        return grammars;
      });
      this.cache.set(key, cached);
    }
    return cached;
  }

  private async readGrammars(extension: GrammarExtension): Promise<TextMateGrammar[] | undefined> {
    const contributions = extension.packageJSON.contributes?.grammars as GrammarContribution[] | undefined;
    if (!Array.isArray(contributions)) { return undefined; }
    const grammars = await Promise.all((['text.tex.latex', 'text.tex'] as const).map(async scopeName => {
      const contribution = contributions.find(grammar => grammar && typeof grammar === 'object'
        && grammar.scopeName === scopeName && typeof grammar.path === 'string');
      if (!contribution) { return undefined; }
      try {
        const path = contribution.path as string;
        return {
          scopeName,
          content: Buffer.from(await this.read(vscode.Uri.joinPath(extension.extensionUri, path))).toString('utf8'),
          format: path.toLowerCase().endsWith('.json') ? 'json' : 'plist',
        } satisfies TextMateGrammar;
      } catch { return undefined; }
    }));
    // Both scopes are necessary for Workshop's cross-grammar includes.
    return grammars.every((grammar): grammar is TextMateGrammar => !!grammar) ? grammars : undefined;
  }
}

const workshopGrammarLoader = new WorkshopGrammarLoader();

export function workshopGrammars(): Promise<TextMateGrammar[] | undefined> {
  return workshopGrammarLoader.load();
}
