import {DbApiKey} from "../db/DbApiKey";

export interface ApiKey {

    accountId: string;
    userId: string;
    name: string;
    tokenId: string;
    roles: string[];
    scopes: string[];
    createdDate: string;

    // This is only set as a response when the token is first created.
    token?: string;

}

export namespace ApiKey {

    export function fromDbApiKey(apiKey: DbApiKey): ApiKey {
        return {
            accountId: apiKey.accountId,
            userId: apiKey.userId,
            name: apiKey.name,
            tokenId: apiKey.tokenId,
            roles: apiKey.roles,
            scopes: apiKey.scopes,
            createdDate: apiKey.createdDate
        };
    }

    export function createResponse(apiKey: DbApiKey, token: string): ApiKey {
        const res = fromDbApiKey(apiKey);
        res.token = token;
        return res;
    }
}
