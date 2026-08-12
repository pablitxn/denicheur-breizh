import { createApp, evaluationExecutionWorkerFor } from "./app.js";
import { loadConfig } from "./config.js";
import { FilterListingsService } from "./filterService.js";
import { GlobalProviderBudget } from "./globalProviderBudget.js";
import { jsonLogger } from "./logger.js";
import { MediaService } from "./mediaService.js";
import { S3ObjectStorage } from "./objectStorage.js";
import { OpenAiListingEvaluator } from "./openAiEvaluator.js";
import { DenicheurRepository } from "./repository.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const repository = new DenicheurRepository({
    path: config.databasePath,
    mediaAdmission: config.media.admission,
  });
  const globalProviderBudget = new GlobalProviderBudget(config.openAiGlobalBudget, repository);
  const evaluator = new OpenAiListingEvaluator({
    ...(config.openAiApiKey ? { apiKey: config.openAiApiKey } : {}),
    model: config.openAiModel,
    version: config.evaluatorVersion,
    timeoutMs: config.openAiTimeoutMs,
    logger: jsonLogger,
    globalProviderBudget,
  });
  const filterService = new FilterListingsService(evaluator);
  const storage = config.media.mode === "minio" ? new S3ObjectStorage(config.media) : undefined;
  const mediaService = new MediaService({
    repository,
    ...(storage ? { storage } : {}),
    logger: jsonLogger,
    concurrency: config.media.workerConcurrency,
    deliveryBudgetOptions: {
      maxConcurrent: config.media.deliveryMaxConcurrent,
      maxBytesPerWindow: config.media.deliveryMaxBytesPerWindow,
      windowMs: config.media.deliveryWindowMs,
    },
  });
  await mediaService.start();
  const app = createApp({ config, filterService, repository, logger: jsonLogger, mediaService });
  const server = app.listen(config.port, config.host, () => {
    jsonLogger.info({
      event: "server_started",
      host: config.host,
      port: config.port,
      replicaCount: config.replicaCount,
      model: config.openAiModel,
    });
  });

  const shutdown = () => {
    server.close(async (error) => {
      if (error) {
        jsonLogger.error({ event: "server_shutdown_failed" });
        process.exitCode = 1;
        return;
      }

      await evaluationExecutionWorkerFor(app).dispose();
      await mediaService.stop();
      repository.close();
      jsonLogger.info({ event: "server_stopped" });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  jsonLogger.error({ event: "server_start_failed" });
  process.exitCode = 1;
});
