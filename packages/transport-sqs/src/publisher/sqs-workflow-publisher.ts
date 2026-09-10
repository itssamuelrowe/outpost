import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";

import type { WorkflowMessage } from "../entities/workflow-message.entity.js";

/** Configuration for a {@link SqsWorkflowPublisher}. */
export interface SqsWorkflowPublisherOptions {
  /** A configured SQS client. */
  client: SQSClient;
  /** The URL of the queue to publish to. */
  queueUrl: string;
}

/**
 * Publishes workflow messages to an SQS queue.
 *
 * For a FIFO queue the publisher uses the workflow identifier as both the
 * message group identifier and the deduplication identifier, so repeated
 * publishes of the same workflow are grouped and de-duplicated by SQS.
 */
export class SqsWorkflowPublisher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly isFifoQueue: boolean;

  public constructor(options: SqsWorkflowPublisherOptions) {
    this.client = options.client;
    this.queueUrl = options.queueUrl;
    this.isFifoQueue = options.queueUrl.endsWith(".fifo");
  }

  /** Publishes a single workflow message. */
  public async publish(message: WorkflowMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        ...(this.isFifoQueue
          ? {
              MessageGroupId: message.workflowIdentifier,
              MessageDeduplicationId: message.workflowIdentifier,
            }
          : {}),
      }),
    );
  }
}
