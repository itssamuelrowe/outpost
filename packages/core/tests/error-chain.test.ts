import { describe, expect, it } from "vitest";

import { ErrorChain } from "../src/utilities/error-chain.utility.js";

describe("ErrorChain.walk", () => {
    it("returns each link from the outermost error to the deepest cause", () => {
        const root = new Error("ECONNRESET");
        const middle = new Error("query timed out", { cause: root });
        const outer = new Error("save failed", { cause: middle });

        expect(ErrorChain.walk(outer)).toEqual([outer, middle, root]);
    });

    it("terminates on a non-Error link and includes it", () => {
        const outer = new Error("wrapping a string", { cause: "raw failure" });

        expect(ErrorChain.walk(outer)).toEqual([outer, "raw failure"]);
    });

    it("stops on a cyclic cause chain rather than looping", () => {
        const first = new Error("first");
        const second = new Error("second", { cause: first });
        (first as { cause?: unknown }).cause = second;

        expect(ErrorChain.walk(first)).toEqual([first, second]);
    });

    it("returns an empty chain for a nullish value", () => {
        expect(ErrorChain.walk(undefined)).toEqual([]);
        expect(ErrorChain.walk(null)).toEqual([]);
    });
});

describe("ErrorChain.describe", () => {
    it("joins the whole cause chain on one line", () => {
        const root = new TypeError("Cannot read properties of undefined");
        const outer = new Error("preparePopulate failed", { cause: root });

        expect(ErrorChain.describe(outer)).toBe(
            "Error: preparePopulate failed: caused by: TypeError: Cannot read properties of undefined",
        );
    });

    it("uses a custom error name when present", () => {
        class ValidationError extends Error {
            public constructor(message: string) {
                super(message);
                this.name = "ValidationError";
            }
        }
        const error = new ValidationError("Entity 'Task' does not have property 'tags'");

        expect(ErrorChain.describe(error)).toBe(
            "ValidationError: Entity 'Task' does not have property 'tags'",
        );
    });

    it("stringifies a non-Error thrown value", () => {
        expect(ErrorChain.describe("boom")).toBe("boom");
    });

    it("stringifies a nullish value via the fallback", () => {
        expect(ErrorChain.describe(undefined)).toBe("undefined");
    });
});

describe("ErrorChain.formatStackLines", () => {
    it("keeps the header line and trims and indents the frames", () => {
        const stack = ["Error: boom", "    at foo (a.ts:1:1)", "  at bar (b.ts:2:2)", ""].join(
            "\n",
        );

        expect(ErrorChain.formatStackLines(stack)).toEqual([
            "Error: boom",
            "    at foo (a.ts:1:1)",
            "    at bar (b.ts:2:2)",
        ]);
    });
});

describe("ErrorChain.formatStack", () => {
    it("renders the primary stack followed by a Caused by block per cause", () => {
        const root = new Error("ECONNRESET");
        root.stack = "Error: ECONNRESET\n    at socket (net.ts:9:9)";
        const outer = new Error("save failed", { cause: root });
        outer.stack = "Error: save failed\n    at save (repo.ts:3:3)";

        expect(ErrorChain.formatStack(outer)).toBe(
            [
                "Error: save failed",
                "    at save (repo.ts:3:3)",
                "Caused by: Error: ECONNRESET",
                "    at socket (net.ts:9:9)",
            ].join("\n"),
        );
    });

    it("synthesises a header when the outermost error has no stack", () => {
        const error = new Error("no stack here");
        error.stack = undefined;

        expect(ErrorChain.formatStack(error)).toBe("Error: no stack here");
    });
});
