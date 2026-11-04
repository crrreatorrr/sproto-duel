import { HubSdkError } from '../errors';
import type { ChatContent, ChatMessage, ChatTarget, MatchmakerUser, RealtimePresence } from './types';
export interface WirePresence {
    user_id?: string;
    session_id?: string;
    username?: string;
}
export interface WireMatchmakerUser {
    presence?: WirePresence;
    string_properties?: Record<string, string>;
    numeric_properties?: Record<string, number>;
}
export interface WireChannelMessage {
    channel_id?: string;
    message_id?: string;
    sender_id?: string;
    username?: string;
    content?: string;
    create_time?: string | number;
    persistent?: boolean;
}
/** Inbound envelope. Exactly one payload key is set (plus `cid` on replies). */
export interface Envelope {
    cid?: string;
    error?: {
        code?: number;
        message?: string;
        context?: Record<string, string>;
    };
    match?: {
        match_id?: string;
        authoritative?: boolean;
        label?: string | {
            value?: string;
        } | null;
        size?: number;
        presences?: WirePresence[];
        self?: WirePresence;
    };
    match_data?: {
        match_id?: string;
        presence?: WirePresence;
        op_code?: string | number;
        data?: string;
        reliable?: boolean;
    };
    match_presence_event?: {
        match_id?: string;
        joins?: WirePresence[];
        leaves?: WirePresence[];
    };
    /** Mock-only: an authoritative mock match ended. Real Nakama never sends it. */
    match_ended?: {
        match_id?: string;
    };
    matchmaker_ticket?: {
        ticket?: string;
    };
    matchmaker_matched?: {
        ticket?: string;
        match_id?: string;
        token?: string;
        users?: WireMatchmakerUser[];
        self?: WireMatchmakerUser;
    };
    channel?: {
        id?: string;
        presences?: WirePresence[];
        self?: WirePresence;
    };
    channel_message?: WireChannelMessage;
    channel_message_ack?: {
        channel_id?: string;
        message_id?: string;
    };
    channel_presence_event?: {
        channel_id?: string;
        joins?: WirePresence[];
        leaves?: WirePresence[];
    };
    rpc?: {
        id?: string;
        payload?: string;
    };
    pong?: Record<string, never>;
    notifications?: {
        notifications?: {
            id?: string;
            subject?: string;
            content?: string;
            code?: number;
            sender_id?: string;
            create_time?: string;
            persistent?: boolean;
        }[];
    };
    [other: string]: unknown;
}
export declare function utf8Encode(text: string): Uint8Array;
export declare function utf8Decode(bytes: Uint8Array): string;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(text: string): Uint8Array;
/** object → JSON text, string → UTF-8, Uint8Array as is. */
export declare function encodePayload(data: string | Uint8Array | object | undefined): Uint8Array;
export declare function presenceFromWire(p: WirePresence | undefined | null): RealtimePresence;
export declare function presenceToWire(p: RealtimePresence): WirePresence;
export declare function matchmakerUserFromWire(u: WireMatchmakerUser | undefined): MatchmakerUser;
export declare function labelFromWire(label: string | {
    value?: string;
} | null | undefined): string | null;
export declare function opCodeFromWire(op: string | number | undefined): number;
export declare function timeFromWire(value: string | number | undefined): number;
/** Nakama channel types: 1 room, 2 direct message, 3 group. */
export declare function channelJoinBody(target: ChatTarget, persistence: boolean, hidden: boolean): {
    target: string;
    type: 1 | 2 | 3;
    persistence: boolean;
    hidden: boolean;
};
export declare function chatContentFromWire(raw: string | undefined): ChatContent;
export declare function chatMessageFromWire(m: WireChannelMessage): ChatMessage;
/**
 * Server-thrown hook errors look like `Error: room_not_allowed at rtBeforeChannelJoin (index.js:37:199(22))`.
 * The code is the first `[a-z0-9_:.-]+` token after an optional `Error: ` prefix.
 */
export declare function errorCodeFromMessage(message: string | undefined, fallback: string): string;
/** Nakama realtime error codes (rtapi.Error.Code). */
export declare const RT_ERROR: {
    readonly RUNTIME_EXCEPTION: 0;
    readonly UNRECOGNIZED_PAYLOAD: 1;
    readonly MISSING_PAYLOAD: 2;
    readonly BAD_INPUT: 3;
    readonly MATCH_NOT_FOUND: 4;
    readonly MATCH_JOIN_REJECTED: 5;
    readonly RUNTIME_FUNCTION_NOT_FOUND: 6;
    readonly RUNTIME_FUNCTION_EXCEPTION: 7;
};
export declare function errorFromEnvelope(error: NonNullable<Envelope['error']>, kind?: 'match_join' | 'other'): HubSdkError;
