/** Line starts over LF-normalised text. The protocol uses LF offsets; VS Code positions are line/character. */
export class LineIndex {
  private starts: number[] = [0];
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) { this.starts.push(i + 1); }
  }
  get lineCount() { return this.starts.length; }
  positionAt(offset: number): { line: number; character: number } {
    offset = Math.max(0, Math.min(offset, this.text.length));
    let low = 0, high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid] <= offset) { low = mid; } else { high = mid - 1; }
    }
    return { line: low, character: offset - this.starts[low] };
  }
  offsetAt(line: number, character: number): number {
    if (line >= this.starts.length) { return this.text.length; }
    const end = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
    return Math.min(this.starts[Math.max(0, line)] + Math.max(0, character), end);
  }
}

export const toLF = (text: string) => text.replace(/\r\n?/g, '\n');
