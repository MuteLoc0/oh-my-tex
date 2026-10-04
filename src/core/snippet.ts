export interface SnippetTabstop {
  index: number;
  from: number;
  to: number;
  choices?: string[];
  /** Ancestor placeholder indexes, including when this occurrence is in a mirror. */
  parents?: number[];
}

export interface ParsedSnippet { text: string; tabstops: SnippetTabstop[] }

type Node = { kind: 'text'; value: string }
  | { kind: 'placeholder'; index: number; children?: Node[]; choices?: string[] }
  | { kind: 'variable'; name: string; children?: Node[] };

/** VS Code snippet grammar. Transforms are consumed but deliberately not evaluated. */
class Parser {
  private at = 0;
  private readonly body: string;
  constructor(body: string) { this.body = body; }

  parse(stopAtBrace = false): Node[] {
    const nodes: Node[] = [];
    const append = (value: string) => {
      const previous = nodes[nodes.length - 1];
      if (previous?.kind === 'text') { previous.value += value; }
      else { nodes.push({ kind: 'text', value }); }
    };
    while (this.at < this.body.length) {
      const char = this.body[this.at];
      if (char === '}' && stopAtBrace) { break; }
      if (char === '\\' && /[\\$}]/.test(this.body[this.at + 1] ?? '')) {
        append(this.body[this.at + 1]); this.at += 2; continue;
      }
      if (char === '$') {
        const node = this.placeholder();
        if (node) { nodes.push(node); continue; }
      }
      append(char); this.at++;
    }
    return nodes;
  }

  private placeholder(): Node | undefined {
    const start = this.at++;
    const braced = this.body[this.at] === '{';
    if (braced) { this.at++; }
    const rest = this.body.slice(this.at);
    const id = /^(?:\d+|[A-Za-z_][A-Za-z_\d]*)/.exec(rest)?.[0];
    if (!id) { this.at = start; return undefined; }
    this.at += id.length;
    const numeric = /^\d+$/.test(id);
    if (numeric && !Number.isSafeInteger(Number(id))) { this.at = start; return undefined; }
    const node: Exclude<Node, { kind: 'text' }> = numeric
      ? { kind: 'placeholder', index: Number(id) }
      : { kind: 'variable', name: id };
    if (!braced) { return node; }
    const suffix = this.body[this.at];
    if (suffix === '}') { this.at++; return node; }
    if (suffix === ':') {
      this.at++;
      node.children = this.parse(true);
      if (this.body[this.at] === '}') { this.at++; return node; }
    } else if (suffix === '|' && node.kind === 'placeholder') {
      const choices = this.choice();
      if (choices) { node.choices = choices; return node; }
    } else if (suffix === '/' && this.transform()) { return node; }
    this.at = start;
    return undefined;
  }

  private choice(): string[] | undefined {
    this.at++;
    const choices: string[] = [];
    let value = '';
    while (this.at < this.body.length) {
      const char = this.body[this.at++];
      if (char === '\\' && /[\\,|]/.test(this.body[this.at] ?? '')) {
        value += this.body[this.at++];
      } else if (char === ',') { choices.push(value); value = ''; }
      else if (char === '|' && this.body[this.at] === '}') {
        this.at++; choices.push(value); return choices;
      } else { value += char; }
    }
    return undefined;
  }

  private transform(): boolean {
    this.at++;
    // Regex and format use slash delimiters. Format expressions such as
    // ${1:/upcase} may themselves contain slashes and nested braces.
    for (let segment = 0; segment < 2; segment++) {
      let braces = 0, closed = false;
      while (this.at < this.body.length) {
        const char = this.body[this.at++];
        if (char === '\\') { this.at++; continue; }
        if (segment === 1 && char === '$' && this.body[this.at] === '{') { braces++; this.at++; }
        else if (segment === 1 && char === '}' && braces > 0) { braces--; }
        else if (char === '/' && braces === 0) { closed = true; break; }
      }
      if (!closed) { return false; }
    }
    while (/[A-Za-z]/.test(this.body[this.at] ?? '')) { this.at++; }
    if (this.body[this.at] !== '}') { return false; }
    this.at++;
    return true;
  }
}

/**
 * Expand snippet text and return every placeholder/mirror in UTF-16 offsets.
 * The first explicit default or choice defines an index, including forward
 * references. Unresolved variables show their name; supplied empty values stay
 * empty. Tabstops are ordered for navigation, with the final cursor ($0) last.
 */
export function parseSnippet(body: string, variables: Record<string, string> = {}): ParsedSnippet {
  const nodes = new Parser(body).parse();
  const definitions = new Map<number, Extract<Node, { kind: 'placeholder' }>>();
  const hasVariable = (name: string) => Object.prototype.hasOwnProperty.call(variables, name);
  const collect = (children: Node[]) => {
    for (const node of children) {
      if (node.kind === 'placeholder') {
        if ((node.children || node.choices) && !definitions.has(node.index)) { definitions.set(node.index, node); }
        if (node.children) { collect(node.children); }
      } else if (node.kind === 'variable' && node.children && !hasVariable(node.name)) { collect(node.children); }
    }
  };
  collect(nodes);
  let text = '';
  const tabstops: SnippetTabstop[] = [];
  const render = (children: Node[], active: Set<number>) => {
    for (const node of children) {
      if (node.kind === 'text') { text += node.value; continue; }
      if (node.kind === 'variable') {
        if (hasVariable(node.name)) { text += variables[node.name]; }
        else if (node.children) { render(node.children, active); }
        else { text += node.name; }
        continue;
      }
      const definition = definitions.get(node.index);
      const from = text.length;
      if (!active.has(node.index)) {
        if (definition?.choices) { text += definition.choices[0]; }
        else if (definition?.children) { render(definition.children, new Set([...active, node.index])); }
      }
      const tabstop: SnippetTabstop = { index: node.index, from, to: text.length };
      if (active.size) { tabstop.parents = [...active]; }
      if (definition?.choices) { tabstop.choices = [...definition.choices]; }
      tabstops.push(tabstop);
    }
  };
  render(nodes, new Set());
  tabstops.sort((a, b) => (a.index === 0 ? Infinity : a.index) - (b.index === 0 ? Infinity : b.index)
    || a.from - b.from || b.to - a.to);
  return { text, tabstops };
}
