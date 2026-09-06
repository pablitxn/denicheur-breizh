export const EXECUTION_COUNTERS_JSON_SQL = `json_object(
  'total', COUNT(*), 'processed', COUNT(result_decision),
  'relevant', COALESCE(SUM(result_decision = 'relevant'), 0),
  'notRelevant', COALESCE(SUM(result_decision = 'not-relevant'), 0),
  'review', COALESCE(SUM(result_decision = 'review'), 0),
  'failed', COALESCE(SUM(result_failed), 0)
)`;

export const EVALUATION_COUNTER_MIGRATION = `
  ALTER TABLE evaluation_execution_items ADD COLUMN result_decision TEXT
    CHECK(result_decision IN ('relevant', 'not-relevant', 'review'));
  ALTER TABLE evaluation_execution_items ADD COLUMN result_failed INTEGER NOT NULL DEFAULT 0
    CHECK(result_failed IN (0, 1));
  UPDATE evaluation_execution_items SET
    result_decision = COALESCE(json_extract(result_json, '$.decision'), 'invalid'),
    result_failed = CASE WHEN COALESCE(json_type(result_json, '$.steps'), '') != 'array' THEN 2 ELSE
      EXISTS(SELECT 1 FROM json_each(result_json, '$.steps') WHERE json_extract(value, '$.status') = 'failed') END
    WHERE result_json IS NOT NULL;
  CREATE INDEX execution_items_counter_idx
    ON evaluation_execution_items(execution_id, result_decision, result_failed);
  UPDATE evaluation_executions SET counters_json = (
    SELECT ${EXECUTION_COUNTERS_JSON_SQL} FROM evaluation_execution_items
    WHERE execution_id = evaluation_executions.id
  );
`;
