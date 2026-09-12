# POC Leboncoin — observaciones del 12 de septiembre de 2026

El laboratorio está implementado y las capturas reales permanecen en su SQLite y sus evidencias locales. **No hay cobertura completa verificada ni un proveedor aprobado para sustituir la extensión.** Esto describe las estrategias y búsquedas ensayadas; no demuestra una imposibilidad universal de los proveedores.

Los resultados y consumos de cada ejecución se regeneran con `pnpm report:collector` en `apps/collector-api/.data/reports/campaign.md` y `campaign.json`. Cada exportación conserva la solicitud, modelo, estrategia, observaciones, eventos y respuestas originales. Las comparaciones guardadas pueden reabrirse desde la interfaz sin volver a capturar.

## Descubrimiento de búsquedas completas

Se probaron búsquedas de venta en Lannion, Quimperlé y Perros-Guirec, con precio máximo de 250.000 €, superficie mínima de 50 m², tipos de inmueble definidos y orden reciente. La comuna exacta solicitada forma parte de los criterios; una búsqueda con un radio mayor no se acepta como equivalente.

| Ruta | Evidencia observada | Consecuencia |
|---|---|---|
| xAI, Web Search v1 | Las búsquedas no produjeron anuncios utilizables; las respuestas registraron fallos de consulta o bloqueos. También se ensayó una URL nativa explícita. | No se demostró descubrimiento completo. Grok Bot no intervino en estas llamadas. |
| Firecrawl, Agent + Scrape v1 | Descubrió 34 identidades en Lannion y devolvió continuaciones; los intentos posteriores encontraron intersticiales de verificación. | Las 34 identidades no representan una búsqueda agotada. El total de 83 mencionado por Agent no fue verificado independientemente. |
| Firecrawl, navegación nativa v2 | Comenzó por la portada e intentó usar los controles nativos. Se observaron overlays/consentimiento, verificación al seleccionar ubicación y dificultad para comprobar los filtros exactos. | Ninguna de las tres búsquedas quedó completa. Las trazas distinguen bloqueo de acceso y filtro sin verificar. |
| Extensión aislada | Perfil y backend temporales, sin IA ni sincronización al catálogo habitual; terminó en `blocked-activity`, sin registros. | No se obtuvo una referencia actual completa. No puede calcularse una tasa fiable de cobertura de esas búsquedas. |

El contador interno `pagesVisited` representa pasos de descubrimiento ejecutados. Una tarea de Agent puede navegar varias páginas, y varios pasos pueden intentar la misma página. La interfaz lo presenta como **Pasos de búsqueda**; nunca se usa como prueba independiente de paginación completa.

### Acción inesperada del Agent

La traza de la primera estrategia registra `exchange_bounty_publish` a las 13:38:15 UTC. El resultado informa `published: true`, revisión pendiente y ausencia de compromiso de pago para una solicitud sobre el contenido inaccesible de la página 2 de Lannion. Esto va más allá de extraer la búsqueda. La evidencia queda en la ejecución `3eb0c11e-3cfa-4e7f-9b7e-db1fb4e96664`; no debe presentarse como una simple frase sin traza de acción.

Los prompts posteriores prohíben explícitamente bounties, tareas externas y contactos. La revisión de las trazas guardadas encontró una sola publicación, anterior a esa instrucción. La prohibición por prompt no equivale a una restricción técnica de herramientas: es una limitación material de delegar la navegación a Agent y una razón adicional para evaluar una estrategia controlada por código. No se verificó una retirada de esa publicación.

## Extracción de URLs conocidas

La comprobación inicial tomó tres URLs del catálogo histórico únicamente como entradas explícitas de un diagnóstico de detalles. La referencia conservada era del 18 de julio y se importó como incompleta. Firecrawl observó que dos anuncios estaban desactivados; esos casos no prueban un bloqueo del proveedor. xAI no consiguió recuperar detalles utilizables en esa prueba.

La auditoría de las respuestas originales encontró un falso positivo de Firecrawl: el JSON declaraba fichas capturadas mientras el markdown conservaba la descripción plegada detrás de «Voir plus». Las 34 fichas de la búsqueda inicial y la ficha activa del diagnóstico de URLs quedaron reclasificadas como incompletas. Los snapshots anteriores se conservaron; la corrección utilizó solamente evidencias de la misma ejecución, sin red ni gasto.

La estrategia nueva `firecrawl-agent-expanded-v3` ejecuta el clic nativo de la sección Description antes de extraer. En el piloto de tres URLs, la traza registró un clic en cada ficha y el JSON inicial entregó descripciones de 973, 742 y 1.321 caracteres. La revisión posterior encontró que el modelo también podía resumir texto ya expandido. La normalización final conserva el bloque Description íntegro del markdown original, delimitado por el control de cierre o la siguiente sección nativa. Dos fichas pasaron la validación de campos; la restante mantuvo un campo sin resolver. Esto demuestra una mejora de extracción observada, no exactitud independiente ni cobertura de búsqueda.

La segunda tanda aplicó esa misma estrategia a las 34 URLs que Firecrawl había descubierto. Es un diagnóstico de URLs conocidas, con una ejecución nueva y resultados separados. Conserva las 34 descripciones originales, de 470 a 2.864 caracteres: 18 fichas pasan la validación del laboratorio y 16 siguen incompletas por otros campos. Las correcciones de descripción incluyen tanto omisiones sustanciales como diferencias menores de formato; no equivalen a 34 truncamientos demostrados. El estado final y las diferencias por anuncio están en la exportación `49f1dfd9-9799-455c-a281-e0fcd8b64e91` del informe de campaña. Esas URLs nunca se utilizaron como lista esperada para una búsqueda de xAI ni como referencia de la extensión.

## Decisión y siguiente experimento

Mantener el laboratorio separado del catálogo. Firecrawl permite avanzar en la extracción dirigida y la apertura nativa de contenido corrigió un defecto reproducible; todavía faltan descubrimiento paginado, todos los campos presentes y una referencia independiente reconciliada. Con las herramientas alojadas probadas, xAI no aportó evidencia suficiente para ese trabajo en Leboncoin.

El siguiente experimento de descubrimiento que tiene una hipótesis nueva es una sesión Firecrawl Interact controlada por código, con los controles, estabilización y detección de páginas repetidas de la extensión. Está descrito en [collector-native-strategy.md](collector-native-strategy.md) como estrategia futura separada; no se presenta como implementado ni probado. La navegación nativa por instrucciones de Agent ya fue ensayada y sus límites quedaron registrados.

Los presupuestos autorizados siguen siendo 25 USD y 5.000 créditos, con consumo persistido y sin recargas. La fecha de reinicio de facturación de Firecrawl no acredita el vencimiento promocional; el vencimiento exacto de ambas promociones no pudo verificarse en las consolas consultadas. Los saldos y el consumo atribuible tienen timestamps separados.

La campaña termina con 12 ejecuciones, 0,300710 USD confirmados en xAI y 609 créditos confirmados en Firecrawl, sin consumo estimado, incierto ni comprometido pendiente. Quedan 24,699290 USD y 4.391 créditos del presupuesto autorizado. La limitación observada es de acceso, control y completitud; la evaluación no terminó por agotar el presupuesto.

## Evidencia de software

Las pruebas simuladas verifican más de 100 anuncios, reanudación, idempotencia, aislamiento, respuesta incierta, presupuesto, rechazos de cobertura parcial y conservación de datos. Los E2E usan SQLite real temporal y proveedores simulados, con puertos separados; incluyen historial de informes, Settings y el clic de Description sin tocar otras secciones. Estos resultados validan el laboratorio, no el acceso de proveedores a Leboncoin.

Validación de esta entrega: `pnpm check:collector` aprobado, con 139 pruebas de API, 8 de frontend, 4 de contratos y 7 E2E. Typecheck, build del laboratorio y control de tokens aprobados. También pasaron typecheck/build del monorepo y las suites existentes ejecutadas por separado. El comando global en paralelo encontró un timeout de una prueba existente de lectura del catálogo; su suite pasó al ejecutarla separadamente.

Arranque, demo, CLI y extensibilidad: [collector-lab.md](collector-lab.md). Metodología y veredictos: [collector-evaluation.md](collector-evaluation.md).
