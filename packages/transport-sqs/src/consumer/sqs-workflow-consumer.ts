import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";

import type { WorkflowMessage } from "../entities/workflow-message.entity.js";

/**
 * Handles a single decoded workflow message.
 */
export type WorkflowMessageHandler = (message: WorkflowMessage) => Promise<void>;

/**
 * Configuration for an {@link SqsWorkflowConsumer}.
 */
export interface SqsWorkflowConsumerOptions {
    /**
     * A configured SQS client.
     */
    client: SQSClient;
    /**
     * The URL of the queue to consume from.
     */
    queueUrl: string;
    /**
     * The maximum number of messages to receive per poll. Defaults to ten.
     */
    maxMessagesPerPoll?: number;
    /**
     * The long-poll wait time in seconds. Defaults to twenty.
     */
    waitTimeSeconds?: number;
    /**
     * An optional sink invoked when a handler throws, so the host can observe
     * failures. The message is not deleted on failure, allowing SQS to
     * redeliver it according to the queue's redrive policy.
     */
    onHandlerError?: (message: WorkflowMessage, error: unknown) => void;
}

/**
 * Consumes workflow messages from an SQS queue and dispatches them to a
 * handler.
 *
 * The consumer long-polls to reduce empty receives, deletes a message only
 * after its handler succeeds, and leaves redelivery and dead-letter behaviour
 * to the queue's own configuration. It deliberately holds no engine internals;
 * the handler is where the application wires the message to a workflow run.
 */
export class SqsWorkflowConsumer {
    private readonly client: SQSClient;
    private readonly queueUrl: string;
    private readonly maxMessagesPerPoll: number;
    private readonly waitTimeSeconds: number;
    private readonly onHandlerError?: (message: WorkflowMessage, error: unknown) => void;

    private running = false;

    public constructor(options: SqsWorkflowConsumerOptions) {
        this.client = options.client;
        this.queueUrl = options.queueUrl;
        this.maxMessagesPerPoll = options.maxMessagesPerPoll ?? 10;
        this.waitTimeSeconds = options.waitTimeSeconds ?? 20;
        this.onHandlerError = options.onHandlerError;
    }

    /**
     * Starts the consume loop, polling until {@link SqsWorkflowConsumer.stop} is
     * called. The returned promise resolves once the loop has fully stopped.
     */
    public async start(handler: WorkflowMessageHandler): Promise<void> {
        this.running = true;
        while (this.running) {
            await this.pollOnce(handler);
        }
    }

    /**
     * Requests that the consume loop stop after the current poll completes.
     */
    public stop(): void {
        this.running = false;
    }

    /**
     * Performs a single poll cycle: receive a batch, dispatch each message, and
     * delete those whose handler succeeded. Exposed separately so tests can
     * drive one cycle deterministically without an unbounded loop.
     */
    public async pollOnce(handler: WorkflowMessageHandler): Promise<void> {
        const response = await this.client.send(
            new ReceiveMessageCommand({
                QueueUrl: this.queueUrl,
                MaxNumberOfMessages: this.maxMessagesPerPoll,
                WaitTimeSeconds: this.waitTimeSeconds,
            }),
        );

        const messages = response.Messages ?? [];
        for (const sqsMessage of messages) {
            if (!sqsMessage.Body || !sqsMessage.ReceiptHandle) {
                continue;
            }

            const decoded = JSON.parse(sqsMessage.Body) as WorkflowMessage;
            try {
                await handler(decoded);
                await this.client.send(
                    new DeleteMessageCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: sqsMessage.ReceiptHandle,
                    }),
                );
            } catch (error) {
                // Leave the message on the queue so SQS can redeliver it; report the
                // failure so the host can observe it.
                this.onHandlerError?.(decoded, error);
            }
        }
    }
}
