import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {DbApiKey} from "../../../db/DbApiKey";
import {createdDateNow} from "../../../db/dynamodb";
import {ApiKey} from "../../../model/ApiKey";
import {DbUserLogin} from "../../../db/DbUserLogin";
import {isTestModeUserId, stripUserIdTestMode} from "../../../utils/userUtils";
import {DbAccountUser} from "../../../db/DbAccountUser";
import log = require("loglevel");

export function installApiKeysRest(router: cassava.Router): void {
    router.route("/v2/account/apiKeys")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:apiKeys:list");
            auth.requireIds("userId");

            const apiKeys = await DbApiKey.getAllForAccount(auth.userId);
            return {
                body: apiKeys.map(ApiKey.fromDbApiKey)
            };
        });

    router.route("/v2/account/apiKeys")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:apiKeys:create");

            evt.validateBody({
                properties: {
                    name: {
                        type: "string",
                        minLength: 1
                    }
                }
            });

            const apiKey = await createApiKey(auth, evt.body.name);
            return {
                body: apiKey,
                statusCode: cassava.httpStatusCode.success.CREATED
            };
        });

    router.route("/v2/account/apiKeys/{id}")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:apiKeys:read");
            auth.requireIds("userId");

            const apiKey = await DbApiKey.getByAccount(auth.userId, evt.pathParameters.id);
            if (!apiKey) {
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find api key with id '${evt.pathParameters.id}'.`, "ApiKeyNotFound");
            }
            return {
                body: ApiKey.fromDbApiKey(apiKey)
            };
        });

    router.route("/v2/account/apiKeys/{id}")
        .method("DELETE")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:apiKeys:delete");
            await deleteApiKey(auth, evt.pathParameters.id);
            return {
                body: {}
            };
        });
}

async function createApiKey(auth: giftbitRoutes.jwtauth.AuthorizationBadge, name: string): Promise<ApiKey> {
    auth.requireIds("userId", "teamMemberId");

    log.info("Creating API key for", auth.userId, auth.teamMemberId, "with name", name);

    const teamMember = await DbAccountUser.getByAuth(auth);
    const apiKey: DbApiKey = {
        accountId: stripUserIdTestMode(auth.userId),
        userId: stripUserIdTestMode(auth.teamMemberId),
        name: name,
        tokenId: DbApiKey.generateTokenId(),
        tokenVersion: 3,
        roles: teamMember.roles,
        scopes: teamMember.scopes,
        createdDate: createdDateNow()
    };
    await DbApiKey.put(apiKey);

    const badge = DbUserLogin.getBadge(teamMember, isTestModeUserId(auth.userId), false);
    badge.uniqueIdentifier = apiKey.tokenId;
    const apiToken = await DbUserLogin.getBadgeApiToken(badge);

    log.info("Created API key with tokenId", apiKey.tokenId);

    return ApiKey.createResponse(apiKey, apiToken);
}

async function deleteApiKey(auth: giftbitRoutes.jwtauth.AuthorizationBadge, tokenId: string): Promise<void> {
    auth.requireIds("userId");
    log.info("Deleting API key for", auth.userId, "with tokenId", tokenId);

    const apiKey = await DbApiKey.getByAccount(auth.userId, tokenId);
    if (!apiKey) {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.NOT_FOUND, `Could not find api key with id '${tokenId}'.`, "ApiKeyNotFound");
    }

    await DbApiKey.del(apiKey);

    // At this point we've forgotten about the API key but not actually revoked it anywhere.
    // Users will expect the API key will stop working and we're not meeting those expectations.
    // That will need to be fixed very soon and this is where that call needs to happen.
}
