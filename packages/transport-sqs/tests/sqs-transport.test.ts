import {
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";

import { SqsWorkflowConsumer } from "../src/consumer/sqs-workflow-consumer.js";
import { SqsWorkflowPublisher } from "../src/publisher/sqs-workflow-publisher.js";
import type { WorkflowMessage } from "../src/entities/workflow-message.entity.js";

/**
 * A minimal fake SQS client that records the commands it receives and returns a
 * scripted set of messages. It lets the transport be tested deterministically
 * without a live queue.
 */
class FakeSqsClient {
    public sentCommands: unknown[] = [];
    public deletedReceiptHandles: string[] = [];
    private readonly inbox: Array<{ Body: string; ReceiptHandle: string }>;

    public constructor(inbox: Array<{ Body: string; ReceiptHandle: string }> = []) {
        this.inbox = inbox;
    }

    public async send(command: unknown): Promise<unknown> {
        if (command instanceof SendMessageCommand) {
            this.sentCommands.push(command.input);
            return {};
        }
        if (command instanceof ReceiveMessageCommand) {
            const batch = this.inbox.splice(0, this.inbox.length);
            return { Messages: batch };
        }
        if (command instanceof DeleteMessageCommand) {
            this.deletedReceiptHandles.push(command.input.ReceiptHandle as string);
            return {};
        }
        throw new Error("unexpected command");
    }
}

function asClient(fake: FakeSqsClient): SQSClient {
    return fake as unknown as SQSClient;
}

const sampleMessage: WorkflowMessage = {
    workflowName: "process-order",
    workflowIdentifier: "order-123",
    input: { amount: 42 },
};

describe("SqsWorkflowPublisher", () => {
    it("publishes a message body without FIFO fields on a standard queue", async () => {
        const fake = new FakeSqsClient();
        const publisher = new SqsWorkflowPublisher({
            client: asClient(fake),
            queueUrl: "https://sqs.example.com/standard-queue",
        });

        await publisher.publish(sampleMessage);

        const input = fake.sentCommands[0] as Record<string, unknown>;
        expect(JSON.parse(input.MessageBody as string)).toEqual(sampleMessage);
        expect(input.MessageGroupId).toBeUndefined();
        expect(input.MessageDeduplicationId).toBeUndefined();
    });

    it("sets group and deduplication identifiers on a FIFO queue", async () => {
        const fake = new FakeSqsClient();
        const publisher = new SqsWorkflowPublisher({
            client: asClient(fake),
            queueUrl: "https://sqs.example.com/orders.fifo",
        });

        await publisher.publish(sampleMessage);

        const input = fake.sentCommands[0] as Record<string, unknown>;
        expect(input.MessageGroupId).toBe("order-123");
        expect(input.MessageDeduplicationId).toBe("order-123");
    });
});

describe("SqsWorkflowConsumer", () => {
    it("dispatches a message and deletes it after the handler succeeds", async () => {
        const fake = new FakeSqsClient([
            { Body: JSON.stringify(sampleMessage), ReceiptHandle: "receipt-1" },
        ]);
        const consumer = new SqsWorkflowConsumer({
            client: asClient(fake),
            queueUrl: "https://sqs.example.com/standard-queue",
            waitTimeSeconds: 0,
        });

        const handled: WorkflowMessage[] = [];
        await consumer.pollOnce(async (message) => {
            handled.push(message);
        });

        expect(handled).toEqual([sampleMessage]);
        expect(fake.deletedReceiptHandles).toEqual(["receipt-1"]);
    });

    it("does not delete a message when the handler fails, allowing redelivery", async () => {
        const fake = new FakeSqsClient([
            { Body: JSON.stringify(sampleMessage), ReceiptHandle: "receipt-1" },
        ]);
        const reportedErrors: unknown[] = [];
        const consumer = new SqsWorkflowConsumer({
            client: asClient(fake),
            queueUrl: "https://sqs.example.com/standard-queue",
            waitTimeSeconds: 0,
            onHandlerError: (_message, error) => reportedErrors.push(error),
        });

        await consumer.pollOnce(async () => {
            throw new Error("handler failed");
        });

        expect(fake.deletedReceiptHandles).toEqual([]);
        expect(reportedErrors.length).toBe(1);
    });
});
