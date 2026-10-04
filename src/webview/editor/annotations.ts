import { Annotation } from '@codemirror/state';

/** Edit kind of a local transaction (completion, snippet, math...). Plain typing has none. */
export const editKind = Annotation.define<string>();

/** A document change received from the host, never a local editor operation. */
export const remoteEdit = Annotation.define<boolean>();
