/**
 * Persisting rich values with the serialization recipe system.
 *
 * By default, Outpost only lets plain JSON data cross the durability boundary,
 * because a silently lossy round-trip (a `Date` turning into a string, a `Map`
 * turning into `{}`) is a nasty correctness bug. But real workflow data often
 * carries `Date`s, `Map`s, and domain objects. A `SerializationRegistry` lets
 * you register recipes so those values are persisted and restored faithfully.
 *
 * This example configures a registry with the built-in recipes (Date, Map, Set,
 * BigInt) plus a custom recipe for a `Money` value object, then runs a workflow
 * whose input, step results, and output all contain rich values. Re-running it
 * shows those values come back as real instances, not strings or empty objects.
 * It also demonstrates unregistering a recipe.
 *
 * It uses in-memory storage. Run it with:
 *
 * yarn tsx src/serialization-recipes.ts
 */

import {
    MemoryStorage,
    SerializationRegistry,
    Step,
    Workflow,
    WorkflowEngine,
} from "@outpost/core";
import type { SerializationRecipe, WorkflowContext } from "@outpost/core";

/**
 * A small domain value object that is not plain JSON data.
 */
class Money {
    public constructor(
        public readonly cents: number,
        public readonly currency: string,
    ) {}

    public format(): string {
        return `${(this.cents / 100).toFixed(2)} ${this.currency}`;
    }
}

/**
 * The plain, JSON-native shape a `Money` is stored as.
 */
interface MoneyData {
    cents: number;
    currency: string;
}

/**
 * A custom recipe teaching the registry how to persist and restore `Money`.
 */
const moneyRecipe: SerializationRecipe<Money, MoneyData> = {
    name: "Money",
    test: (value): value is Money => value instanceof Money,
    serialize: (money) => ({ cents: money.cents, currency: money.currency }),
    deserialize: (data) => new Money(data.cents, data.currency),
};

/**
 * The workflow input. It deliberately uses rich types.
 */
interface InvoiceInput {
    invoiceId: string;
    issuedAt: Date;
    lineTotals: Map<string, Money>;
}

/**
 * The workflow output, likewise built from rich values.
 */
interface InvoiceResult {
    invoiceId: string;
    issuedAt: Date;
    total: Money;
    currencies: Set<string>;
}

function log(message: string): void {
    console.log(message);
}

/**
 * A workflow whose input, step results, and output all involve rich values.
 * Steps return plain, JSON-native data (the safest default); the workflow
 * output is where the rich `Money`/`Set`/`Date` values are assembled, and the
 * registry persists and restores them faithfully.
 */
@Workflow({ name: "total-invoice" })
class TotalInvoice {
    // The `input` reaching these steps is a full rich value: its `lineTotals` Map
    // and Money entries were restored by the registry from what was persisted when
    // the workflow started.
    @Step({ id: "sum-lines" })
    public async sumLines(input: InvoiceInput): Promise<number> {
        let cents = 0;
        for (const money of input.lineTotals.values()) {
            cents += money.cents;
        }
        return cents;
    }

    @Step({ id: "collect-currencies" })
    public async collectCurrencies(input: InvoiceInput): Promise<string[]> {
        return [...new Set([...input.lineTotals.values()].map((money) => money.currency))];
    }

    public async run(context: WorkflowContext, input: InvoiceInput): Promise<InvoiceResult> {
        const totalCents = await this.sumLines(input);
        const currencyList = await this.collectCurrencies(input);

        // Workflow input and output accept object shapes, and the registry persists
        // these Money/Set/Date values faithfully so a later resume reads them back
        // as real instances.
        return {
            invoiceId: input.invoiceId,
            issuedAt: input.issuedAt,
            total: new Money(totalCents, currencyList[0] ?? "USD"),
            currencies: new Set(currencyList),
        };
    }
}

const main = async (): Promise<void> => {
    // Build a registry with every built-in recipe plus our custom Money recipe.
    const serialization = new SerializationRegistry();
    for (const recipe of SerializationRegistry.getAllBuiltInRecipes()) {
        serialization.register(recipe);
    }
    serialization.register(moneyRecipe);
    log(`Registered recipes: ${serialization.registeredRecipeNames.join(", ")}`);

    const storage = new MemoryStorage();
    // Hand the registry to the engine; it now encodes/decodes every persisted value.
    const engine = new WorkflowEngine(storage, { serialization });

    const input: InvoiceInput = {
        invoiceId: "inv-7",
        issuedAt: new Date("2026-02-14T10:00:00.000Z"),
        lineTotals: new Map<string, Money>([
            ["widget", new Money(1999, "USD")],
            ["gadget", new Money(4500, "USD")],
        ]),
    };

    // First run computes and persists the rich values.
    log("\n=== First run ===");
    const first = await engine.run<InvoiceInput, InvoiceResult>(
        TotalInvoice,
        input.invoiceId,
        input,
    );
    log(
        `  issuedAt is a Date:  ${first.issuedAt instanceof Date} (${first.issuedAt.toISOString()})`,
    );
    log(`  total is Money:      ${first.total instanceof Money} (${first.total.format()})`);
    log(
        `  currencies is a Set: ${first.currencies instanceof Set} (${[...first.currencies].join(", ")})`,
    );

    // Second run reads the persisted values back through the registry. They return
    // as real Date, Money, and Set instances, not as strings or empty objects.
    log("\n=== Second run (values restored from storage) ===");
    const second = await engine.run<InvoiceInput, InvoiceResult>(
        TotalInvoice,
        input.invoiceId,
        input,
    );
    log(`  issuedAt still a Date:  ${second.issuedAt instanceof Date}`);
    log(`  total still Money:      ${second.total instanceof Money} (${second.total.format()})`);
    log(`  currencies still a Set: ${second.currencies instanceof Set}`);

    if (
        !(second.issuedAt instanceof Date) ||
        !(second.total instanceof Money) ||
        !(second.currencies instanceof Set)
    ) {
        throw new Error("rich values were not restored; check the registry configuration");
    }
    log("\nEvery rich value round-tripped through storage as its real type.");

    // Recipes can be removed with `unregister`. Once a recipe is gone, values of
    // its type are no longer specially encoded, and the name is free to reuse.
    // (Be deliberate in production: data already written with a recipe becomes
    // undecodable once the recipe is removed.)
    log("\n=== Unregistering the Money recipe ===");
    const removed = serialization.unregister("Money");
    log(`  unregister("Money") -> ${removed}`);
    log(`  registry still has "Money": ${serialization.has("Money")}`);
    log(`  remaining recipes: ${serialization.registeredRecipeNames.join(", ")}`);
};

main().catch((error) => {
    console.error("serialization-recipes example failed:", error);
    process.exitCode = 1;
});
