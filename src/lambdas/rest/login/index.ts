import * as cassava from "cassava";
import * as dynameh from "dynameh";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as uuid from "uuid";
import {createdDateFuture, createdDateNow, createdDatePast} from "../../../db/dynamodb";
import {validatePassword} from "../../../utils/passwordUtils";
import {sendRegistrationVerificationEmail} from "../registration/sendRegistrationVerificationEmail";
import {DbUser} from "../../../db/DbUser";
import {sendSmsMfaChallenge} from "../mfa";
import {sendFailedLoginTimeoutEmail} from "./sendFailedLoginTimeoutEmail";
import {RouterResponseCookie} from "cassava/dist/RouterResponse";
import {decryptSecret, validateTotpCode} from "../../../utils/secretsUtils";
import {DbAccountUser} from "../../../db/DbAccountUser";
import {DbAccount} from "../../../db/DbAccount";
import {LoginResult} from "../../../model/LoginResult";
import {User} from "../../../model/User";
import {isTestModeUserId} from "../../../utils/userUtils";
import log = require("loglevel");

const failedLoginTimeoutMinutes = 60;
const trustedDeviceExpirationSeconds = 14 * 24 * 60 * 60;
const totpUsedCodeTimeoutMillis = 3 * 60 * 1000;

export function installLoginUnauthedRest(router: cassava.Router): void {
    router.route("/v2/user/login")
        .method("POST")
        .handler(async evt => {
            evt.validateBody({
                type: "object",
                properties: {
                    email: {
                        type: "string"
                    },
                    password: {
                        type: "string"
                    }
                },
                required: ["email", "password"],
                additionalProperties: false
            });

            return await loginUserByPassword({
                email: evt.body.email,
                plaintextPassword: evt.body.password,
                ip: evt.headersLowerCase["x-forwarded-for"].split(",")[0],
                trustedDeviceToken: evt.cookies["gb_ttd"]
            });
        });

    router.route("/v2/user/logout")
        .handler(async () => {
            return {
                body: {},
                statusCode: cassava.httpStatusCode.success.OK,
                headers: {
                    Location: "/app/#"
                },
                cookies: {
                    "gb_jwt_session": {
                        value: "",
                        options: {
                            httpOnly: false,
                            expires: new Date(0),   // Clears the cookie per RFC 6255.
                            path: "/",
                            secure: true,
                        }
                    },
                    "gb_jwt_signature": {
                        value: "",
                        options: {
                            httpOnly: true,
                            expires: new Date(0),
                            path: "/",
                            secure: true,
                        }
                    }
                }
            };
        });
}

export function installLoginAuthedRest(router: cassava.Router): void {
    router.route("/v2/user/login/mfa")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:authenticate");

            const user = await DbUser.getByAuth(auth);
            if (user.login.mfa && user.login.mfa.smsDevice) {
                await sendSmsMfaChallenge(user);
            }
            return {
                body: {}
            };
        });

    router.route("/v2/user/login/mfa")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:authenticate");

            evt.validateBody({
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        minLength: 1
                    },
                    trustThisDevice: {
                        type: "boolean"
                    }
                },
                required: ["code"],
                additionalProperties: false
            });

            return await completeMfaLogin(auth, {
                code: evt.body.code,
                trustThisDevice: evt.body.trustThisDevice,
                sourceIp: evt.requestContext.identity.sourceIp
            });
        });
}

/**
 * Login the user by manually entered email and password.
 */
async function loginUserByPassword(params: { email: string, plaintextPassword: string, ip: string, trustedDeviceToken?: string }): Promise<cassava.RouterResponse> {
    const user = await DbUser.get(params.email);

    // If the user can't log in we don't want to give away if the password is valid.
    await verifyUserCanLogin(user);

    if (!await validatePassword(params.plaintextPassword, user.login.password)) {
        log.warn("Could not log in user", params.email, "password did not validate");
        await completeLoginFailure(user, params.ip);
    }
    log.info("Password validated for user", params.email, "ip", params.ip);

    return loginUserFirstFactorAccepted(user, {trustedDeviceToken: params.trustedDeviceToken});
}

/**
 * Login the user by an email action (link).
 * If MFA is enabled the user will still be required to enter it.
 *
 * @param user the User to log in
 * @param redirect Sends a redirect response when set.
 */
export async function loginUserByEmailAction(user: DbUser, redirect?: { location: string }): Promise<cassava.RouterResponse & { body: LoginResult }> {
    const response = await loginUserFirstFactorAccepted(user, {});
    if (redirect) {
        response.body = null;
        response.statusCode = cassava.httpStatusCode.redirect.FOUND;
        cassava.RouterResponse.setHeader(response, "Location", redirect.location);
    }
    return response;
}

async function loginUserFirstFactorAccepted(user: DbUser, params: { trustedDeviceToken?: string }): Promise<cassava.RouterResponse & { body: LoginResult }> {
    await verifyUserCanLogin(user);

    if (user.login.mfa) {
        if (params.trustedDeviceToken) {
            if (user.login.mfa.trustedDevices[params.trustedDeviceToken] && user.login.mfa.trustedDevices[params.trustedDeviceToken].expiresDate > createdDateNow()) {
                log.info("User", user.email, "has a trusted device");
                return await completeLoginSuccess(user);
            }
            log.info("User", user.email, "trusted device token is not trusted");
            log.debug("params.trustedDeviceToken=", params.trustedDeviceToken, "trustedDevices=", user.login.mfa.trustedDevices);
        }
        if (user.login.mfa.smsDevice) {
            log.info("Partially logged in user", user.email, "sending SMS code");

            await sendSmsMfaChallenge(user);
            return getLoginAdditionalAuthenticationRequiredResponse(user);
        }
        if (user.login.mfa.totpSecret) {
            log.info("Partially logged in user", user.email, "awaiting TOTP code");
            return getLoginAdditionalAuthenticationRequiredResponse(user);
        }
    }

    return completeLoginSuccess(user);
}

/**
 * Check basic properties on the DbUser that would prevent
 * them from logging in regardless of Account.
 */
async function verifyUserCanLogin(user: DbUser): Promise<void> {
    if (!user) {
        log.warn("Could not log in user, user not found");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
    }
    if (!user.login.emailVerified) {
        log.warn("Could not log in user", user.email, "email is not verified");
        if (!DbUser.limitedActions.isThrottled(user, "accountActivationEmail")) {
            await DbUser.limitedActions.add(user, "accountActivationEmail");
            await sendRegistrationVerificationEmail(user.email);
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED, "You must verify your email address before you can log in.  A new registration email has been sent to your email address.");
        } else {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED, "You must verify your email address before you can log in.  You have already received a verification email.");
        }
    }
    if (user.login.frozen) {
        log.warn("Could not log in user", user.email, "user is frozen");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
    }
    if (user.login.lockedUntilDate && user.login.lockedUntilDate >= createdDateNow()) {
        log.warn("Could not log in user", user.email, "user is locked until", user.login.lockedUntilDate);
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
    }
}

async function completeMfaLogin(auth: giftbitRoutes.jwtauth.AuthorizationBadge, params: { code: string, trustThisDevice?: boolean, sourceIp: string }): Promise<cassava.RouterResponse> {
    const user = await DbUser.getByAuth(auth);

    if (user.login.frozen) {
        log.warn("Could not log in user", user.userId, "user is frozen");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
    }
    if (user.login.lockedUntilDate && user.login.lockedUntilDate >= createdDateNow()) {
        log.warn("Could not log in user", user.userId, "user is locked until", user.login.lockedUntilDate);
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
    }
    if (!user.login.mfa) {
        log.warn("Could not log in user", user.userId, "MFA is not enabled");
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
    }

    const userUpdates: dynameh.UpdateExpressionAction[] = [];
    const userUpdateConditions: dynameh.Condition[] = [];
    const additionalCookies: { [key: string]: RouterResponseCookie } = {};
    if (user.login.mfa.smsAuthState
        && user.login.mfa.smsAuthState.action === "auth"
        && user.login.mfa.smsAuthState.expiresDate >= createdDateNow()
        && user.login.mfa.smsAuthState.code === params.code.toUpperCase()
    ) {
        // SMS
        userUpdates.push({
            action: "remove",
            attribute: "login.mfa.smsAuthState"
        });

        // With this condition login will fail unless this code has not been used yet.
        // This prevents racing a quick replay of the login.
        userUpdateConditions.push({
            operator: "attribute_exists",
            attribute: "login.mfa.smsAuthState"
        });
    } else if (user.login.mfa.totpSecret && await validateTotpCode(user.login.mfa.totpSecret, params.code)) {
        // TOTP
        if (user.login.mfa.totpUsedCodes[params.code]) {
            // This code has been used recently.  Login completion is not successful but this is not a serious failure.
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
        }

        const totpUsedCode: DbUser.TotpUsedCode = {
            createdDate: createdDateNow()
        };
        userUpdates.push({
            action: "put",
            attribute: `login.mfa.totpUsedCodes.${params.code}`,
            value: totpUsedCode
        });

        // With this condition login will fail unless this code has not been used recently.
        // This prevents racing a quick replay of the login.
        userUpdateConditions.push({
            operator: "attribute_not_exists",
            attribute: `login.mfa.totpUsedCodes.${params.code}`
        });

        // Remove previously used codes that have expired.
        const usedCodeExpiration = new Date(Date.now() + totpUsedCodeTimeoutMillis).toISOString();
        for (const usedCode in user.login.mfa.totpUsedCodes) {
            if (user.login.mfa.totpUsedCodes[usedCode] && user.login.mfa.totpUsedCodes[usedCode].createdDate < usedCodeExpiration) {
                userUpdates.push({
                    action: "remove",
                    attribute: `login.mfa.totpUsedCodes.${usedCode}`
                });
            }
        }
    } else if (user.login.mfa.backupCodes && await getMatchingEncryptedBackupCode(user, params.code)) {
        // Backup code
        const encryptedBackupCode = await getMatchingEncryptedBackupCode(user, params.code);
        userUpdates.push({
            action: "remove",
            attribute: `login.mfa.backupCodes.${encryptedBackupCode}`
        });

        // With this condition login will fail unless this backup code is not yet deleted.
        // This prevents racing a quick replay of the login.
        userUpdateConditions.push({
            operator: "attribute_exists",
            attribute: `login.mfa.backupCodes.${encryptedBackupCode}`
        });
    } else {
        log.warn("Could not log in user", auth.teamMemberId, "auth code", params.code, "did not match any known methods. smsAuthState=", user.login?.mfa?.smsAuthState);
        return await completeLoginFailure(user, params.sourceIp);
    }

    if (params.trustThisDevice) {
        const trustedDeviceToken = uuid.v4().replace(/-/g, "");
        const trustedDevice: DbUser.TrustedDevice = {
            createdDate: createdDateNow(),
            expiresDate: new Date(Date.now() + trustedDeviceExpirationSeconds * 1000).toISOString()
        };
        userUpdates.push({
            action: "put",
            attribute: `login.mfa.trustedDevices.${trustedDeviceToken}`,
            value: trustedDevice
        });
        additionalCookies["gb_ttd"] = {
            value: trustedDeviceToken,
            options: {
                httpOnly: true,
                maxAge: trustedDeviceExpirationSeconds,
                path: "/",
                secure: true
            }
        };
    }

    const loginResponse = await completeLoginSuccess(user, userUpdates, userUpdateConditions);
    if (additionalCookies) {
        loginResponse.cookies = {
            ...loginResponse.cookies,
            ...additionalCookies
        };
    }
    return loginResponse;
}

async function getMatchingEncryptedBackupCode(user: DbUser, code: string): Promise<string | null> {
    code = code.toUpperCase();
    for (const encryptedBackupCode of Object.keys(user.login.mfa.backupCodes)) {
        const decryptedCode = await decryptSecret(encryptedBackupCode);
        if (decryptedCode === code) {
            return encryptedBackupCode;
        }
    }
    return null;
}

/**
 * Complete login after the user has used MFA if required,
 */
async function completeLoginSuccess(user: DbUser, additionalUpdates: dynameh.UpdateExpressionAction[] = [], updateConditions: dynameh.Condition[] = []): Promise<cassava.RouterResponse> {
    log.info("Logged in user", user.email);

    const userUpdates: dynameh.UpdateExpressionAction[] = [
        {
            action: "put",
            attribute: "login.lastLoginDate",
            value: createdDateNow()
        },
        ...additionalUpdates,
        ...DbUser.limitedActions.buildClearOutdatedUpdateActions(user)
    ];

    if (user.login.lockedUntilDate) {
        userUpdates.push({
            action: "remove",
            attribute: "login.lockedUntilDate"
        });
    }
    if (user.login?.mfa?.trustedDevices) {
        // Clear expired trusted devices.
        const now = createdDateNow();
        for (const trustedDeviceToken in user.login.mfa.trustedDevices) {
            if (user.login.mfa.trustedDevices[trustedDeviceToken] && user.login.mfa.trustedDevices[trustedDeviceToken].expiresDate < now) {
                userUpdates.push({
                    action: "remove",
                    attribute: `login.mfa.trustedDevices.${trustedDeviceToken}`
                });
            }
        }
    }

    try {
        await DbUser.conditionalUpdate(user, userUpdates, updateConditions);
    } catch (err) {
        if (err.code === "ConditionalCheckFailedException") {
            log.warn("Complete login DynamoDB ConditionalCheckFailedException.  Possible replay attack, or duplicated call from network error.  updateConditions=", updateConditions, "err=", err);
            // There's a good chance this isn't malicious so we won't go through
            // completeLoginFailure() and mark it as a failed attempt.
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
        }
        log.error("Error updating DbUser on login userUpdates=", JSON.stringify(userUpdates), "updateConditions=", JSON.stringify(updateConditions));
        throw err;
    }

    const accountUser = await DbAccountUser.getForUserLogin(user);
    const liveMode = !isTestModeUserId(user.login.defaultLoginAccountId);
    return getLoginResponse(user, accountUser, liveMode);
}

async function completeLoginFailure(user: DbUser, ip: string): Promise<never> {
    if (DbUser.limitedActions.isThrottled(user, "failedLogin")) {
        log.info("Too many failed login attempts for user", user.userId, user.email, user.limitedActions["failedLogin"]);

        await Promise.all([
            DbUser.update(
                user,
                DbUser.limitedActions.buildClearAllUpdateAction("failedLogin"),
                {
                    action: "put",
                    attribute: "login.lockedUntilDate",
                    value: createdDateFuture(0, 0, 0, 0, failedLoginTimeoutMinutes)
                }
            ),
            sendFailedLoginTimeoutEmail(user, failedLoginTimeoutMinutes)
        ])
    } else {
        log.info("Failed login attempt for user", user.userId, "ip", user.email, ip);
        await DbUser.limitedActions.add(user, "failedLogin");
    }

    throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNAUTHORIZED);
}

/**
 * Get the cassava login response that includes the correct permissions or error status.
 * At this point the user is fully authenticated, and the only question is what they're
 * allowed to do with that authentication.
 *
 * @param user The user that has successfully logged in.
 * @param accountUser The DbAccountUser of the Account to log in to.  If null then the
 *                    user has no Account and can only create one.
 * @param liveMode Whether to log in as live (or test) to the Account.
 */
export async function getLoginResponse(user: DbUser, accountUser: DbAccountUser | null, liveMode: boolean): Promise<cassava.RouterResponse & { body: LoginResult }> {
    if (!user.login.password) {
        throw new Error(`User '${user.email}' does not have a password set and should not be sent to getLoginResponse().`);
    }

    let message: string | undefined = undefined;
    let messageCode: string | undefined = undefined;
    let badge: giftbitRoutes.jwtauth.AuthorizationBadge;

    const account = accountUser && await DbAccount.get(accountUser.accountId);
    log.debug("Get login response for account=", account, "user=", user.email, user.userId);

    if (!account) {
        message = "You have been removed from all Accounts.  You can create your own to continue.";
        messageCode = "NoAccount";
        badge = DbUser.getOrphanBadge(user);
    } else if (account.requireMfa && !DbUser.hasMfaActive(user)) {
        message = "The Account requires that MFA is enabled to continue.";
        messageCode = "AccountMfaRequired";
        badge = DbUser.getOrphanBadge(user);
    } else if (account.maxPasswordAge && user.login.password.createdDate < createdDatePast(0, 0, account.maxPasswordAge)) {
        message = `You have an old password and the Account requires passwords change every ${account.maxPasswordAge} days.`;
        messageCode = "AccountMaxPasswordAge";
        badge = DbUser.getOrphanBadge(user);
    } else if (DbAccountUser.isLockedByInactivity(accountUser, account)) {
        message = `You have been locked out for being inactive for more than ${account.maxInactiveDays} days.`;
        messageCode = "AccountMaxInactiveDays";
        badge = DbUser.getOrphanBadge(user);
    } else if (account.frozen) {
        message = "This Account has been frozen and you cannot log in to it.  For more information contact customer support.  You may create or switch to another Account.";
        messageCode = "AccountFrozen";
        badge = DbUser.getOrphanBadge(user);
    } else {
        badge = DbUser.getBadge(accountUser, liveMode);
    }

    log.info("Login response for user", user.email, user.userId, "message=", message, "messageCode=", messageCode);

    return {
        body: {
            user: User.getFromDbUser(user, badge),
            message,
            messageCode
        },
        statusCode: cassava.httpStatusCode.success.OK,
        cookies: {
            ...await DbUser.getBadgeCookies(badge)
        },
        headers: {},
        multiValueHeaders: {}
    };
}

async function getLoginAdditionalAuthenticationRequiredResponse(user: DbUser): Promise<cassava.RouterResponse & { body: LoginResult }> {
    log.debug("Get login additional authentication response for user=", user.email, user.userId);

    const badge = DbUser.getAdditionalAuthenticationRequiredBadge(user);
    const body: LoginResult = {
        user: User.getFromDbUser(user, badge),
        message: "Additional authentication through MFA is required.",
        messageCode: "MfaAuthRequired"
    };

    return {
        body: body,
        statusCode: cassava.httpStatusCode.success.OK,
        cookies: await DbUser.getBadgeCookies(badge)
    };
}
