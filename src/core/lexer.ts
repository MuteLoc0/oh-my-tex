export interface Token { value: string; from: number; to: number; kind: 'command' | 'char' | 'space' | 'comment' | 'verbatim' }

/** A TeX-ish tokenizer: control sequences, comments, whitespace runs, \verb and single code points. */
export function tokenize(text: string, offset = 0): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    let kind: Token['kind'] = 'char';
    if (text[i] === '%') {
      kind = 'comment';
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') { i++; }
    } else if (/\s/.test(text[i])) {
      kind = 'space';
      while (i < text.length && /\s/.test(text[i])) { i++; }
    } else if (text[i] === '\\') {
      kind = 'command'; i++;
      if (/[a-zA-Z@]/.test(text[i] ?? '')) {
        while (i < text.length && /[a-zA-Z@]/.test(text[i])) { i++; }
      } else if (i < text.length) { i += String.fromCodePoint(text.codePointAt(i)!).length; }
      if (text.slice(start, i) === '\\verb') {
        if (text[i] === '*') { i++; }
        const delimiter = text[i++];
        while (i < text.length && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') { i++; }
        if (text[i] === delimiter) { i++; }
        kind = 'verbatim';
      }
    } else { i += String.fromCodePoint(text.codePointAt(i)!).length; }
    result.push({ value: text.slice(start, i), from: start + offset, to: i + offset, kind });
  }
  return result;
}

export function significant(tokens: Token[]): Token[] {
  return tokens.filter(t => t.kind !== 'space' && t.kind !== 'comment');
}

export interface Group { start: number; end: number; from: number; to: number; next: number }

/** Match a balanced group starting at tokens[index]; `[` groups ignore brackets nested in braces. */
export function groupAt(tokens: Token[], index: number, open = '{', close = '}'): Group | undefined {
  if (tokens[index]?.value !== open) { return undefined; }
  let depth = 1;
  let braces = 0;
  for (let i = index + 1; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (open === '[') {
      if (v === '{') { braces++; }
      if (v === '}') { braces--; }
      if (braces !== 0) { continue; }
    }
    if (v === open) { depth++; }
    if (v === close) { depth--; }
    if (!depth) { return { start: tokens[index].from, end: tokens[i].to, from: tokens[index].to, to: tokens[i].from, next: i + 1 }; }
  }
  return undefined;
}
