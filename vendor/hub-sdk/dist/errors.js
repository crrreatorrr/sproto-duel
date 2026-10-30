export class HubSdkError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.name = 'HubSdkError';
        this.code = code;
        this.status = status;
    }
}
