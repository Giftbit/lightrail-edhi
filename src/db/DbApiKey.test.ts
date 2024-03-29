import * as chai from "chai";
import * as testUtils from "../utils/testUtils";
import {DbApiKey} from "./DbApiKey";
import {createdDateNow} from "./dynamodb";
import {DbUser} from "./DbUser";

describe("DbApiKey", () => {

    before(async () => {
        await testUtils.resetDb();
        DbUser.initializeBadgeSigningSecrets(Promise.resolve({secretkey: "secret"}));
    });

    it("returns the original object in fromDbObject(toDbObject())", () => {
        const original: DbApiKey = {
            accountId: testUtils.generateId(),
            userId: testUtils.generateId(),
            name: "Test Key",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: ["lawyer"],
            scopes: ["monkey trial"],
            createdDate: createdDateNow()
        };
        const returned = DbApiKey.fromDbObject(DbApiKey.toDbObject(original));
        chai.assert.deepEqual(returned, original);
    });

    it("can put and get an ApiKey by Account", async () => {
        const apiKey: DbApiKey = {
            accountId: testUtils.generateId(),
            userId: testUtils.generateId(),
            name: "Test Key",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: [],
            scopes: [],
            createdDate: createdDateNow()
        };
        await DbApiKey.put(apiKey);

        const apiKeyByAccount = await DbApiKey.getByAccount(apiKey.accountId, apiKey.tokenId);
        chai.assert.deepEqual(apiKeyByAccount, apiKey);
    });

    it("can get ApiKeys by Account or AccountUser", async () => {
        const accountId1 = testUtils.generateId();
        const accountId2 = testUtils.generateId();
        const userId1 = testUtils.generateId();
        const userId2 = testUtils.generateId();
        const userId3 = testUtils.generateId();

        const account1User1Key: DbApiKey = {
            accountId: accountId1,
            userId: userId1,
            name: "account1, user1",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: [],
            scopes: [],
            createdDate: createdDateNow()
        };
        await DbApiKey.put(account1User1Key);

        const account1User1Key2: DbApiKey = {
            accountId: accountId1,
            userId: userId1,
            name: "account1, user1",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: [],
            scopes: [],
            createdDate: createdDateNow()
        };
        await DbApiKey.put(account1User1Key2);

        const account1User2Key: DbApiKey = {
            accountId: accountId1,
            userId: userId2,
            name: "account1, user2",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: [],
            scopes: [],
            createdDate: createdDateNow()
        };
        await DbApiKey.put(account1User2Key);

        const account2User2Key: DbApiKey = {
            accountId: accountId2,
            userId: userId2,
            name: "account2, user2",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: [],
            scopes: [],
            createdDate: createdDateNow()
        };
        await DbApiKey.put(account2User2Key);

        const account2User3Key: DbApiKey = {
            accountId: accountId2,
            userId: userId3,
            name: "account2, user3",
            tokenId: DbApiKey.generateTokenId(),
            tokenVersion: 3,
            roles: [],
            scopes: [],
            createdDate: createdDateNow()
        };
        await DbApiKey.put(account2User3Key);

        const account1ApiKeys = await DbApiKey.getAllForAccount(accountId1);
        chai.assert.sameDeepMembers(account1ApiKeys, [account1User1Key, account1User1Key2, account1User2Key]);

        const account2ApiKeys = await DbApiKey.getAllForAccount(accountId2);
        chai.assert.sameDeepMembers(account2ApiKeys, [account2User2Key, account2User3Key]);

        const unusedAccountApiKeys = await DbApiKey.getAllForAccount(testUtils.generateId());
        chai.assert.lengthOf(unusedAccountApiKeys, 0);

        const account2User2ApiKeys = await DbApiKey.getAllForAccountUser(accountId2, userId2);
        chai.assert.sameDeepMembers(account2User2ApiKeys, [account2User2Key]);
    });
});
