/**
 * Utilities for walking an error's `cause` chain and rendering it for humans.
 *
 * A thrown error is rarely the whole story: wrapping code preserves the
 * underlying failure through `Error.cause` (ES2022), so an ORM error may wrap a
 * driver error which wraps a socket reset. These helpers surface that full
 * chain, either as a compact single-line message suitable for a persisted
 * `error` field, or as a multi-line, indented rendering suitable for a log
 * line, so a deeply-nested failure is visible without attaching a debugger.
 *
 * The methods are grouped as static members so the single cycle-guarded
 * traversal is shared by every rendering rather than reimplemented per call
 * site.
 */
export class ErrorChain {
    /**
     * The separator placed between links when rendering the chain on one line.
     */
    static readonly CAUSE_SEPARATOR = ": caused by: ";

    /**
     * The indentation applied to continuation (stack) lines when rendering the
     * chain across multiple lines.
     */
    static readonly STACK_INDENT = "    ";

    /**
     * Walks the `cause` chain starting at `error`, returning each link in order
     * from the outermost error to the deepest cause.
     *
     * `undefined` and `null` links terminate the walk. A `WeakSet` guards
     * against a cyclic chain (a cause that eventually points back to an earlier
     * link), which would otherwise loop forever. A non-Error link (a thrown
     * string, or a non-Error used as a `cause`) is included as the final link
     * and stops the walk, since a non-Error carries no further `cause`.
     */
    static walk(error: unknown): unknown[] {
        const chain: unknown[] = [];
        const seen = new WeakSet<object>();
        let current: unknown = error;

        while (current !== undefined && current !== null) {
            if (current instanceof Error && seen.has(current)) {
                /* Cyclic cause chain; stop before revisiting a link we already saw. */
                break;
            }

            chain.push(current);

            if (!(current instanceof Error)) {
                /* A non-Error terminates the chain: it has no `cause` to follow. */
                break;
            }

            seen.add(current);
            current = current.cause;
        }

        return chain;
    }

    /**
     * Produces a compact, single-line, diagnostic message for any thrown value
     * by joining the whole `cause` chain.
     *
     * Each Error link renders as `Name: message`; a non-Error link is
     * stringified. Links are joined with {@link ErrorChain.CAUSE_SEPARATOR}, so
     * a repository error caused by a driver timeout caused by a socket reset
     * renders as "RepositoryError: save failed: caused by: DriverError: query
     * timed out: caused by: Error: ECONNRESET". This is far more useful when
     * read back from a persisted `error` field than the outermost message alone.
     */
    static describe(error: unknown): string {
        const segments = ErrorChain.walk(error).map((link) => ErrorChain.describeLink(link));
        if (segments.length === 0) {
            /* The chain was empty (error was undefined/null); fall back to a string. */
            return String(error);
        }
        return segments.join(ErrorChain.CAUSE_SEPARATOR);
    }

    /**
     * Produces a multi-line, indented rendering of an error and its `cause`
     * chain, with the primary stack trace followed by a `Caused by:` block for
     * each wrapped cause.
     *
     * The outermost error contributes its full stack. Every subsequent cause
     * contributes a `Caused by: Name: message` header followed by its own stack
     * (minus the duplicated header line). Continuation lines are trimmed and
     * indented by {@link ErrorChain.STACK_INDENT} for readability.
     */
    static formatStack(error: unknown): string {
        const chain = ErrorChain.walk(error);
        if (chain.length === 0) {
            return String(error);
        }

        const lines: string[] = [];

        for (const [index, link] of chain.entries()) {
            if (index === 0) {
                /* The outermost error: render its stack as-is (header included). */
                lines.push(...ErrorChain.renderStack(link));
                continue;
            }
            /*
             * A wrapped cause: introduce it with a `Caused by:` header, then
             * append its stack without the header line the stack repeats.
             */
            lines.push(`Caused by: ${ErrorChain.describeLink(link)}`);
            lines.push(...ErrorChain.renderStack(link, true));
        }

        return lines.join("\n");
    }

    /**
     * Reformats a raw stack-trace string into indented lines: the first line
     * (the `Name: message` header) is kept as-is, and every non-blank
     * subsequent frame is trimmed and indented by
     * {@link ErrorChain.STACK_INDENT}.
     *
     * This normalises the varied leading whitespace runtimes emit so stacks read
     * consistently in a log.
     */
    static formatStackLines(stack: string): string[] {
        const stackLines = stack.split("\n");
        const formatted: string[] = [];
        for (const [index, line] of stackLines.entries()) {
            if (index === 0) {
                formatted.push(line);
                continue;
            }
            const trimmed = line.trim();
            if (trimmed.length > 0) {
                formatted.push(`${ErrorChain.STACK_INDENT}${trimmed}`);
            }
        }
        return formatted;
    }

    /**
     * Renders a single chain link as `Name: message` for an Error, or the
     * stringified value for a non-Error.
     */
    private static describeLink(link: unknown): string {
        if (link instanceof Error) {
            const name = link.name || "Error";
            return `${name}: ${link.message}`;
        }
        return String(link);
    }

    /**
     * Renders one link's stack for {@link ErrorChain.formatStack}.
     *
     * When the link has a stack string, it is reformatted via
     * {@link ErrorChain.formatStackLines}; `dropHeader` omits the first line so a
     * cause does not repeat the `Name: message` header already emitted as its
     * `Caused by:` line. When the link has no stack (a non-Error, or an Error
     * without one), the header line is synthesised instead.
     */
    private static renderStack(link: unknown, dropHeader = false): string[] {
        if (link instanceof Error && typeof link.stack === "string") {
            const formatted = ErrorChain.formatStackLines(link.stack);
            return dropHeader ? formatted.slice(1) : formatted;
        }
        /* No stack available; fall back to just the descriptive header line. */
        return dropHeader ? [] : [ErrorChain.describeLink(link)];
    }
}
