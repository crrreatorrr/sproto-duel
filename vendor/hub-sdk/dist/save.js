import { HubSdkError } from './errors';
import { SAVE_MAX_BYTES } from './types';
export const EMPTY_SAVE = Object.freeze({ data: null, updatedAt: 0 });
/** Client-side copy of the `save.put` checks. Returns the JSON text the server will store. */
export function encodeSave(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new HubSdkError('bad_save', 'A save must be a JSON object');
    }
    let text;
    try {
        text = JSON.stringify(data);
    }
    catch {
        throw new HubSdkError('bad_save', 'A save must be JSON');
    }
    if (new TextEncoder().encode(text).length > SAVE_MAX_BYTES) {
        throw new HubSdkError('save_too_large', `A save is at most ${SAVE_MAX_BYTES} bytes`);
    }
    return text;
}
/** Normalises a `save.get` / `save.put` answer. */
export function readSaveResult(body) {
    const raw = (body ?? {});
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null;
    const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    return { data, updatedAt: data ? updatedAt : 0 };
}
