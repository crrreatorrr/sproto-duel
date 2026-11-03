export declare class HubSdkError extends Error {
    readonly code: string;
    readonly status?: number;
    /** Tickets still allowed under the cap that rejected the call. */
    readonly capLeft?: number;
    readonly sessionCapLeft?: number;
    readonly dailyCapLeft?: number;
    constructor(code: string, message: string, status?: number, capLeft?: number, sessionCapLeft?: number, dailyCapLeft?: number);
}
