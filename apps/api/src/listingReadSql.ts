// JSON is assembled in SQLite and validated only for the requested response page.
// This freezes related values with each snapshot without materializing the catalog in JS.
export const LATEST_EVALUATION_ORDER = "e.evaluated_at DESC, e.run_id DESC, e.recipe_id ASC, e.recipe_version DESC, e.locale ASC";
export const LISTING_EVALUATION_JOIN = `
  LEFT JOIN evaluations e ON e.rowid = (
    SELECT e.rowid FROM evaluations e WHERE e.source = l.source AND e.external_id = l.external_id
    ORDER BY ${LATEST_EVALUATION_ORDER} LIMIT 1
  )
`;

const MEDIA_PAYLOAD = `json_patch('{}', json_object(
  'id', media.id, 'sourceUrl', media.source_url, 'status', media.status,
  'thumbnailPath', CASE WHEN media.status = 'ready' AND media.thumbnail_object_key IS NOT NULL THEN '/v1/media/' || media.id || '/thumbnail.webp' END,
  'galleryPath', CASE WHEN media.status = 'ready' AND media.gallery_object_key IS NOT NULL THEN '/v1/media/' || media.id || '/gallery.webp' END
))`;
const MEDIA_FROM = `FROM listing_media lm JOIN media_assets media ON media.id = lm.asset_id
  WHERE lm.source = l.source AND lm.external_id = l.external_id`;
const RECORD_METADATA = `'id', l.source || ':' || l.external_id, 'lastRunId', l.last_run_id,
  'firstSeenAt', l.first_seen_at, 'lastSeenAt', l.last_seen_at, 'updatedAt', l.updated_at`;

export const LISTING_PAYLOAD_SQL = `json_object(
  'data', l.data_json, ${RECORD_METADATA},
  'imageAssets', json((SELECT json_group_array(json(asset)) FROM (
    SELECT ${MEDIA_PAYLOAD} AS asset ${MEDIA_FROM} ORDER BY lm.position
  ))),
  'evaluation', CASE WHEN e.rowid IS NULL THEN NULL ELSE json_object(
    'result_json', e.result_json, 'evaluator_json', e.evaluator_json,
    'run_id', e.run_id, 'source', e.source, 'external_id', e.external_id,
    'recipe_id', e.recipe_id, 'recipe_version', e.recipe_version, 'locale', e.locale
  ) END
)`;

const MAP_LISTING_BASE = `json_patch('{}', json_object(
  ${RECORD_METADATA}, 'source', l.source, 'externalId', l.external_id,
  ${["url", "status", "scrapedAt", "title", "priceEuros", "propertyType", "rooms", "surfaceM2", "location", "coordinates", "imageUrl"]
    .map((field) => `'${field}', json_extract(l.data_json, '$.${field}')`).join(", ")},
  'coverAsset', json((SELECT ${MEDIA_PAYLOAD} ${MEDIA_FROM} ORDER BY lm.position LIMIT 1))
))`;

export const LISTING_MAP_PAYLOAD_SQL = `CASE WHEN e.rowid IS NULL THEN ${MAP_LISTING_BASE} ELSE
  json_set(${MAP_LISTING_BASE}, '$.evaluation', json_object(
    'decision', e.decision, 'score', e.score, 'evaluatedAt', e.evaluated_at
  )) END`;

export const EXECUTION_PAYLOAD_SQL = `json_patch('{}', json_object(
  'id', execution.id, 'runId', execution.run_id, 'planId', execution.plan_id,
  'planVersion', execution.plan_version, 'locale', execution.locale, 'status', execution.status,
  'listingIds', json_extract(execution.request_json, '$.listingIds'),
  'force', json(CASE WHEN execution.force = 1 THEN 'true' ELSE 'false' END),
  'retryOfExecutionId', execution.retry_of_execution_id, 'createdAt', execution.created_at,
  'startedAt', execution.started_at, 'completedAt', execution.completed_at, 'error', execution.error,
  'counters', json(execution.counters_json),
  'budget', json_object('limit', json(budget.limit_json), 'estimate', json(budget.estimate_json), 'consumed', json(budget.consumed_json))
))`;
