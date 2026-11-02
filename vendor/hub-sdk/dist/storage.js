export const DEVICE_ID_KEY = 'hub:deviceId';
export function memoryKeyValue() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        },
    };
}
export function browserKeyValue(kind) {
    if (typeof window === 'undefined')
        return memoryKeyValue();
    try {
        const store = kind === 'local' ? window.localStorage : window.sessionStorage;
        const probe = 'hub:storage-probe';
        store.setItem(probe, '1');
        store.removeItem(probe);
        return store;
    }
    catch {
        return memoryKeyValue();
    }
}
export function getOrCreateDeviceId(storage = browserKeyValue('local')) {
    const existing = storage.getItem(DEVICE_ID_KEY);
    if (existing)
        return existing;
    const id = crypto.randomUUID();
    storage.setItem(DEVICE_ID_KEY, id);
    return id;
}
export function readNumber(storage, key) {
    const raw = storage.getItem(key);
    if (!raw)
        return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
}
export function writeNumber(storage, key, value) {
    storage.setItem(key, String(value));
}
