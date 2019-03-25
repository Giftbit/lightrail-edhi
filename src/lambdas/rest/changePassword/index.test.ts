import * as chai from "chai";
import * as testUtils from "../../../utils/testUtils";
import {generateId} from "../../../utils/testUtils";
import {TestRouter} from "../../../utils/testUtils/TestRouter";
import {installUnauthedRestRoutes} from "../installUnauthedRestRoutes";
import {installAuthedRestRoutes} from "../installAuthedRestRoutes";
import {initializeBadgeSigningSecrets} from "../login";
import * as cassava from "cassava";

describe("/v2/user/changePassword", () => {

    const router = new TestRouter();

    before(async () => {
        await testUtils.resetDb();
        installUnauthedRestRoutes(router);
        router.route(testUtils.authRoute);
        installAuthedRestRoutes(router);
        initializeBadgeSigningSecrets(Promise.resolve({secretkey: "secret"}));
    });

    it("can change the password", async () => {
        const newPassword = generateId();
        const changePasswordResp = await router.testWebAppRequest("/v2/user/changePassword", "POST", {
            oldPassword: testUtils.defaultTestUser.password,
            newPassword
        });
        chai.assert.equal(changePasswordResp.statusCode, cassava.httpStatusCode.success.OK);

        // Cannot log in with the old password.
        const oldPasswordLoginResp = await router.testUnauthedRequest("/v2/user/login", "POST", {
            email: testUtils.defaultTestUser.user.email,
            password: testUtils.defaultTestUser.password
        });
        chai.assert.equal(oldPasswordLoginResp.statusCode, cassava.httpStatusCode.clientError.UNAUTHORIZED);

        const newPasswordLoginResp = await router.testUnauthedRequest("/v2/user/login", "POST", {
            email: testUtils.defaultTestUser.user.email,
            password: newPassword
        });
        chai.assert.equal(newPasswordLoginResp.statusCode, cassava.httpStatusCode.redirect.FOUND);
        chai.assert.isString(newPasswordLoginResp.headers["Set-Cookie"]);
        chai.assert.match(newPasswordLoginResp.headers["Set-Cookie"], /gb_jwt_session=([^ ;]+)/);
        chai.assert.match(newPasswordLoginResp.headers["Set-Cookie"], /gb_jwt_signature=([^ ;]+)/);
    });

    it("cannot change the password if the old password does not match", async () => {
        const newPassword = generateId();
        const changePasswordResp = await router.testWebAppRequest("/v2/user/changePassword", "POST", {
            oldPassword: generateId(),
            newPassword: generateId()
        });
        chai.assert.equal(changePasswordResp.statusCode, cassava.httpStatusCode.clientError.CONFLICT);
    });
});
