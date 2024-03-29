import * as cassava from "cassava";
import * as dynameh from "dynameh";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {DbAccountUser} from "../../../db/DbAccountUser";
import {createdDateNow, dynamodb, objectDynameh} from "../../../db/dynamodb";
import {setUserIdTestMode, stripUserIdTestMode} from "../../../utils/userUtils";
import {DbUser} from "../../../db/DbUser";
import {AccountUser} from "../../../model/AccountUser";
import {DbAccount} from "../../../db/DbAccount";
import {Account} from "../../../model/Account";
import {getRolesForUserPrivilege} from "../../../utils/rolesUtils";
import {LoginResult} from "../../../model/LoginResult";
import {getLoginResponse} from "../login";
import log = require("loglevel");

export function installAccountRest(router: cassava.Router): void {
    router.route("/v2/account")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:read");
            auth.requireIds("userId");
            const account = await DbAccount.get(auth.userId);
            return {
                body: Account.getFromDbAccount(account)
            };
        });

    router.route("/v2/account")
        .method("PATCH")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:update");

            evt.validateBody({
                type: "object",
                properties: {
                    maxInactiveDays: {
                        type: ["number", "null"],
                        minimum: 7,
                        maximum: 999
                    },
                    maxPasswordAge: {
                        type: ["number", "null"],
                        minimum: 7,
                        maximum: 999
                    },
                    name: {
                        type: "string",
                        minLength: 1,
                        maxLength: 1023
                    },
                    requireMfa: {
                        type: "boolean"
                    }
                },
                required: [],
                additionalProperties: false
            });

            const account = await updateAccount(auth, evt.body);
            return {
                body: Account.getFromDbAccount(account)
            };
        });

    router.route("/v2/account")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:create");

            evt.validateBody({
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        minLength: 1,
                        maxLength: 1024
                    }
                },
                required: ["name"],
                additionalProperties: false
            });

            const account = await createAccount(auth, evt.body);

            return {
                body: Account.getFromDbAccount(account),
                statusCode: cassava.httpStatusCode.success.CREATED
            };
        });

    router.route("/v2/account/switch")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:user:read", "lightrailV2:user:update");
            auth.requireIds("teamMemberId");

            evt.validateBody({
                type: "object",
                properties: {
                    accountId: {
                        type: "string",
                        minLength: 1
                    },
                    mode: {
                        type: "string",
                        enum: ["live", "test"]
                    }
                },
                required: ["mode"],
                additionalProperties: false
            });

            const accountId = evt.body.accountId ?? auth.userId;
            const liveMode = evt.body.mode === "live";
            return await switchAccount(auth, accountId, liveMode);
        });

    router.route("/v2/account/users")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:users:list");
            auth.requireIds("userId");

            const account = await DbAccount.get(auth.userId);
            const accountUsers = await DbAccountUser.getAllForAccount(auth.userId);
            return {
                body: accountUsers.map(accountUser => AccountUser.fromDbAccountUser(account, accountUser))
            };
        });

    router.route("/v2/account/users/{id}")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:users:read");
            auth.requireIds("userId");

            const account = await DbAccount.get(auth.userId);
            const accountUser = await DbAccountUser.get(auth.userId, evt.pathParameters.id);
            if (!accountUser || accountUser.pendingInvitation) {
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find user with id '${evt.pathParameters.id}'.`, "UserNotFound");
            }
            return {
                body: AccountUser.fromDbAccountUser(account, accountUser)
            };
        });

    router.route("/v2/account/users/{id}")
        .method("PATCH")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:users:update");

            evt.validateBody({
                type: "object",
                properties: {
                    lockedByInactivity: {
                        type: "boolean"
                    },
                    roles: {
                        type: "array",
                        items: {
                            type: "string",
                            minLength: 1
                        }
                    },
                    scopes: {
                        type: "array",
                        items: {
                            type: "string",
                            minLength: 1
                        }
                    },
                },
                required: [],
                additionalProperties: false
            });

            const account = await DbAccount.get(auth.userId);
            const accountUser = await updateAccountUser(auth, evt.pathParameters.id, evt.body);
            return {
                body: AccountUser.fromDbAccountUser(account, accountUser)
            };
        });

    router.route("/v2/account/users/{id}")
        .method("DELETE")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:users:delete");
            await removeAccountUser(auth, evt.pathParameters.id);
            return {
                body: {}
            };
        });
}

interface UpdateAccountParams {
    maxInactiveDays?: number | null;
    maxPasswordAge?: number | null;
    name?: string;
    requireMfa?: boolean;
}

async function updateAccount(auth: giftbitRoutes.jwtauth.AuthorizationBadge, params: UpdateAccountParams): Promise<DbAccount> {
    auth.requireIds("userId");
    log.info("Updating Account", auth.userId);

    const account = await DbAccount.get(auth.userId);
    if (!account) {
        throw new Error(`Could not find DbAccount for user '${auth.userId}'`);
    }

    const updates: dynameh.UpdateExpressionAction[] = [];
    if (params.maxInactiveDays !== undefined) {
        if (params.maxInactiveDays !== null && params.maxInactiveDays <= 0) {
            throw new Error("params.maxInactiveDays can't be negative");
        }
        updates.push({
            action: "put",
            attribute: "maxInactiveDays",
            value: params.maxInactiveDays
        });
        account.maxInactiveDays = params.maxInactiveDays;
    }
    if (params.maxPasswordAge !== undefined) {
        if (params.maxPasswordAge !== null && params.maxPasswordAge <= 0) {
            throw new Error("params.maxPasswordAge can't be negative");
        }
        updates.push({
            action: "put",
            attribute: "maxPasswordAge",
            value: params.maxPasswordAge
        });
        account.maxPasswordAge = params.maxPasswordAge;
    }
    if (params.name) {
        updates.push({
            action: "put",
            attribute: "name",
            value: params.name
        });
        account.name = params.name;
    }
    if (params.requireMfa != null) {
        updates.push({
            action: "put",
            attribute: "requireMfa",
            value: params.requireMfa
        });
        account.requireMfa = params.requireMfa;
    }

    if (!updates.length) {
        return account;
    }

    await DbAccount.update(account, ...updates);

    // Update non-authoritative data.
    if (params.name) {
        log.info("Updating all DbAccountUser.accountDisplayName for Account", auth.userId);

        const accountUsers = await DbAccountUser.getAllForAccount(auth.userId);
        for (const accountUser of accountUsers) {
            try {
                await DbAccountUser.update(accountUser, {
                    attribute: "accountDisplayName",
                    action: "put",
                    value: params.name
                });
            } catch (error) {
                log.error("Unable to change accountDisplayName for AccountUser", accountUser.accountId, accountUser.userId, "\n", error);
            }
        }
    }

    return account;
}

async function createAccount(auth: giftbitRoutes.jwtauth.AuthorizationBadge, params: { name: string }): Promise<DbAccount> {
    auth.requireIds("teamMemberId");
    const accountId = DbAccount.generateAccountId();
    log.info("Creating new Account", accountId, "for existing user", auth.teamMemberId);

    const user = await DbUser.getByAuth(auth);
    if (!user) {
        throw new Error(`Could not find User for user '${auth.teamMemberId}'`);
    }

    const account: DbAccount = {
        accountId: accountId,
        name: params.name,
        createdDate: createdDateNow()
    };
    const createAccountReq = DbAccount.buildPutInput(account);

    const accountUser: DbAccountUser = {
        accountId: accountId,
        userId: stripUserIdTestMode(auth.teamMemberId),
        roles: getRolesForUserPrivilege("OWNER"),
        scopes: [],
        userDisplayName: user.email,
        accountDisplayName: account.name,
        createdDate: createdDateNow()
    };
    const createAccountUserReq = DbAccountUser.buildPutInput(accountUser);

    const writeReq = objectDynameh.requestBuilder.buildTransactWriteItemsInput(createAccountReq, createAccountUserReq);
    await dynamodb.transactWriteItems(writeReq).promise();

    return account;
}

async function switchAccount(auth: giftbitRoutes.jwtauth.AuthorizationBadge, accountId: string, liveMode: boolean): Promise<cassava.RouterResponse & { body: LoginResult }> {
    if (!accountId) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.BAD_REQUEST, "Cannot switch.  User is not logged into an account and accountId is not set.");
    }

    const user = await DbUser.getByAuth(auth);
    const accountUser = await DbAccountUser.get(accountId, user.userId);
    if (!accountUser) {
        log.warn("Could not switch user", user.userId, "to account", accountId, "AccountUser not found");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.FORBIDDEN);
    }
    if (accountUser.pendingInvitation) {
        log.warn("Could not switch user", user.userId, "to account", accountId, "invitation is still pending");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.FORBIDDEN);
    }

    await DbUser.update(user, {
        action: "put",
        attribute: "login.defaultLoginAccountId",
        value: liveMode ? stripUserIdTestMode(accountId) : setUserIdTestMode(accountId)
    });

    return getLoginResponse(user, accountUser, liveMode);
}

export async function updateAccountUser(auth: giftbitRoutes.jwtauth.AuthorizationBadge, userId: string, params: { lockedByInactivity?: boolean, roles?: string[], scopes?: string[] }): Promise<DbAccountUser> {
    auth.requireIds("userId");
    log.info("Updating AccountUser", userId, "in Account", auth.userId, "\n", params);

    const accountUser = await DbAccountUser.get(auth.userId, userId);
    if (!accountUser) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find user with id '${userId}'.`, "UserNotFound");
    }
    if (stripUserIdTestMode(auth.teamMemberId) === stripUserIdTestMode(userId)) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.FORBIDDEN, `You can't update your own permissions.`);
    }

    const updates: dynameh.UpdateExpressionAction[] = [];
    if (params.lockedByInactivity !== undefined) {
        // lockedByInactivity is not a flag that is set but is instead calculated.
        // Set the lastLoginDate to a magic number so it is calculated to match the patched value.
        const lastLoginDate = params.lockedByInactivity ? new Date(0).toISOString() : createdDateNow();
        updates.push({
            action: "put",
            attribute: "lastLoginDate",
            value: lastLoginDate
        });
        accountUser.lastLoginDate = lastLoginDate;
    }
    if (params.roles) {
        updates.push({
            action: "put",
            attribute: "roles",
            value: params.roles
        });
        accountUser.roles = params.roles;
    }
    if (params.scopes) {
        updates.push({
            action: "put",
            attribute: "scopes",
            value: params.scopes
        });
        accountUser.scopes = params.scopes;
    }

    if (updates.length) {
        await DbAccountUser.update(accountUser, ...updates);
    }
    return accountUser;
}

export async function removeAccountUser(auth: giftbitRoutes.jwtauth.AuthorizationBadge, userId: string): Promise<void> {
    auth.requireIds("userId");
    const accountId = auth.userId;
    log.info("Removing AccountUser", userId, "from Account", accountId);

    const accountUser = await DbAccountUser.get(accountId, userId);
    if (!accountUser) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find user with id '${userId}'.`, "UserNotFound");
    }
    if (accountUser.pendingInvitation) {
        log.info("The user is invited but not a full member");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find user with id '${userId}'.`, "UserNotFound");
    }
    if (stripUserIdTestMode(auth.teamMemberId) === stripUserIdTestMode(userId)) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.FORBIDDEN, `You can't delete yourself from your account.`);
    }

    try {
        await DbAccountUser.del(accountUser, {
            attribute: "pendingInvitation",
            operator: "attribute_not_exists"
        });
    } catch (error) {
        if (error.code === "ConditionalCheckFailedException") {
            log.info("The user is invited but not a full member");
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find user with id '${userId}'.`, "UserNotFound");
        }
        throw error;
    }
}
