import * as vscode from 'vscode';
import type { TextMateGrammar } from '../shared/types.ts';

type GrammarExtension = Pick<vscode.Extension<unknown>, 'extensionUri' | 'packageJSON'>;
type GrammarContribution = { scopeName?: unknown; path?: unknown };

/** One read per Workshop installation/version, shared by all visual editors. */
export class WorkshopGrammarLoader {
  private readonly cache = new Map<string, Promise<TextMateGrammar[] | undefined>>();
  private readonly resolve: () => GrammarExtension | undefined;
  private readonly read: (uri: vscode.Uri) => Thenable<Uint8Array>;

  constructor(
    resolve: () => GrammarExtension | undefined = () => vscode.extensions.getExtension('James-Yu.latex-workshop'),
    read: (uri: vscode.Uri) => Thenable<Uint8Array> = uri => vscode.workspace.fs.readFile(uri),
  ) { this.resolve = resolve; this.read = read; }

  load(): Promise<TextMateGrammar[] | undefined> {
    const extension = this.resolve();
    if (!extension) { return Promise.resolve(undefined); }
    const key = `${extension.extensionUri.toString()}@${String(extension.packageJSON.version ?? '')}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.readGrammars(extension);
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
