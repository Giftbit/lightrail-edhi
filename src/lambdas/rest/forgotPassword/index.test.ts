import * as cassava from "cassava";
import * as chai from "chai";
import * as sinon from "sinon";
import * as emailUtils from "../../../utils/emailUtils";
import * as testUtils from "../../../utils/testUtils";
import {generateId} from "../../../utils/testUtils";
import {TestRouter} from "../../../utils/testUtils/TestRouter";
import {installUnauthedRestRoutes} from "../installUnauthedRestRoutes";
import {installAuthedRestRoutes} from "../installAuthedRestRoutes";
import {DbUser} from "../../../db/DbUser";
import {Account} from "../../../model/Account";
import {LoginResult} from "../../../model/LoginResult";

describe("/v2/user/forgotPassword", () => {

    const router = new TestRouter();
    const sinonSandbox = sinon.createSandbox();

    before(async () => {
        await testUtils.resetDb();
        installUnauthedRestRoutes(router);
        router.route(testUtils.authRoute);
        installAuthedRestRoutes(router);
        DbUser.initializeBadgeSigningSecrets(Promise.resolve({secretkey: "secret"}));
    });

    afterEach(() => {
        sinonSandbox.restore();
    });

    it("accepts an unknown email address but no email is actually sent", async () => {
        let gotEmail = false;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                gotEmail = true;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.generateValidEmailAddress()
        });
        chai.assert.isFalse(gotEmail);
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
    });

    it("can reset the password (using the webapp)", async () => {
        let resetPasswordEmail: emailUtils.SendEmailParams;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                resetPasswordEmail = params;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.defaultTestUser.user.email
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isDefined(resetPasswordEmail);
        chai.assert.include(resetPasswordEmail.htmlBody, "Copyright " + new Date().getFullYear(), "copyright is set for this year");
        chai.assert.match(resetPasswordEmail.htmlBody, /Copyright 20\d\d/, "copyright is full year");
        chai.assert.notMatch(resetPasswordEmail.htmlBody, /{{.*}}/, "No unreplaced tokens.");

        const resetPasswordToken = /https:\/\/.*resetPassword\?token=([a-zA-Z0-9]*)/.exec(resetPasswordEmail.htmlBody)[1];
        chai.assert.isString(resetPasswordToken, "Found reset password url in email body.");

        const password = generateId();
        const completeResp = await router.testUnauthedRequest<LoginResult>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password
        });
        chai.assert.equal(completeResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isString(completeResp.getCookie("gb_jwt_session"));
        chai.assert.isString(completeResp.getCookie("gb_jwt_signature"));

        // Is logged in after completing.
        const getAccountResp = await router.testPostLoginRequest<Account>(completeResp, "/v2/account", "GET");
        chai.assert.equal(getAccountResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.equal(getAccountResp.body.id, testUtils.defaultTestUser.accountId);

        // Old password doesn't work.
        const badLoginResp = await router.testUnauthedRequest<any>("/v2/user/login", "POST", {
            email: testUtils.defaultTestUser.user.email,
            password: testUtils.defaultTestUser.password
        });
        chai.assert.equal(badLoginResp.statusCode, cassava.httpStatusCode.clientError.UNAUTHORIZED);

        // New password works.
        const loginResp = await router.testUnauthedRequest<any>("/v2/user/login", "POST", {
            email: testUtils.defaultTestUser.user.email,
            password
        });
        chai.assert.equal(loginResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isString(loginResp.getCookie("gb_jwt_session"));
        chai.assert.isString(loginResp.getCookie("gb_jwt_signature"));

        // Can't use the same email to reset the password again
        const completeRepeatResp = await router.testUnauthedRequest<any>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password
        });
        chai.assert.equal(completeRepeatResp.statusCode, cassava.httpStatusCode.clientError.CONFLICT);
    });

    it("can't reset to a short password", async () => {
        let resetPasswordEmail: emailUtils.SendEmailParams;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                resetPasswordEmail = params;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.defaultTestUser.user.email
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isDefined(resetPasswordEmail);
        chai.assert.notMatch(resetPasswordEmail.htmlBody, /{{.*}}/, "No unreplaced tokens.");

        const resetPasswordToken = /https:\/\/.*resetPassword\?token=([a-zA-Z0-9]*)/.exec(resetPasswordEmail.htmlBody)[1];
        chai.assert.isString(resetPasswordToken, "Found reset password url in email body.");

        const badCompleteResp = await router.testUnauthedRequest<any>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password: "tj5ptT#"
        });
        chai.assert.equal(badCompleteResp.statusCode, cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY);
    });

    it("can't reset to a ridiculously long password", async () => {
        let resetPasswordEmail: emailUtils.SendEmailParams;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                resetPasswordEmail = params;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.defaultTestUser.user.email
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isDefined(resetPasswordEmail);
        chai.assert.notMatch(resetPasswordEmail.htmlBody, /{{.*}}/, "No unreplaced tokens.");

        const resetPasswordToken = /https:\/\/.*resetPassword\?token=([a-zA-Z0-9]*)/.exec(resetPasswordEmail.htmlBody)[1];
        chai.assert.isString(resetPasswordToken, "Found reset password url in email body.");

        const newPassword = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in";
        chai.assert.lengthOf(newPassword, 256);
        const badCompleteResp = await router.testUnauthedRequest<any>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password: newPassword
        });
        chai.assert.equal(badCompleteResp.statusCode, cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY);
    });

    it("can't reset to a password of just digits", async () => {
        let resetPasswordEmail: emailUtils.SendEmailParams;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                resetPasswordEmail = params;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.defaultTestUser.user.email
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isDefined(resetPasswordEmail);
        chai.assert.notMatch(resetPasswordEmail.htmlBody, /{{.*}}/, "No unreplaced tokens.");

        const resetPasswordToken = /https:\/\/.*resetPassword\?token=([a-zA-Z0-9]*)/.exec(resetPasswordEmail.htmlBody)[1];
        chai.assert.isString(resetPasswordToken, "Found reset password url in email body.");

        const badCompleteResp = await router.testUnauthedRequest<any>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password: "1234567654321"
        });
        chai.assert.equal(badCompleteResp.statusCode, cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY);
    });

    it("can't reset to a very common password", async () => {
        let resetPasswordEmail: emailUtils.SendEmailParams;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                resetPasswordEmail = params;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.defaultTestUser.user.email
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isDefined(resetPasswordEmail);
        chai.assert.notMatch(resetPasswordEmail.htmlBody, /{{.*}}/, "No unreplaced tokens.");

        const resetPasswordToken = /https:\/\/.*resetPassword\?token=([a-zA-Z0-9]*)/.exec(resetPasswordEmail.htmlBody)[1];
        chai.assert.isString(resetPasswordToken, "Found reset password url in email body.");

        const badCompleteResp = await router.testUnauthedRequest<any>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password: "baseball"
        });
        chai.assert.equal(badCompleteResp.statusCode, cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY, badCompleteResp.bodyRaw);
    });

    it("can't reset to a recently-used password", async () => {
        const newUser = await testUtils.testInviteNewUser(router, sinonSandbox);

        const newUserNewPassword = generateId();
        const changePasswordResp = await router.testPostLoginRequest(newUser.loginResp, "/v2/user/changePassword", "POST", {
            oldPassword: newUser.password,
            newPassword: newUserNewPassword
        });
        chai.assert.equal(changePasswordResp.statusCode, cassava.httpStatusCode.success.OK, changePasswordResp.bodyRaw);

        let resetPasswordEmail: emailUtils.SendEmailParams;
        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async (params: emailUtils.SendEmailParams) => {
                resetPasswordEmail = params;
                return null;
            });

        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: newUser.email
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK);
        chai.assert.isDefined(resetPasswordEmail);
        chai.assert.notMatch(resetPasswordEmail.htmlBody, /{{.*}}/, "No unreplaced tokens.");

        const resetPasswordToken = /https:\/\/.*resetPassword\?token=([a-zA-Z0-9]*)/.exec(resetPasswordEmail.htmlBody)[1];
        chai.assert.isString(resetPasswordToken, "Found reset password url in email body.");

        const badCompleteResp = await router.testUnauthedRequest<any>(`/v2/user/forgotPassword/complete`, "POST", {
            token: resetPasswordToken,
            password: newUser.password
        });
        chai.assert.equal(badCompleteResp.body.messageCode, "ReusedPassword", badCompleteResp.bodyRaw);
        chai.assert.equal(badCompleteResp.statusCode, cassava.httpStatusCode.clientError.CONFLICT, badCompleteResp.bodyRaw);
    });

    it("requires a non-empty email address", async () => {
        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: ""
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY);
    });

    it("requires a valid email address", async () => {
        const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: "notanemail"
        });
        chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY);
    });

    it("limits the numbers of times an IP address can call forgotPassword", async () => {
        // Get the count back to 0.
        await testUtils.resetDb();

        sinonSandbox.stub(emailUtils, "sendEmail")
            .callsFake(async () => null);

        for (let i = 0; i < 20; i++) {
            const forgotPasswordResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
                email: testUtils.defaultTestUser.user.email
            });
            chai.assert.equal(forgotPasswordResp.statusCode, cassava.httpStatusCode.success.OK, `iteration ${i}`);
        }

        const forgotPasswordFailResp = await router.testUnauthedRequest<any>("/v2/user/forgotPassword", "POST", {
            email: testUtils.defaultTestUser.user.email
        });
        chai.assert.equal(forgotPasswordFailResp.statusCode, cassava.httpStatusCode.clientError.TOO_MANY_REQUESTS);
        chai.assert.containIgnoreCase(forgotPasswordFailResp.body.message, "reset password");
    }).timeout(10000);
});
