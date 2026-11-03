export class HubSdkError extends Error {
    code;
    status;
    /** Tickets still allowed under the cap that rejected the call. */
    capLeft;
    sessionCapLeft;
    dailyCapLeft;
    constructor(code, message, status, capLeft, sessionCapLeft, dailyCapLeft) {
        super(message);
        this.name = 'HubSdkError';
        this.code = code;
        this.status = status;
        this.capLeft = capLeft;
        this.sessionCapLeft = sessionCapLeft ?? (code === 'session_ticket_cap' ? capLeft : undefined);
        this.dailyCapLeft = dailyCapLeft ?? (code === 'daily_ticket_cap' ? capLeft : undefined);
    }
}
