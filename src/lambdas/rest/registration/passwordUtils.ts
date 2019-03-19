import * as bcrypt from "bcrypt";
import {UserPassword} from "../../../model/User";
import {dateCreatedNow} from "../../../dynamodb";

export async function hashPassword(plainTextPassword: string): Promise<UserPassword> {
    // Always use the preferred password hashing method.
    const hash = await bcrypt.hash(plainTextPassword, 10);
    return {
        algorithm: "BCRYPT_10",
        hash,
        dateCreated: dateCreatedNow()
    };
}

export function validatePassword(plainTextPassword: string, userPassword: UserPassword): Promise<boolean> {
    switch (userPassword.algorithm) {
        case "BCRYPT_10":
            return validateBcrypt10Password(plainTextPassword, userPassword);
    }
}

async function validateBcrypt10Password(plainTextPassword: string, userPassword: UserPassword): Promise<boolean> {
    return await bcrypt.compare(plainTextPassword, userPassword.hash);
}
