import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {getStripeClient} from "../../../utils/stripeUtils";
import {stripUserIdTestMode} from "../../../utils/userUtils";
import {DbUserDetails} from "../../../db/DbUserDetails";
import {DbAccountDetails} from "../../../db/DbAccountDetails";
import {PaymentCreditCard} from "../../../model/PaymentCreditCard";
import log = require("loglevel");
import Stripe = require("stripe");

export function installPaymentsRest(router: cassava.Router): void {
    router.route("/v2/account/payments/card")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:payments:card:read");
            auth.requireIds("userId");

            return {
                body: await getActiveCreditCard(auth)
            };
        });

    router.route("/v2/account/payments/card")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:payments:card:update");
            auth.requireIds("userId");

            evt.validateBody({
                properties: {
                    cardToken: {
                        type: "string",
                        minLength: 1
                    }
                },
                required: ["cardToken"]
            });

            return {
                body: await setActiveCreditCard(auth, evt.body.cardToken)
            };
        });

    router.route("/v2/account/payments/card")
        .method("DELETE")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:payments:card:delete");
            auth.requireIds("userId");

            await clearActiveCreditCard(auth);
            return {
                body: {}
            };
        });

    router.route("/v2/account/payments/subscriptionTier")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireScopes("lightrailV2:account:payments:card:delete");
            auth.requireIds("userId");

            // TODO
            return {
                body: null
            };
        });
}

async function getActiveCreditCard(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<PaymentCreditCard> {
    const customer = await getStripeCustomerOrNull(auth);
    if (!customer) {
        log.info("Customer", auth.userId, "does not exist in Stripe.");
        return null;
    }
    if (!customer.default_source) {
        log.info("Customer", auth.userId, "does not have a default source.");
        return null;
    }
    if (customer.sources.total_count === 0) {
        log.info("Customer", auth.userId, "has 0 cards on file.");
        return null;
    }
    if (typeof customer.default_source !== "string") {
        throw new Error(`Customer ${auth.userId} default_source is not a string.`);
    }

    const stripe = await getStripeClient("live");
    const source = await stripe.customers.retrieveSource(customer.id, customer.default_source) as Stripe.ICard;
    return PaymentCreditCard.fromStripeSource(source);
}

async function setActiveCreditCard(auth: giftbitRoutes.jwtauth.AuthorizationBadge, cardToken: string): Promise<PaymentCreditCard> {
    const stripe = await getStripeClient("live");
    const customer = await getOrCreateStripeCustomer(auth);
    const card = await stripe.customers.createSource(customer.id, {source: cardToken});
    if (card.object !== "card") {
        throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.UNPROCESSABLE_ENTITY, "The Stripe token is not a credit card token.");
    }

    await stripe.customers.update(customer.id, {
        default_source: card.id,
        ...await getDefaultStripeCustomerProperties(auth)
    });
    return PaymentCreditCard.fromStripeSource(card);
}

async function clearActiveCreditCard(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<void> {
    const stripe = await getStripeClient("live");
    const customer = await getOrCreateStripeCustomer(auth);
    if (customer.default_source) {
        await stripe.customers.update(stripUserIdTestMode(auth.userId), {
            default_source: null,
            ...await getDefaultStripeCustomerProperties(auth)
        });
    }
}

async function getStripeCustomerOrNull(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<Stripe.customers.ICustomer> {
    const stripe = await getStripeClient("live");
    try {
        return await stripe.customers.retrieve(stripUserIdTestMode(auth.userId));
    } catch (err) {
        if (err.code === "resource_missing") {
            return null;
        }
        throw err;
    }
}

async function getOrCreateStripeCustomer(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<Stripe.customers.ICustomer> {
    const stripe = await getStripeClient("live");
    const customerId = stripUserIdTestMode(auth.userId);

    try {
        return await stripe.customers.retrieve(customerId);
    } catch (err) {
        if (err.code === "resource_missing") {
            const customer = await stripe.customers.create({
                id: customerId, // `id` is not listed in ICustomerCreationOptions but this does work
                ...await getDefaultStripeCustomerProperties(auth)
            } as any);
            if (customer.id !== customerId) {
                // Check that it continues to work as expected.
                throw new Error(`Stripe customer created with ID '${customer.id}' does not match the account ID '${customerId}'.`);
            }
            return customer;
        }
        throw err;
    }
}

async function getDefaultStripeCustomerProperties(auth: giftbitRoutes.jwtauth.AuthorizationBadge): Promise<{ email: string, name: string }> {
    const user = await DbUserDetails.getByAuth(auth);
    const account = await DbAccountDetails.getByAuth(auth);
    return {
        email: user.email,
        name: account.name
    };
}