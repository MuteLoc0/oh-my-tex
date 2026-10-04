import { groupAt, tokenize, type Token } from './lexer.ts';

export interface FormulaSpan {
  from: number; to: number;          // whole formula including delimiters / environment wrapper
  bodyFrom: number; bodyTo: number;  // math content
  kind: string;                      // '$', '$$', '\\(', '\\[' or the environment name
  display: boolean;
  /** MathLive environment the body is projected into (align → aligned ...). */
  wrapper?: string;
  /** Why this formula must stay as editable source text. */
  sourceOnly?: string;
}

/** Math environments and the MathLive environment their body is edited in ('' = plain body). */
const MATH_ENVS: Record<string, string> = {
  'equation': '', 'equation*': '', 'displaymath': '', 'math': '',
  'align': 'aligned', 'align*': 'aligned', 'flalign': 'aligned', 'flalign*': 'aligned',
  'gather': 'gathered', 'gather*': 'gathered',
  'multline': 'multline', 'multline*': 'multline',
  'alignat': '', 'alignat*': '', 'eqnarray': '', 'eqnarray*': '',
};
const UNSUPPORTED_ENVS = new Set(['alignat', 'alignat*', 'eqnarray', 'eqnarray*']);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*']);
const DYNAMIC = /^\\(?:def|gdef|edef|xdef|let|futurelet|catcode|csname|endcsname|expandafter|noexpand|makeatletter|makeatother|ExplSyntaxOn|newcommand|renewcommand|providecommand|DeclareMathOperator|NewDocumentCommand|if[a-zA-Z]*|fi|else)$/;

/** Find formulas in a LaTeX document. Comments, \verb and verbatim environments are skipped. */
export function scanFormulas(text: string): FormulaSpan[] {
  const all = tokenize(text);
  const tokens = all.filter(t => t.kind !== 'space' && t.kind !== 'comment');
  const result: FormulaSpan[] = [];
  const envName = (i: number) => {
    const g = groupAt(tokens, i + 1);
    return g && { name: text.slice(g.from, g.to), group: g };
  };
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i];
    if (t.value === '\\begin') {
      const env = envName(i);
      if (!env) { i++; continue; }
      if (VERBATIM_ENVS.has(env.name)) {
        const close = `\\end{${env.name}}`, stop = text.indexOf(close, env.group.end);
        const to = stop < 0 ? text.length : stop + close.length;
        while (i < tokens.length && tokens[i].from < to) { i++; }
        continue;
      }
      if (env.name in MATH_ENVS) {
        const end = findEnd(tokens, text, env.group.next, env.name);
        if (!end) { i = env.group.next; continue; }
        const span: FormulaSpan = { from: t.from, to: end.to, bodyFrom: env.group.end, bodyTo: end.from, kind: env.name, display: env.name !== 'math' };
        if (MATH_ENVS[env.name]) { span.wrapper = MATH_ENVS[env.name]; }
        if (UNSUPPORTED_ENVS.has(env.name)) { span.sourceOnly = `\\begin{${env.name}} is edited as source`; }
        result.push(check(span, text));
        i = end.next; continue;
      }
      i = env.group.next; continue;
    }
    if (t.value === '$' || t.value === '\\(' || t.value === '\\[') {
      const span = delimited(tokens, text, i);
      if (span) { result.push(check(span.span, text)); i = span.next; continue; }
      // An unterminated $$ must not be re-read as two inline delimiters.
      if (t.value === '$' && tokens[i + 1]?.value === '$' && tokens[i + 1].from === t.to) { i += 2; continue; }
    }
    i++;
  }
  return result;
}

function findEnd(tokens: Token[], text: string, start: number, name: string) {
  let level = 1;
  for (let j = start; j < tokens.length; j++) {
    const v = tokens[j].value;
    if (v !== '\\begin' && v !== '\\end') { continue; }
    const g = groupAt(tokens, j + 1);
    if (!g || text.slice(g.from, g.to) !== name) { continue; }
    level += v === '\\begin' ? 1 : -1;
    if (!level) { return { from: tokens[j].from, to: g.end, next: g.next }; }
  }
  return undefined;
}

function delimited(tokens: Token[], text: string, i: number): { span: FormulaSpan; next: number } | undefined {
  const t = tokens[i];
  let kind = t.value, start = i + 1, bodyFrom = t.to;
  if (kind === '$' && tokens[start]?.value === '$' && tokens[start].from === t.to) { kind = '$$'; bodyFrom = tokens[start].to; start++; }
  const close = kind === '\\(' ? '\\)' : kind === '\\[' ? '\\]' : '$';
  const inline = kind === '$' || kind === '\\(';
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    const v = tokens[j].value;
    // TeX math cannot span a paragraph; stop an unterminated inline formula at a blank line.
    if (inline && /\n[ \t]*\n/.test(text.slice(tokens[j - 1].to, tokens[j].from))) { return undefined; }
    if (v === '{') { depth++; continue; }
    if (v === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 || v !== close) { continue; }
    if (kind === '$$') {
      if (!(tokens[j + 1]?.value === '$' && tokens[j + 1].from === tokens[j].to)) { continue; }
      return { span: { from: t.from, to: tokens[j + 1].to, bodyFrom, bodyTo: tokens[j].from, kind, display: true }, next: j + 2 };
    }
    return { span: { from: t.from, to: tokens[j].to, bodyFrom, bodyTo: tokens[j].from, kind, display: !inline }, next: j + 1 };
  }
  return undefined;
}

/** Mark formulas that cannot be projected into a math field without losing source. */
function check(span: FormulaSpan, text: string): FormulaSpan {
  if (span.sourceOnly) { return span; }
  const body = tokenize(text.slice(span.bodyFrom, span.bodyTo));
  let envDepth = 0;
  for (let k = 0; k < body.length; k++) {
    const b = body[k];
    if (b.kind === 'comment') { return { ...span, sourceOnly: 'contains a comment' }; }
    if (b.kind === 'verbatim') { return { ...span, sourceOnly: 'contains \\verb' }; }
    if (b.kind === 'command' && DYNAMIC.test(b.value)) { return { ...span, sourceOnly: `contains ${b.value}` }; }
    if (b.value === '\\begin') { envDepth++; }
    if (b.value === '\\end') { envDepth--; }
    if (!span.wrapper && envDepth === 0 && (b.value === '&' || b.value === '\\\\')) { return { ...span, sourceOnly: 'alignment outside an environment' }; }
    if (b.value === '#') { return { ...span, sourceOnly: 'contains #' }; }
  }
  return span;
}
