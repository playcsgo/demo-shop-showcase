import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Envelope } from '../common/envelope.js';

/**
 * NestJS 觀念：@Injectable() 的 Service（Provider）。
 * 由 Nest 的 DI 容器建立一次（單例），透過建構子注入到需要它的地方。
 */
@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private readonly prefix: string;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('AWS_ENDPOINT');
    this.client = new SQSClient({
      region: config.get('AWS_DEFAULT_REGION', 'ap-northeast-1'),
      ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
    });
    this.prefix = config.getOrThrow<string>('SQS_PREFIX');
  }

  async publish(queue: string, event: Envelope): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.url(queue), MessageBody: JSON.stringify(event) }));
    this.logger.debug({ queue, event_type: event.type, event_id: event.event_id, correlation_id: event.correlation_id }, `published ${event.type}`);
  }

  /** max：最多拿幾則（SQS 一次上限 10）；池子只拿「有空位」的數量，拿了就能馬上開始做 */
  async receive(queue: string, waitSeconds = 10, max = 10) {
    const res = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.url(queue),
      MaxNumberOfMessages: Math.max(1, Math.min(10, max)),
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
    return (res.Messages ?? []).map((m) => ({
      receipt: m.ReceiptHandle!,
      body: m.Body!,
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
    }));
  }

  async delete(queue: string, receipt: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.url(queue), ReceiptHandle: receipt }));
  }

  private url(queue: string) {
    return `${this.prefix.replace(/\/$/, '')}/${queue}`;
  }
}
