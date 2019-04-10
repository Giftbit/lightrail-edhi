import * as uuid from "uuid/v4";
import {dynamodb, tokenActionDynameh} from "./dynamodb";

/**
 * Allows actions based upon passing the token to the correct endpoint.
 * Eg: confirm email address, reset password.
 */
export interface TokenAction {
    token: string;
    action: TokenAction.Action;
    email: string;
    userId?: string;
    teamMemberId?: string;
    ttl: Date | number;
}

export namespace TokenAction {
    export type Action = "emailVerification" | "resetPassword" | "acceptTeamInvite" | "changeEmail";

    export interface GenerateAdditionalParams {
        email: string;
        userId?: string;
        teamMemberId?: string;
    }

    export function generate(action: Action, durationInHours: number, params: GenerateAdditionalParams): TokenAction {
        const timeoutDate = new Date();
        timeoutDate.setHours(timeoutDate.getHours() + durationInHours);
        return {
            token: uuid().replace(/-/g, ""),
            action: action,
            ttl: timeoutDate,
            ...params
        };
    }

    export async function get(token: string): Promise<TokenAction> {
        if (!token) {
            return null;
        }

        const req = tokenActionDynameh.requestBuilder.buildGetInput(token);
        const resp = await dynamodb.getItem(req).promise();
        return tokenActionDynameh.responseUnwrapper.unwrapGetOutput(resp);
    }

    export async function put(tokenAction: TokenAction): Promise<void> {
        const req = tokenActionDynameh.requestBuilder.buildPutInput(tokenAction);
        await dynamodb.putItem(req).promise();
    }

    export async function del(tokenAction: TokenAction): Promise<void> {
        const req = tokenActionDynameh.requestBuilder.buildDeleteInput(tokenAction);
        await dynamodb.deleteItem(req).promise();
    }
}
