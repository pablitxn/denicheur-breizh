import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { MediaConfig } from "./config.js";

export interface StoredObject {
  readonly body: Readable;
  readonly contentLength: number;
  readonly contentType: string;
  readonly etag: string;
}

export interface ObjectStorage {
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<StoredObject | undefined>;
  deleteObjects(keys: readonly string[]): Promise<void>;
  checkHealth(): Promise<boolean>;
  close(): void;
}

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string; etag: string }>();

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const copy = Buffer.from(body);
    const etag = `"${createHash("sha256").update(copy).digest("hex")}"`;
    this.objects.set(key, { body: copy, contentType, etag });
  }

  async getObject(key: string): Promise<StoredObject | undefined> {
    const object = this.objects.get(key);
    if (!object) return undefined;
    return {
      body: Readable.from([Buffer.from(object.body)]),
      contentLength: object.body.byteLength,
      contentType: object.contentType,
      etag: object.etag,
    };
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }

  async checkHealth(): Promise<boolean> {
    return true;
  }

  close(): void {}

  keys(): string[] {
    return Array.from(this.objects.keys()).sort();
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: MediaConfig) {
    if (
      config.mode !== "minio" ||
      !config.endpoint ||
      !config.bucket ||
      !config.region ||
      !config.accessKeyId ||
      !config.secretAccessKey
    ) {
      throw new Error("Complete MinIO configuration is required to create S3 object storage.");
    }
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: contentType,
    }), { abortSignal: AbortSignal.timeout(10_000) });
  }

  async getObject(key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
      if (!result.Body) throw new Error("MinIO returned an object without a response body.");
      if (result.ContentLength === undefined || !result.ContentType || !result.ETag) {
        throw new Error("MinIO returned incomplete object metadata.");
      }
      const body = toNodeReadable(result.Body);
      return {
        body,
        contentLength: result.ContentLength,
        contentType: result.ContentType,
        etag: result.ETag,
      };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      if (!batch.length) continue;
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
        }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
      if (result.Errors?.length) {
        throw new Error(`MinIO failed to delete ${result.Errors.length} media object(s).`);
      }
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
      return true;
    } catch {
      return false;
    }
  }


  close(): void {
    this.client.destroy();
  }
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw new Error("MinIO returned a non-streaming object body.");
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NoSuchKey" || candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}
