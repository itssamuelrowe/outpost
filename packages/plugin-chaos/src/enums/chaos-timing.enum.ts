/**
 * Controls when, relative to the step function, an injected fault occurs.
 *
 * The distinction matters because durable execution correctness depends on how
 * the system behaves at different points in the check-execute-commit cycle.
 */
export enum ChaosTiming {
    /**
     * Fail before the step function runs, simulating a worker that dies before
     * doing any work.
     */
    BEFORE_EXECUTION = "BEFORE_EXECUTION",
    /**
     * Allow the step function to run, then fail before its result is returned,
     * simulating the dangerous window in which a side effect has occurred but
     * the durable commit has not.
     */
    AFTER_EXECUTION = "AFTER_EXECUTION",
}
