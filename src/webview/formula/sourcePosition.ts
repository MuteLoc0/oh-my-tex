import { diffText } from '../../core/patch.ts';
import { reconcile } from '../../core/writeback.ts';
import type { LiveField } from './mathlive.ts';
import type { Projection } from './projection.ts';

/** Probe a copy of the field. Neither the active model nor the source is modified. */
export function sourceCursor(field: LiveField, projection: Projection, sourceView: string, serial: string,
  canon: (projection: Projection, value: string) => string | undefined): number | undefined {
  const marker = '\\OMTSourceCursor';
  const source = projection.restore(sourceView);
  if (source === undefined || source.includes(marker)) { return; }
  const macros = { ...projection.macros, [marker.slice(1)]: { def: 'x', args: 0, expand: false, captureSelection: true } };
  const marked = field.markedValue(marker, true);
  const result = reconcile(sourceView, serial, marked, value => canon({ ...projection, macros }, value), projection.islands);
  const restored = projection.restore(result.view);
  if (restored === undefined || restored.split(marker).length !== 2) { return; }
  const at = restored.indexOf(marker);
  const stripped = restored.replace(marker, '');
  // The probe may add required braces at a subscript or fraction boundary. Map
  // that small formatting change back rather than reporting a fabricated offset.
  const change = diffText(source, stripped);
  const endOfContent = source.trimEnd().length;
  if (!change || at <= change.from) { return Math.min(at, endOfContent); }
  const end = change.from + change.insert.length;
  return Math.min(endOfContent, at >= end ? at + change.to - end : change.from);
}
