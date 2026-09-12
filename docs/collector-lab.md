# Laboratorio de captura completa

El laboratorio ejecuta xAI y Firecrawl por separado para medir si pueden sustituir la captura de la extensión en una búsqueda concreta de Leboncoin. Una ejecución terminada no equivale a cobertura completa: el veredicto requiere una referencia independiente y el 100% de sus identidades, detalles y datos presentes. Los resultados de un proveedor nunca completan los del otro.

## Arranque y demo local

Para probar la instalación existente y sus resultados, seguir [la guía breve de demo](collector-demo.md). El bloque siguiente corresponde a un checkout nuevo; `cp -n` conserva un `.env` ya configurado.

```bash
pnpm install
cp -n apps/collector-api/.env.example apps/collector-api/.env
# Completar XAI_API_KEY y FIRECRAWL_API_KEY únicamente en ese archivo.
pnpm dev:collector
```

Abrir [http://127.0.0.1:5175](http://127.0.0.1:5175). La API escucha en `127.0.0.1:4315`. Los comandos `dev`, `dev:all` y `dev:extension` conservan sus aplicaciones actuales.

Para capturas largas, usar procesos sin recarga automática del backend:

```bash
pnpm build:collector
pnpm --filter @denicheur-breizh/collector-api start
# En otra terminal:
pnpm --filter @denicheur-breizh/collector-web dev
```

1. En **Nueva captura**, elegir fuente, proveedor y búsqueda completa o URLs conocidas. La URL nativa es opcional; si se aporta, sus filtros deben coincidir con los del formulario.
2. La captura continúa en el backend al cerrar la página. **Capturas** muestra estado operativo, cobertura, pendientes, evidencias y consumo.
3. Abrir los anuncios como tarjetas o tabla; el detalle conserva descripción, características, imágenes y campos desconocidos o ausentes. Exportar obtiene el conjunto completo, sin depender de la página visible.
4. En **Evaluación**, importar la referencia de la extensión, declarar los campos requeridos y comparar. Las revisiones conservan las diferencias originales y su evidencia.
5. Idioma y apariencia están en **Settings** compartido. **Development** contiene conectividad, saldo y reconciliación de consumo incierto.

La app funciona sin claves para consultar capturas e informes, pero no permite iniciar un proveedor sin configurar. Nunca usar prefijos `VITE_` o `WXT_` para credenciales.

## Configuración y almacenamiento

| Variable del backend | Predeterminado | Función |
|---|---|---|
| `COLLECTOR_PORT` | `4315` | Puerto local independiente. |
| `COLLECTOR_DATA_DIR` | `apps/collector-api/.data` | SQLite y evidencias propias. |
| `COLLECTOR_ALLOWED_ORIGIN` | `http://127.0.0.1:5175` | Origen exacto del frontend. |
| `XAI_API_KEY` / `FIRECRAWL_API_KEY` | vacío | Claves exclusivas del backend. |
| `COLLECTOR_XAI_MODEL` | `grok-4.6` | Modelo fijado al crear cada ejecución. |
| `COLLECTOR_XAI_BUDGET_USD` | `25` | Presupuesto acumulado del laboratorio. |
| `COLLECTOR_FIRECRAWL_BUDGET_CREDITS` | `5000` | Presupuesto acumulado del laboratorio. |
| `COLLECTOR_XAI_EXPIRES_AT` / `COLLECTOR_FIRECRAWL_EXPIRES_AT` | desconocido | Vencimiento verificado en formato ISO, con zona horaria. |

El frontend usa `/api/v1`, reenviado por Vite a `/v1` del backend. `COLLECTOR_API_UPSTREAM` permite cambiar ese destino al iniciar Vite. El laboratorio no importa servicios de la API principal ni abre su base. SQLite usa WAL, migración versionada, trabajos persistentes y un libro de consumo propio. Las evidencias son archivos JSON; los secretos se eliminan antes de guardarlos. `.env`, `.data` y salidas de build están excluidos de Git.

No borrar la base para reiniciar una prueba: también contiene el presupuesto consumido. Cada nueva captura crea una observación histórica separada; deduplicar dentro de ella no sobrescribe otras ejecuciones.

## CLI y API

La CLI usa la misma API HTTP local; no crea un segundo trabajador ni abre SQLite:

```bash
pnpm --filter @denicheur-breizh/collector-api cli status
pnpm --filter @denicheur-breizh/collector-api cli balances
pnpm --filter @denicheur-breizh/collector-api cli capture /ruta/solicitud.json
pnpm --filter @denicheur-breizh/collector-api cli run RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli cancel RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli resume RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli reprocess RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli import-extension /ruta/referencia.json
pnpm --filter @denicheur-breizh/collector-api cli evaluate REFERENCE_ID XAI_RUN_ID FIRECRAWL_RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli export RUN_ID /ruta/captura.json
pnpm report:collector
```

Ejemplo de solicitud; los criterios definen el conjunto entero, sin top-N:

```json
{
  "name": "Lannion — vente ≤250k",
  "source": "leboncoin",
  "provider": "xai",
  "mode": "search",
  "filters": {
    "category": "sale",
    "location": "Lannion 22300, commune exacte sans rayon",
    "propertyTypes": ["house", "apartment"],
    "priceMax": 250000,
    "surfaceMin": 50,
    "sort": "recent"
  }
}
```

| Operación | Endpoint |
|---|---|
| Capacidades y presupuesto | `GET /v1/meta` |
| Refrescar saldo consultable por API | `POST /v1/balances/refresh` |
| Registrar saldo verificado en consola | `POST /v1/balances/:provider/observation` |
| Crear / listar capturas | `POST /v1/runs` / `GET /v1/runs` |
| Estado / cancelar / reanudar | `GET /v1/runs/:id`, `POST /cancel`, `POST /resume` |
| Auditar evidencias guardadas sin capturar | `POST /v1/runs/:id/reprocess` |
| Resultados paginados | `GET /v1/runs/:id/observations?offset=0&limit=30` |
| Evidencias y trazas | `GET /v1/runs/:id/events`, `GET /v1/runs/:id/artifacts/:artifactId` |
| Exportación completa | `GET /v1/runs/:id/export` |
| Referencias normalizadas / extensión | `POST /v1/references`, `POST /v1/references/extension` |
| Revisiones auditadas | `POST /v1/reviews` |
| Crear evaluación / historial / consultar | `POST /v1/evaluations`, `GET /v1/evaluations`, `GET /v1/evaluations/:id` |
| Informe JSON / Markdown | `GET /v1/evaluations/:id/export?format=json` o `markdown` |
| Consumo incierto / reconciliar | `GET /v1/usage/unknown`, `POST /v1/usage/:id/reconcile` |

`POST /v1/runs` exige `Idempotency-Key`. Reenviar la misma clave y entrada devuelve la misma ejecución; cambiar la entrada produce conflicto. La CLI considera cada comando `capture` una nueva ejecución intencional. La paginación HTTP limita la respuesta visible, no la captura ni la exportación.

## Proveedores, progreso y presupuesto

**xAI** usa Responses API, `grok-4.6`, `web_search` alojado y restringido al dominio, y salida JSON estructurada. Grok Bot es otro producto y no interviene. Las llamadas guardan respuesta original, citas, herramientas observables y `cost_in_usd_ticks`. El límite de tokens/turnos es por petición, no por búsqueda: páginas y detalles son trabajos persistentes independientes. Un descubrimiento truncado puede pasar a una continuación explícita de solo URLs; si tampoco permite avanzar, queda incompleto con evidencia.

**Firecrawl** usa Agent `spark-2` para descubrir y Scrape JSON con `maxAge: 0` para detalles. Un Agent recibe el remanente admitido como `maxCredits`. Los detalles ya completos se reutilizan dentro de la misma ejecución. Sus IDs remotos se guardan antes de comenzar el seguimiento; un reinicio puede consultar el trabajo existente sin enviar otro POST. Browser/Interact requiere una nueva estrategia versionada y queda fuera de esta primera estrategia.

Se puede elegir **Agent: navegación nativa** (`firecrawl-agent-native-v2`), que comienza por la portada y pide aplicar los controles y recorrer la paginación en el mismo trabajo de Agent. **Agent + detalles desplegados** (`firecrawl-agent-expanded-v3`) conserva el descubrimiento de V1 y añade una acción nativa para abrir «Voir plus» antes de extraer cada detalle. V1 sigue disponible para comparar. Las trazas y el contenido original deben confirmar qué ocurrió; el diseño de un browser controlado por código queda documentado en [collector-native-strategy.md](collector-native-strategy.md).

Antes de cada POST nuevo se conserva su configuración y prompt efectivos, sin cabeceras ni claves. Las capturas iniciales anteriores a esa instrumentación se identifican como tales. Los detalles con campos no recuperados, DPE/GES inválidos o descripciones truncadas pasan a una extracción adicional del mismo proveedor; si sigue faltando información, permanecen incompletos. Reanudar una captura anterior también audita esos huecos sin borrar la evidencia original.

Hay un único trabajo activo por proveedor; ambos proveedores pueden avanzar simultáneamente. Página repetida, ausencia de IDs nuevos o salida truncada no prueban agotamiento. Los POST con respuesta incierta no se repiten automáticamente. La cancelación detiene nuevos envíos y solicita cancelación remota cuando existe; los gastos que sigan sin conocerse bloquean nuevos despachos hasta reconciliación.

El consumo confirmado, las estimaciones y las llamadas inciertas se guardan por separado. Las estimaciones se descuentan conservadoramente del disponible. Una diferencia de saldo de cuenta en Scrape es una estimación y puede incluir otra actividad; no se presenta como factura atribuida. El xAI en curso puede superar el remanente final: no hay un corte monetario exacto por petición. Firecrawl comprueba además el coste documentado de la operación de detalle antes de despacharla. No existe reserva fija de US$2 ni presupuesto por fase. No se configuran recargas ni medios de pago.

El saldo de Firecrawl se consulta por API. Si la consola muestra una fecha de reinicio de facturación, no se interpreta como vencimiento promocional. El saldo/vencimiento xAI puede necesitar una observación de su consola; el límite local no certifica un saldo externo no consultado.

## Evaluación y verificación

La metodología, importación y significado de cada veredicto están en [collector-evaluation.md](collector-evaluation.md). La preparación independiente de la extensión está en [collector-reference.md](collector-reference.md). Las pruebas con URLs conocidas y las de descubrimiento completo se evalúan por separado.

```bash
pnpm check:collector
# También comprobar el monorepo cuando cambien contratos compartidos o integración:
pnpm check
```

`test:e2e:collector` usa puertos `14175` y `14315`, SQLite temporal real y proveedores simulados sin acceso de red a terceros. Comprueba más de 100 anuncios, recarga, exportación, identidad idempotente, aislamiento, cancelación y el rechazo de 120/121 como cobertura completa. Las llamadas pagadas están fuera de CI y de estos tests. Las pruebas simuladas validan el software; la viabilidad en Leboncoin requiere capturas reales y referencia reconciliada.

`pnpm report:collector` reúne las ejecuciones y exportaciones completas, presupuesto, referencias importadas y estados de la extensión aislada en `apps/collector-api/.data/reports/campaign.md` y `campaign.json`. Se puede repetir al finalizar las capturas; únicamente lee la API y escribe informes locales, sin consumir créditos.

Las observaciones reales de la primera campaña y sus limitaciones están en [collector-poc-findings.md](collector-poc-findings.md). `reprocess` revalida solamente respuestas propias ya guardadas, conservando snapshots y timestamps originales; requiere una ejecución detenida. No es equivalente a `resume`, que sí puede despachar nuevas capturas.

## Agregar un sitio o proveedor

Una fuente implementa `SourceAdapter` en `apps/collector-api/src/sources.ts`: dominios, filtros admitidos, validación de URLs, identidad canónica y reglas de instrucciones/paginación. Registrarla en `sourceRegistry`. Añadir campos a los contratos si los necesita; el formulario debe mostrar qué filtros admite y rechazar los incompatibles. Probar alias de identidad, URLs externas, filtros y páginas repetidas.

Un proveedor implementa `CaptureProvider` en `apps/collector-api/src/providers/` y se registra en `runtime.ts`. Añadir su ID, presupuesto/unidad y etiqueta en contratos y UI. `step` recibe únicamente solicitud, fuente y trabajo, nunca la referencia. Debe persistir `onRemoteJob` antes de hacer polling, guardar `onEvidence`, y llamar `onUsage` con consumo acumulado de ese trabajo antes de interpretar su salida. `null` significa desconocido, no gratuito. Versionar `strategy` cuando cambien instrucciones o herramientas. La normalización, SQLite, comparación y exportación siguen siendo comunes.

La integración futura debería consumir exportaciones o contratos del laboratorio solo después de demostrar el criterio de cobertura. Por ahora no hay escritura hacia el catálogo habitual ni despliegue público.
