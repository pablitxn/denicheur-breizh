import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DenicheurRepository } from "../src/repository.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DenicheurRepository filesystem permissions", () => {
  it("creates the database directory, database, and SQLite sidecars with private permissions", () => {
    const root = createTemporaryDirectory("denicheur-api-private-db-");
    chmodSync(root, 0o755);
    const databaseDirectory = join(root, "nested", "database");
    const databasePath = join(databaseDirectory, "denicheur.sqlite");

    const repository = new DenicheurRepository({ path: databasePath });
    try {
      expect(modeOf(databaseDirectory)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(modeOf(databasePath)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(`${databasePath}-wal`)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(`${databasePath}-shm`)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(root)).toBe(0o755);
    } finally {
      repository.close();
    }
  });

  it("hardens a database and active sidecars inside a pre-existing private directory", () => {
    const root = createTemporaryDirectory("denicheur-api-existing-db-");
    const databaseDirectory = join(root, "database");
    const databasePath = join(databaseDirectory, "denicheur.sqlite");
    mkdirSync(databaseDirectory, { mode: PRIVATE_DIRECTORY_MODE });

    const existingConnection = new DatabaseSync(databasePath);
    existingConnection.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE pre_existing_data (id INTEGER PRIMARY KEY);
      INSERT INTO pre_existing_data DEFAULT VALUES;
    `);
    chmodSync(databasePath, 0o666);
    chmodSync(`${databasePath}-wal`, 0o666);
    chmodSync(`${databasePath}-shm`, 0o666);

    let repository: DenicheurRepository | undefined;
    try {
      repository = new DenicheurRepository({ path: databasePath });

      expect(modeOf(databaseDirectory)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(modeOf(databasePath)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(`${databasePath}-wal`)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(`${databasePath}-shm`)).toBe(PRIVATE_FILE_MODE);
    } finally {
      repository?.close();
      existingConnection.close();
    }
  });

  it.each([
    { label: "repo-style", mode: 0o755 },
    { label: "temporary", mode: 0o777 },
  ])("rejects a database in a $label shared directory without changing that directory", ({ mode }) => {
    const sharedDirectory = createTemporaryDirectory("denicheur-api-shared-db-directory-");
    const databasePath = join(sharedDirectory, "denicheur.sqlite");
    chmodSync(sharedDirectory, mode);

    expect(() => new DenicheurRepository({ path: databasePath })).toThrow(/private.*directory/i);
    expect(modeOf(sharedDirectory)).toBe(mode);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("rejects a private database directory below a replaceable shared ancestor", () => {
    const root = createTemporaryDirectory("denicheur-api-replaceable-db-ancestor-");
    const sharedDirectory = join(root, "shared");
    const databaseDirectory = join(sharedDirectory, "private");
    const databasePath = join(databaseDirectory, "denicheur.sqlite");
    mkdirSync(databaseDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(sharedDirectory, 0o777);

    expect(() => new DenicheurRepository({ path: databasePath })).toThrow(/ancestor.*writable/i);
    expect(modeOf(sharedDirectory)).toBe(0o777);
    expect(modeOf(databaseDirectory)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("accepts a private database directory below a sticky shared ancestor", () => {
    const root = createTemporaryDirectory("denicheur-api-sticky-db-ancestor-");
    const stickyDirectory = join(root, "sticky");
    const databaseDirectory = join(stickyDirectory, "private");
    const databasePath = join(databaseDirectory, "denicheur.sqlite");
    mkdirSync(databaseDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(stickyDirectory, 0o1777);

    const repository = new DenicheurRepository({ path: databasePath });
    try {
      expect(modeOf(stickyDirectory)).toBe(0o777);
      expect(modeOf(databaseDirectory)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(modeOf(databasePath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      repository.close();
    }
  });

  it("rejects a symlink database without changing the target permissions", () => {
    const root = createTemporaryDirectory("denicheur-api-database-symlink-");
    const databaseDirectory = join(root, "database");
    const targetPath = join(root, "target.sqlite");
    const databasePath = join(databaseDirectory, "denicheur.sqlite");
    mkdirSync(databaseDirectory, { mode: PRIVATE_DIRECTORY_MODE });

    const target = new DatabaseSync(targetPath);
    target.close();
    chmodSync(targetPath, 0o666);
    symlinkSync(targetPath, databasePath);

    expect(() => new DenicheurRepository({ path: databasePath })).toThrow(/symbolic link/i);
    expect(modeOf(targetPath)).toBe(0o666);
  });

  it("rejects a symlink directory component without changing its target permissions", () => {
    const root = createTemporaryDirectory("denicheur-api-directory-symlink-");
    const targetDirectory = join(root, "target");
    const linkedDirectory = join(root, "linked");
    mkdirSync(targetDirectory, { mode: 0o755 });
    chmodSync(targetDirectory, 0o755);
    symlinkSync(targetDirectory, linkedDirectory, "dir");

    expect(() => new DenicheurRepository({
      path: join(linkedDirectory, "denicheur.sqlite"),
    })).toThrow(/symbolic link/i);
    expect(modeOf(targetDirectory)).toBe(0o755);
  });

  it("rejects an intermediate symlink component before hardening its target directory", () => {
    const root = createTemporaryDirectory("denicheur-api-intermediate-symlink-");
    const targetDirectory = join(root, "target");
    const targetDatabaseDirectory = join(targetDirectory, "nested");
    const linkedDirectory = join(root, "linked");
    mkdirSync(targetDatabaseDirectory, { recursive: true, mode: 0o755 });
    chmodSync(targetDatabaseDirectory, 0o755);
    symlinkSync(targetDirectory, linkedDirectory, "dir");

    expect(() => new DenicheurRepository({
      path: join(linkedDirectory, "nested", "denicheur.sqlite"),
    })).toThrow(/symbolic link/i);
    expect(modeOf(targetDatabaseDirectory)).toBe(0o755);
  });

  it("rejects a hard-linked database without changing the shared inode permissions", () => {
    const root = createTemporaryDirectory("denicheur-api-database-hardlink-");
    const databasePath = join(root, "denicheur.sqlite");
    const targetPath = join(root, "target.sqlite");
    const target = new DatabaseSync(targetPath);
    target.close();
    chmodSync(targetPath, 0o666);
    linkSync(targetPath, databasePath);

    expect(() => new DenicheurRepository({ path: databasePath })).toThrow(/hard links/i);
    expect(modeOf(targetPath)).toBe(0o666);
  });

  it.each(["-journal", "-wal", "-shm"])(
    "rejects a symlink SQLite %s sidecar without changing the target permissions",
    (suffix) => {
    const root = createTemporaryDirectory("denicheur-api-sidecar-symlink-");
    const databasePath = join(root, "denicheur.sqlite");
    const targetPath = join(root, "sidecar-target");

    const descriptor = openSync(targetPath, constants.O_CREAT | constants.O_WRONLY, 0o666);
    closeSync(descriptor);
    chmodSync(targetPath, 0o666);
    const sidecarPath = `${databasePath}${suffix}`;
    symlinkSync(targetPath, sidecarPath);

    expect(() => new DenicheurRepository({ path: databasePath })).toThrow(/symbolic link/i);
    expect(lstatSync(sidecarPath).isSymbolicLink()).toBe(true);
    expect(modeOf(targetPath)).toBe(0o666);
    },
  );
});

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function modeOf(path: string): number {
  return statSync(path).mode & PERMISSION_BITS;
}
