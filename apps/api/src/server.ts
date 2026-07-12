import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { FilterListingsService } from "./filterService.js";
import { jsonLogger } from "./logger.js";
import { OpenAiListingEvaluator } from "./openAiEvaluator.js";

function main(): void {
  const config = loadConfig();
  const evaluator = new OpenAiListingEvaluator({
    ...(config.openAiApiKey ? { apiKey: config.openAiApiKey } : {}),
    model: config.openAiModel,
    version: config.evaluatorVersion,
    timeoutMs: config.openAiTimeoutMs,
    maxRetries: config.openAiMaxRetries,
    logger: jsonLogger,
  });
  const filterService = new FilterListingsService(evaluator);
  const app = createApp({ config, filterService, logger: jsonLogger });
  const server = app.listen(config.port, config.host, () => {
    jsonLogger.info({
      event: "server_started",
      host: config.host,
      port: config.port,
      model: config.openAiModel,
    });
  });

  const shutdown = () => {
    server.close((error) => {
      if (error) {
        jsonLogger.error({ event: "server_shutdown_failed" });
        process.exitCode = 1;
        return;
      }

      jsonLogger.info({ event: "server_stopped" });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  main();
} catch {
  jsonLogger.error({ event: "server_start_failed" });
  process.exitCode = 1;
}
