import { tokenize } from './lexer.ts';

// Han (including supplementary ideographs), kana and Hangul require text atoms.
export function containsCJK(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/** True when a field serialization would write CJK as ordinary mathematical atoms. */
export function hasMathModeCJK(latex: string): boolean {
  const textCommands = new Set(['\\text', '\\textrm', '\\textnormal', '\\textsf', '\\texttt', '\\textbf', '\\textmd', '\\textit', '\\textsl', '\\textup', '\\textsc', '\\mbox']);
  const modes = [{ text: false, mathShift: false }];
  let argumentMode: boolean | undefined;
  for (const token of tokenize(latex)) {
    if (token.kind === 'space' || token.kind === 'comment') { continue; }
    const current = modes[modes.length - 1]!;
    if (token.value === '{') {
      modes.push({ text: argumentMode ?? current.text, mathShift: false });
      argumentMode = undefined;
    } else if (token.value === '}') {
      if (modes.length > 1) { modes.pop(); }
      argumentMode = undefined;
    } else if (token.value === '$') {
      if (current.text || current.mathShift) {
        current.text = !current.text; current.mathShift = !current.mathShift;
      }
      argumentMode = undefined;
    } else if (token.kind === 'command') {
      argumentMode = textCommands.has(token.value) ? true : token.value === '\\ensuremath' ? false : undefined;
    } else {
      const textMode = argumentMode ?? current.text;
      if (containsCJK(token.value) && !textMode && token.kind !== 'verbatim') { return true; }
      argumentMode = undefined;
    }
  }
  return false;
}
