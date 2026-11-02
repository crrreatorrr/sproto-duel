import { type GameId } from './types';
/**
 * Dev-only HMAC key. M0 tickets are shaped like the real fragment (`#t=`)
 * but are not a credential. M1 replaces this with `portal.enter`.
 */
export declare const MOCK_TICKET_KEY = "metaverse-hub-m0-mock-ticket-key";
declare const ISSUER = "hub-mock";
export interface TicketClaims {
    jti: string;
    game: GameId;
    ranked: boolean;
    /** Unix seconds. */
    exp: number;
    iat: number;
    iss: typeof ISSUER;
    playerId: string;
}
export interface MintTicketOptions {
    game: GameId;
    playerId: string;
    ranked?: boolean;
    ttlSeconds?: number;
    now?: number;
    jti?: string;
}
export declare function bytesToBase64Url(bytes: Uint8Array): string;
export declare function base64UrlToBytes(value: string): Uint8Array;
export declare function mintMockTicket(options: MintTicketOptions): Promise<string>;
export declare function verifyMockTicket(token: string): Promise<TicketClaims | null>;
export declare function readTicketParam(hash: string): string | null;
export declare function stripTicketParam(hash: string): string;
export {};
