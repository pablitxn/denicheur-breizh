import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GlobalProviderBudget, type GlobalProviderBudgetPolicy } from "../src/globalProviderBudget.js";
import { DenicheurRepository } from "../src/repository.js";

const REQUEST = {
  serializedRequest: { input: "budget-test" },
  imageCount: 0,
  maxOutputTokens: 100,
};
const repositories = new Set<DenicheurRepository>();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.clear();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GlobalProviderBudget", () => {
  it("does not reopen a spent window when the API budget instance restarts", () => {
    const now = 1_000;
    const directory = mkdtempSync(join(tmpdir(), "denicheur-global-provider-budget-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const firstRepository = openRepository(path, () => now);
    const firstProcess = new GlobalProviderBudget(
      policy({ maxProviderCalls: 1 }),
      firstRepository,
      () => now,
    );

    firstProcess.reserve(REQUEST);
    closeRepository(firstRepository);

    const restartedRepository = openRepository(path, () => now);
    const restartedProcess = new GlobalProviderBudget(
      policy({ maxProviderCalls: 1 }),
      restartedRepository,
      () => now,
    );

    expect(() => restartedProcess.reserve(REQUEST)).toThrow(expect.objectContaining({
      statusCode: 429,
      code: "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
      retryable: true,
    }));
  });

  it("rejects before a second provider call and recovers only after the window expires", () => {
    let now = 1_000;
    const budget = createBudget(policy({ maxProviderCalls: 1 }), () => now);

    budget.reserve(REQUEST);
    expect(() => budget.reserve(REQUEST)).toThrow(expect.objectContaining({
      statusCode: 429,
      code: "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
      retryable: true,
    }));

    now += 60_001;
    expect(budget.reserve(REQUEST)).toEqual({ id: expect.any(String) });
  });

  it("does not reset the provider window during collected-data maintenance", () => {
    const now = 1_000;
    const repository = openRepository(":memory:", () => now);
    const budget = new GlobalProviderBudget(policy({ maxProviderCalls: 1 }), repository, () => now);

    budget.reserve(REQUEST);
    repository.clearCollectedData();

    expect(() => budget.reserve(REQUEST)).toThrow(expect.objectContaining({
      statusCode: 429,
      code: "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
    }));
  });

  it("settles a reservation to actual usage and releases unused output capacity", () => {
    const budget = createBudget(policy({
      maxProviderCalls: 2,
      maxOutputTokens: 110,
    }));
    const first = budget.reserve(REQUEST);

    expect(() => budget.reserve(REQUEST)).toThrow(expect.objectContaining({
      code: "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
    }));
    budget.settle(first, { inputTokens: 10, outputTokens: 10 });
    budget.settle(first, { inputTokens: 10, outputTokens: 1_000 });
    budget.release(first);

    expect(budget.usage()).toMatchObject({ providerCalls: 1, outputTokens: 10, costMicroUsd: 1 });
    expect(budget.reserve(REQUEST)).toEqual({ id: expect.any(String) });
    expect(budget.usage()).toMatchObject({ providerCalls: 2, outputTokens: 110, costMicroUsd: 2 });
  });

  it("releases an unsettled reservation when a later admission gate rejects", () => {
    const budget = createBudget(policy({ maxProviderCalls: 1 }));
    const reservation = budget.reserve(REQUEST);

    budget.release(reservation);
    budget.release(reservation);

    expect(budget.usage()).toMatchObject({ providerCalls: 0, outputTokens: 0 });
    expect(budget.reserve(REQUEST)).toEqual({ id: expect.any(String) });
  });

  it("records actual overage and blocks every later call in the same window", () => {
    const budget = createBudget(policy({
      maxProviderCalls: 5,
      maxOutputTokens: 150,
    }));
    const reservation = budget.reserve(REQUEST);

    budget.settle(reservation, { inputTokens: 10, outputTokens: 200 });

    expect(budget.usage()).toMatchObject({ providerCalls: 1, outputTokens: 200 });
    expect(() => budget.reserve(REQUEST)).toThrow(expect.objectContaining({
      code: "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
    }));
  });

  it("keeps the conservative reservation when provider usage is invalid", () => {
    const budget = createBudget(policy({ maxProviderCalls: 1 }));
    const reservation = budget.reserve(REQUEST);

    budget.settle(reservation, { inputTokens: Number.NaN, outputTokens: -1 });

    expect(budget.usage()).toMatchObject({ providerCalls: 1, outputTokens: 100 });
    expect(() => budget.reserve(REQUEST)).toThrow(expect.objectContaining({
      code: "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
    }));
  });
});

function createBudget(
  budgetPolicy: GlobalProviderBudgetPolicy,
  now: () => number = Date.now,
): GlobalProviderBudget {
  return new GlobalProviderBudget(budgetPolicy, openRepository(":memory:", now), now);
}

function openRepository(path: string, now: () => number): DenicheurRepository {
  const repository = new DenicheurRepository({ path, now: () => new Date(now()) });
  repositories.add(repository);
  return repository;
}

function closeRepository(repository: DenicheurRepository): void {
  repository.close();
  repositories.delete(repository);
}

function policy(overrides: Partial<GlobalProviderBudgetPolicy> = {}): GlobalProviderBudgetPolicy {
  return {
    maxProviderCalls: 10,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1_000_000,
    maxCostMicroUsd: 1_000_000,
    inputPriceMicroUsdPerMillionTokens: 1,
    outputPriceMicroUsdPerMillionTokens: 1,
    windowMs: 60_000,
    ...overrides,
  };
}
