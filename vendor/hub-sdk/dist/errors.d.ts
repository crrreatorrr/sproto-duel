export declare class HubSdkError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(code: string, message: string, status?: number);
}
