/**
 * Deterministic time and randomness inside a workflow.
 *
 * Reading the wall clock or generating a random id directly inside a workflow
 * is a subtle bug: a resume after a crash would observe a _different_ instant
 * or a _different_ id, and the workflow could diverge from its original run.
 * Outpost gives you `context.now(key)` and `context.randomUUID(key)` for
 * exactly this. Each records its value as a durable step the first time it is
 * called, so every resume observes the same value the first run did.
 *
 * This example issues a "coupon" whose id and issued-at timestamp must be
 * stable across resumes. It runs the workflow, then runs it again with a clock
 * that has moved on and a UUID generator that would return something new, and
 * shows that the recorded values do not change.
 *
 * It uses in-memory storage. Run it with:
 *
 * yarn tsx src/deterministic-values.ts
 */

import { MemoryStorage, Step, Workflow, WorkflowEngine } from "@outpost/core";
import type { WorkflowContext } from "@outpost/core";

/**
 * The input to the coupon workflow.
 */
interface CouponInput {
    customer: string;
}

/**
 * The coupon a run produces. Both fields must be stable across resumes.
 */
interface Coupon {
    couponId: string;
    issuedAtEpochMs: number;
    code: string;
}

function log(message: string): void {
    console.log(message);
}

/**
 * A workflow that issues a coupon whose id and issued-at timestamp must be
 * stable across resumes. It reads them through `context.randomUUID` and
 * `context.now`, which record their values durably the first time and return
 * the same value on every later run.
 */
@Workflow({ name: "issue-coupon" })
class IssueCoupon {
    @Step({ id: "build-code" })
    public async buildCode(customer: string, couponId: string): Promise<string> {
        const suffix = couponId.slice(-4).toUpperCase();
        return `SAVE-${customer.toUpperCase()}-${suffix}`;
    }

    public async run(context: WorkflowContext, input: CouponInput): Promise<Coupon> {
        // Recorded durably the first time; identical on every resume thereafter.
        const couponId = await context.randomUUID("coupon-id");
        const issuedAtEpochMs = await context.now("issued-at");

        // An ordinary step can safely use the recorded values.
        const code = await this.buildCode(input.customer, couponId);

        return { couponId, issuedAtEpochMs, code };
    }
}

const main = async (): Promise<void> => {
    const storage = new MemoryStorage();

    // A clock we control, so we can prove `context.now` is recorded, not re-read.
    let currentInstant = new Date("2026-01-01T09:00:00.000Z");
    // A UUID generator we control, so we can prove `context.randomUUID` is
    // recorded once. It would hand out a fresh id on every call if consulted again.
    let uuidCounter = 0;

    const engine = new WorkflowEngine(storage, {
        now: () => currentInstant,
        uuid: () => `coupon-${(uuidCounter += 1).toString().padStart(4, "0")}`,
    });

    // First run: the id and timestamp are generated and recorded.
    log("=== First run ===");
    const first = await engine.run<CouponInput, Coupon>(IssueCoupon, "wf-1", {
        customer: "acme",
    });
    log(`  couponId:  ${first.couponId}`);
    log(`  issuedAt:  ${new Date(first.issuedAtEpochMs).toISOString()}`);
    log(`  code:      ${first.code}`);

    // Move the clock forward by a day and make the UUID generator ready to hand
    // out a new id. A naive workflow would pick these up on resume and diverge.
    currentInstant = new Date("2026-01-02T15:30:00.000Z");
    log("\n(one day passes; the UUID generator is primed to return a new id)");

    // Second run with the same identifier: both values come back from the durable
    // record, unchanged, even though the clock moved and a new id was available.
    log("\n=== Second run (resume) ===");
    const second = await engine.run<CouponInput, Coupon>(IssueCoupon, "wf-1", {
        customer: "acme",
    });
    log(`  couponId:  ${second.couponId}   (same as first: ${second.couponId === first.couponId})`);
    log(
        `  issuedAt:  ${new Date(second.issuedAtEpochMs).toISOString()}   ` +
            `(same as first: ${second.issuedAtEpochMs === first.issuedAtEpochMs})`,
    );
    log(`  code:      ${second.code}   (same as first: ${second.code === first.code})`);

    if (
        second.couponId !== first.couponId ||
        second.issuedAtEpochMs !== first.issuedAtEpochMs ||
        second.code !== first.code
    ) {
        throw new Error("values were not stable across resume; this should never happen");
    }
    log("\nAll recorded values were stable across the resume, as intended.");
};

main().catch((error) => {
    console.error("deterministic-values example failed:", error);
    process.exitCode = 1;
});
