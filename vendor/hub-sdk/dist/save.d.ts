import { type SaveResult } from './types';
export declare const EMPTY_SAVE: Readonly<SaveResult>;
/** Client-side copy of the `save.put` checks. Returns the JSON text the server will store. */
export declare function encodeSave(data: unknown): string;
/** Normalises a `save.get` / `save.put` answer. */
export declare function readSaveResult(body: unknown): SaveResult;
