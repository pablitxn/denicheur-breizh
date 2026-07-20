import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { MemoryObjectStorage } from "../src/objectStorage.js";

describe("MemoryObjectStorage", () => {
  it("returns immutable object copies as streams with delivery metadata", async () => {
    const storage = new MemoryObjectStorage();
    const input = Buffer.from("media bytes");
    const expected = Buffer.from(input);

    await storage.putObject("media/object.webp", input, "image/webp");
    input.fill(0);

    const object = await storage.getObject("media/object.webp");
    expect(object).toBeDefined();
    expect(object?.body).toBeInstanceOf(Readable);
    expect(object).toMatchObject({
      contentLength: expected.byteLength,
      contentType: "image/webp",
      etag: `"${createHash("sha256").update(expected).digest("hex")}"`,
    });
    expect(await readAll(object!.body)).toEqual(expected);
  });

  it("lists deterministic keys and deletes objects idempotently", async () => {
    const storage = new MemoryObjectStorage();
    await storage.putObject("z-last", Uint8Array.of(1), "application/octet-stream");
    await storage.putObject("a-first", Uint8Array.of(2), "application/octet-stream");

    expect(storage.keys()).toEqual(["a-first", "z-last"]);
    await storage.deleteObjects(["a-first", "missing"]);
    await storage.deleteObjects(["missing"]);

    expect(storage.keys()).toEqual(["z-last"]);
    await expect(storage.getObject("a-first")).resolves.toBeUndefined();
    await expect(storage.checkHealth()).resolves.toBe(true);
  });
});

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
