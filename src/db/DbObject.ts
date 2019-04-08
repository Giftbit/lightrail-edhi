import {dynamodb, objectDynameh, objectDynameh2} from "./dynamodb";

export interface DbObject {
    pk: string;
    sk: string;
    pk2?: string;
    sk2?: string;
}

export namespace DbObject {

    export async function get(pk: string, sk: string): Promise<DbObject> {
        const req = objectDynameh.requestBuilder.buildGetInput(pk, sk);
        const resp = await dynamodb.getItem(req).promise();
        return objectDynameh.responseUnwrapper.unwrapGetOutput(resp);
    }

    export async function getSecondary(pk2: string, sk2: string): Promise<DbObject> {
        const req = objectDynameh2.requestBuilder.buildGetInput(pk2, sk2);
        const resp = await dynamodb.getItem(req).promise();
        return objectDynameh2.responseUnwrapper.unwrapGetOutput(resp);
    }

    export async function put(o: DbObject): Promise<void> {
        const req = objectDynameh.requestBuilder.buildPutInput(o);
        await dynamodb.putItem(req).promise();
    }
}
