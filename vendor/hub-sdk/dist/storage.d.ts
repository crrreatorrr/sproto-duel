export interface KeyValue {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export declare const DEVICE_ID_KEY = "hub:deviceId";
export declare function memoryKeyValue(): KeyValue;
export declare function browserKeyValue(kind: 'local' | 'session'): KeyValue;
export declare function getOrCreateDeviceId(storage?: KeyValue): string;
export declare function readNumber(storage: KeyValue, key: string): number;
export declare function writeNumber(storage: KeyValue, key: string, value: number): void;
//# sourceMappingURL=storage.d.ts.map