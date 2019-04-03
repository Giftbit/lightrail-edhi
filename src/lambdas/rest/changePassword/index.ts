import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {dynamodb, userDynameh} from "../../../db/dynamodb";
import {DbUser, UserPassword} from "../../../db/DbUser";
import {hashPassword, validatePassword} from "../../../utils/passwordUtils";
import log = require("loglevel");

export function installChangePasswordRest(router: cassava.Router): void {
    router.route("/v2/user/changePassword")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("teamMemberId");

            evt.validateBody({
                properties: {
                    oldPassword: {
                        type: "string"
                    },
                    newPassword: {
                        type: "string",
                        minLength: 8
                    }
                },
                required: ["oldPassword", "newPassword"],
                additionalProperties: false
            });

            await changePassword({
                auth,
                oldPlaintextPassword: evt.body.oldPassword,
                newPlaintextPassword: evt.body.newPassword
            });

            return {
                body: {},
                statusCode: cassava.httpStatusCode.success.OK
            };
        });
}

async function changePassword(params: { auth: giftbitRoutes.jwtauth.AuthorizationBadge, oldPlaintextPassword: string, newPlaintextPassword: string }): Promise<void> {
    const user = await DbUser.getByAuth(params.auth);

    if (!await validatePassword(params.oldPlaintextPassword, user.password)) {
        log.warn("Could change user password for", user.email, "old password did not validate");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, "Old password does not match.");
    }

    const userPassword: UserPassword = await hashPassword(params.newPlaintextPassword);
    const updateUserReq = userDynameh.requestBuilder.buildUpdateInputFromActions(user, {
        action: "put",
        attribute: "password",
        value: userPassword
    });
    userDynameh.requestBuilder.addCondition(updateUserReq, {
        attribute: "email",
        operator: "attribute_exists"
    });
    await dynamodb.updateItem(updateUserReq).promise();
    log.info("User", user.email, "has changed their password");
}
