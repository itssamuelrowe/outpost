import type { StepContext, StepMiddleware } from "@outpost/core";

import { ChaosTiming } from "../enums/chaos-timing.enum.js";
import type { ChaosRule } from "../interfaces/chaos-rule.interface.js";

/**
 * Pauses for the given number of milliseconds.
 */
function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Determines whether a rule applies to the given step context.
 */
function ruleMatches(rule: ChaosRule, context: StepContext): boolean {
    const keyMatches =
        (rule.stepKey !== undefined && rule.stepKey === context.stepKey) ||
        (rule.stepKeyPattern !== undefined && rule.stepKeyPattern.test(context.stepKey));
    if (!keyMatches) {
        return false;
    }
    if (rule.attempts !== undefined && !rule.attempts.includes(context.attempt)) {
        return false;
    }
    return true;
}

/**
 * Creates step middleware that injects faults according to a set of rules.
 *
 * This middleware exists to test recovery behaviour deterministically. It can
 * fail a step before it runs, fail it after the side effect has occurred but
 * before the commit, and delay execution long enough to expire a lease. It is a
 * testing tool and must never be installed in a production deployment.
 *
 * @param rules The ordered fault-injection rules. The first matching rule wins.
 */
export function createChaosMiddleware(rules: ChaosRule[]): StepMiddleware {
    return async (context, next) => {
        const matchingRule = rules.find((rule) => ruleMatches(rule, context));
        if (!matchingRule) {
            return next();
        }

        const timing = matchingRule.timing ?? ChaosTiming.BEFORE_EXECUTION;

        if (matchingRule.delayMilliseconds !== undefined) {
            await delay(matchingRule.delayMilliseconds);
        }

        if (timing === ChaosTiming.BEFORE_EXECUTION) {
            if (matchingRule.error) {
                throw matchingRule.error();
            }
            return next();
        }

        // AfterExecution: run the step, then fail before the result is returned,
        // simulating a crash in the commit window.
        const result = await next();
        if (matchingRule.error) {
            throw matchingRule.error();
        }
        return result;
    };
}
