# Proyectos, fichas de inmuebles y radar personal

Este documento consolida el alcance solicitado para dénicheur·breizh y propone un modelo funcional para desarrollarlo por iteraciones. Amplía el [informe de investigación](/Users/pablitxn/repos/denicheur-breizh/docs/research/2026-09-12-personal-property-radar.md), cuyos criterios inteligentes, ejemplos, evidencia, tiers, feedback y vigilancia se mantienen. Describe capacidades a construir. La primera base implementada —archivo de capturas separado del catálogo— y sus límites están detallados en [Archivo de capturas y proyección](source-record-archive.md).

La ficha de un inmueble debe acompañar el recorrido completo: descubrirlo, comparar sus publicaciones, evaluarlo para un proyecto, visitarlo, documentarlo, estimar trabajos, estudiar una negociación y registrar decisiones. Cada nueva observación enriquece esa ficha y puede cambiar su encaje con las búsquedas personales.

La [hoja de ruta de UX](ux-roadmap.md) registra la primera ficha consultable entregada y el orden propuesto para las próximas iteraciones. Esa interfaz aún representa una publicación; la identidad física unificada y la información personal editable siguen pendientes.

## 1. Alcance que se incorpora

| Necesidad | Capacidad prevista |
|---|---|
| Normalizar anuncios | Datos comparables entre fuentes conservando significado y procedencia |
| Personalizar fichas | Secciones y campos configurables según el proyecto |
| Incorporar visitas | Notas, fotografías propias, comprobaciones y preguntas pendientes por visita |
| Energía y requisitos franceses | Documentos, mediciones, declaraciones y verificaciones contextualizadas |
| Consultar profesionales | Informe o comentario atribuido, fecha, alcance y documentación asociada |
| Presupuestar reformas | Trabajos, alternativas, estimaciones y presupuestos con sus condiciones |
| Preparar negociación | Opiniones recibidas, argumentos, comparables y escenarios de oferta |
| Definir presupuesto y emprendimiento | Contexto del proyecto heredado por sus búsquedas |
| Seguir publicaciones y precios | Historial por fuente, agrupación de republicaciones y eventos relevantes |
| Aprovechar toda la investigación anterior | Criterios custom, evidencia, tiers, colecciones, comparación y aprendizaje explícito |

## 2. Objetos del producto y su relación

**Proyecto.** Expresa para qué se busca: vivienda habitual, proyecto de reforma, alojamiento o actividad concreta, entre otros. Guarda objetivo, presupuesto, componentes incluidos, plazos y restricciones generales. Los ejemplos no presuponen viabilidad normativa o económica. El tipo de actividad orienta qué información se necesita reunir.

**Búsqueda o radar.** Pertenece a un proyecto y define zona, fuentes, criterios, escenarios, tiers y política de novedades. Puede haber varias búsquedas para un mismo proyecto. Hereda sus restricciones generales; cualquier excepción se muestra expresamente. Cambiar el presupuesto del proyecto permite revisar el impacto sobre las búsquedas relacionadas antes de aplicar una nueva versión.

**Inmueble.** Representa la casa o unidad física y tiene identidad propia, aunque cambien los anuncios. Conserva sus características, publicaciones vinculadas y evidencia. Dos viviendas del mismo edificio o un conjunto vendido como lote requieren identidades y relaciones explícitas; compartir dirección no basta para fusionarlas.

**Anuncio y observación del anuncio.** Cada publicación conserva plataforma, identificador, URL, agencia cuando se conoce y fechas observadas. Cada captura significativa registra precio, contenido y disponibilidad observada. Las observaciones anteriores se conservan y permiten explicar qué cambió.

**Ficha personal del inmueble.** Reúne visitas, documentos, observaciones, intervenciones de profesionales y campos personalizados. Sus secciones pueden mostrarse según la plantilla del proyecto. Las notas personales y documentos originales no se sobrescriben al actualizar una publicación.

**Candidatura al proyecto.** Relaciona inmueble y proyecto: favoritos, seguimiento, comparación, escenarios económicos y decisiones. Las evaluaciones conservan la búsqueda y versión que las produjo. Una casa compartida por dos búsquedas no crea dos fichas físicas ni pierde sus resultados diferentes. El seguimiento personal se comparte dentro del proyecto; el tier sugerido sigue siendo específico de cada búsqueda.

## 3. Normalización con trazabilidad

Normalizar hace comparables los datos sin inventar equivalencias. Conviene conservar la observación original, su interpretación estructurada y el valor seleccionado para mostrar en la ficha. Un nuevo extractor o una corrección humana puede revisar la interpretación sin borrar el original.

| Familia de datos | Regla funcional |
|---|---|
| Precio | Guardar moneda, importe y qué incluye cuando consta; honorarios desconocidos permanecen desconocidos |
| Superficie | Separar habitable, útil, Carrez, terreno y otros conceptos; conservar el término de origen |
| Distribución | Distinguir habitaciones principales y dormitorios; no deducir uno del otro |
| Ubicación | Separar dirección, localidad, barrio, código postal y precisión de coordenadas |
| Estado y características | Distinguir declaración comercial, observación visual, visita e informe profesional |
| Energía | Guardar unidad y significado de cada valor; no mezclar diagnóstico estimado y consumo facturado |
| Ausencias | Distinguir no publicado, no extraído, no aplicable y dato pendiente de confirmar |

Cada afirmación importante conserva fuente, fecha de observación, fecha efectiva cuando se conoce, autor o rol cuando corresponde y referencia precisa: campo del anuncio, fragmento, foto, documento o página. Una conclusión de IA queda identificada como inferencia y apunta a sus evidencias.

Si el anuncio dice 120 m² y un documento indica 108 m², la ficha muestra la discrepancia y el tipo de superficie. No se promedian ni se sustituye automáticamente el valor por el más reciente. La resolución se hace por campo y contexto, con un motivo registrado. Un documento profesional puede aportar mayor evidencia, pero también puede referirse a otra fecha, alcance o unidad.

La deduplicación distingue coincidencia segura, sugerencia de coincidencia y publicaciones independientes. Las fusiones y separaciones deben ser reversibles, con historial y reasignación explícita de notas o documentos cuando haya ambigüedad. Las fotografías similares ayudan a encontrar candidatos; no prueban por sí solas identidad.

La conservación del trabajo personal es independiente de las capturas. Limpiar o reimportar anuncios no debe borrar visitas, documentos retenidos, presupuestos o decisiones. Archivar una candidatura y desvincular una publicación también son acciones diferentes. Los documentos que sustentan decisiones conservan referencias propias aunque desaparezca la publicación original.

## 4. La ficha personalizada

La primera pantalla ofrece una síntesis adaptada al proyecto: motivos para considerar el inmueble, obstáculos, información pendiente y próxima acción. Los detalles se organizan en bloques que pueden activarse, ocultarse y reordenarse. Se parte de plantillas comprensibles y se permite añadir campos propios.

| Bloque | Contenido y acciones |
|---|---|
| Resumen | Fotos, ubicación, características, tier por búsqueda y motivos principales |
| Encaje con el proyecto | Imprescindibles, preferencias, presupuesto considerado y compromisos |
| Visitas | Sesiones fechadas, notas, fotos propias, puntos comprobados y pendientes |
| Energía y documentos | Diagnósticos, facturas, informes, vigencia y discrepancias |
| Reformas | Trabajos necesarios, deseados y condicionados; presupuestos y alternativas |
| Negociación | Consejos recibidos, argumentos, escenarios y estado de conversaciones |
| Anuncios y precios | Publicaciones vinculadas, diferencias y cronología observada |
| Historial | Incorporaciones, correcciones, reevaluaciones y decisiones personales |

Los campos personalizados pueden ser texto, número con unidad, importe con moneda, fecha, selección, lista o estado sí/no/pendiente. Ejemplos: espacio para taller, acceso independiente, capacidad prevista o dudas sobre una distribución. La plantilla define cuáles alimentan criterios y cuáles son notas de contexto. Un campo nuevo no debería afectar silenciosamente la puntuación.

Una acción contextual **Agregar información** permite registrar una nota, visita, documento, observación profesional, presupuesto o cambio confirmado. Tras incorporar información, la app propone dónde ubicarla y qué campos podría actualizar. El original se conserva y las extracciones se pueden corregir. Los resúmenes de IA enlazan a la evidencia y se marcan pendientes de actualización cuando cambian sus fuentes.

## 5. Visitas, profesionales y documentación

Una visita es una sesión fechada, con propósito, participantes si son útiles, observaciones y adjuntos. Antes de ir, puede prepararse una lista breve a partir de los criterios sin resolver. Durante o después, se registra qué se observó personalmente, qué declaró el agente o propietario y qué requiere otra comprobación.

La segunda visita amplía la primera. Una observación como «olor a humedad en una habitación» conserva lugar, fecha y fotos; no se convierte automáticamente en un diagnóstico estructural. Se puede asignar una próxima acción: pedir documento, consultar a un profesional o volver a comprobar.

Una intervención profesional guarda especialidad, fecha, alcance, conclusiones, reservas y documento asociado. Debe distinguir una opinión verbal, una estimación orientativa, un informe y un presupuesto escrito. Cada conclusión mantiene su atribución; el sistema no presenta una estimación como un hecho confirmado.

Los documentos se vinculan al inmueble y también a la visita, trabajo o escenario pertinente. Se conserva el archivo original, versión, fecha, tipo, alcance, procedencia y páginas utilizadas como evidencia. Cuando haya una versión nueva, se identifica qué documento sustituye y qué información sigue vigente.

La ficha puede tener información más amplia que la necesaria para una evaluación. El conjunto de datos enviado a un análisis se delimita por propósito; los datos de contacto, contratos y documentos personales no se incluyen por defecto en resúmenes compartidos o búsquedas externas.

## 6. Energía y contexto normativo francés

Este bloque reúne evidencia y preguntas aplicables al proyecto. Debe separar diagnóstico energético, consumo real comunicado o facturado, auditoría de trabajos y presupuestos de ejecución. La ficha no puede inferir obligaciones a partir de una letra energética aislada.

Los documentos energéticos conservan identificador cuando exista, fecha, método o versión, superficie de referencia, tipo de inmueble y unidades. Se registran clase energética y emisiones como datos distintos, junto con sistemas de calefacción, agua caliente, aislamiento o ventilación cuando estén documentados. Las facturas conservan periodo, energías incluidas y contexto de uso conocido.

La documentación del Ministerio francés explica que el DPE utiliza condiciones de uso estandarizadas y sus estimaciones pueden diferir del gasto real según ocupación, clima y hábitos. Por ello, el diagnóstico y las facturas se muestran en bloques distintos. [Fuente oficial: Diagnostic de performance énergétique](https://www.ecologie.gouv.fr/politiques-publiques/diagnostic-performance-energetique-dpe), consultada el 12/09/2026.

La auditoría energética propone escenarios y estimaciones de trabajos basadas en datos de mercado. La ficha conserva esos escenarios separados de los presupuestos recibidos de empresas y de los resultados efectivamente comprobados después de una obra. [Fuente oficial: Audit énergétique réglementaire](https://www.ecologie.gouv.fr/politiques-publiques/audit-energetique-reglementaire), consultada el 12/09/2026.

Una verificación normativa necesita una pregunta concreta y contexto: uso previsto, operación, ubicación, características del inmueble, fecha aplicable y fuentes oficiales. Su resultado distingue pendiente de información, interpretación propuesta y comprobación documentada. Cada regla guarda fecha de revisión y el ámbito al que se refiere; los cambios normativos pueden crear una tarea de revisión.

La información de una visita o una afirmación comercial puede iniciar una comprobación. No sustituye el documento pertinente. Una actualización metodológica de un diagnóstico debe distinguirse de una mejora física del inmueble.

La documentación oficial contempla actualizaciones del método y certificados que pueden cambiar la etiqueta sin una transformación física de la vivienda. Esto justifica conservar diagnóstico original, certificado complementario y fundamento del cambio. La aplicabilidad de requisitos también depende de la operación y características del inmueble. [FAQ metodológica del Ministerio](https://rt-re-batiment.developpement-durable.gouv.fr/faq-dpe-modification-du-facteur-de-conversion-en-a1021.html?lang=fr), actualizada el 26/08/2026, y [Service Public: audit en caso de venta](https://www.service-public.gouv.fr/particuliers/vosdroits/F37110), consultadas el 12/09/2026. Este modelo no fija calendarios legales ni determina obligaciones para un inmueble particular.

## 7. Reformas, presupuesto total y negociación

El presupuesto del proyecto debe indicar qué abarca. La ficha distingue precio anunciado, escenario de compra, trabajos seleccionados, gastos adicionales documentados y reserva elegida para contingencias. Los componentes faltantes permanecen visibles; no se computan como cero.

Una estimación de reforma se divide en partidas con alcance, exclusiones, impuestos incluidos o no, fecha, validez cuando consta, plazo previsto y dependencias. Puede expresarse como rango. Varios presupuestos del mismo trabajo son alternativas, no cantidades que deban sumarse. Si una auditoría y un contratista contemplan la misma intervención, se conserva la relación para evitar contar el coste dos veces.

El proyecto puede comparar escenarios como «mínimo para el uso previsto», «mejora deseada» y «reforma amplia». Cada escenario selecciona sus partidas y fuentes. El total debe mostrar qué está presupuestado, qué es estimado y qué sigue pendiente. Una estimación de ahorro energético o ingreso futuro se conserva como hipótesis con método y supuestos, no como dinero garantizado.

La negociación tiene su propio registro: opiniones recibidas, comparables utilizados, argumentos, precio objetivo elegido, ofertas consideradas, enviadas o respondidas. El precio aconsejado por un asesor no reemplaza el precio anunciado. Preparar una oferta en la ficha tampoco significa haberla enviado ni aceptado.

Los escenarios permiten explorar cuánto encaja una posible operación con el presupuesto personal. La aplicación muestra el razonamiento y las incertidumbres; no inventa un «precio correcto» ni deduce un margen negociable de una bajada de precio aislada.

## 8. Radar de publicaciones y cambios

El historial de precios se registra por publicación. Al agrupar varias fuentes se ofrece una vista conjunta, manteniendo visibles sus diferencias. Un precio de agencia y otro de particular no constituyen por sí mismos una bajada temporal: pueden corresponder a condiciones o inclusiones diferentes.

La cronología distingue primera observación, publicación declarada por la fuente y última comprobación. Si sólo se observó el precio en dos fechas, se conoce el cambio entre ambas observaciones, no el día exacto en que ocurrió. Un fallo de acceso o una desaparición no demuestra una venta.

Los eventos incluyen cambio de precio comparable, nueva publicación vinculada, posible republicación, fotos nuevas, información resuelta y disponibilidad por confirmar. Cada evento permite abrir las dos observaciones que lo originan. Corregir el parser puede corregir datos históricos sin inventar una modificación del anuncio.

Los avisos dependen de la búsqueda: entró en presupuesto, apareció un candidato, se resolvió un imprescindible o cambió una casa guardada. Conservan deduplicación de eventos y el nivel de interrupción elegido. La UI distingue vigilancia funcionando, fuente retrasada y revisión necesaria. Esta visión no activa tareas programadas ni promete cobertura de plataformas todavía no integradas.

## 9. Conexión entre información nueva y evaluación

El circuito funcional propuesto es: nueva evidencia → revisión de campos afectados → actualización de la ficha → reevaluación pertinente → explicación del cambio. Se reutiliza la evidencia compatible y se evita volver a analizar elementos que no cambiaron.

Ejemplo ficticio: una casa es potencial A, pendiente de valorar las obras. Después de una visita se añade un informe y dos presupuestos alternativos. La ficha calcula cada escenario con sus partidas, identifica el impacto sobre el presupuesto y revisa los criterios afectados. El historial explica por qué cambió el tier. Los documentos, la opinión personal y la evaluación anterior siguen disponibles.

Las correcciones manuales no quedan a merced de la siguiente extracción automática. Si aparece evidencia nueva que contradice una corrección, se presenta el conflicto. El cambio de prioridad por proyecto se separa del cambio en los hechos de la casa.

## 10. Orden de construcción revisado

| Paso | Resultado | Comprobación principal |
|---|---|---|
| 1. Fundamentos de la ficha | Identidad de inmueble, publicaciones, normalización y observaciones con procedencia | Una captura nueva conserva la información manual y permite reconstruir diferencias |
| 2. Proyecto y selección | Presupuesto contextual, búsquedas, criterios con ejemplos y tiers explicables | El mismo inmueble puede evaluarse distinto por búsqueda sin duplicar su ficha |
| 3. Ficha de trabajo | Plantillas, campos propios, visitas, documentos y aportes profesionales | Se puede resolver una duda con evidencia y ver su impacto |
| 4. Escenarios económicos | Partidas de reforma, presupuestos alternativos y negociación | No se duplican costes ni se ocultan importes desconocidos |
| 5. Vigilancia integrada | Captura recurrente, publicaciones relacionadas, historia de precios y novedades | Una republicación conserva seguimiento y una fuente caída no simula ausencia de oportunidades |
| 6. Aprendizaje y enriquecimiento | Feedback, semejanza, sugerencias y contexto externo | Las mejoras se verifican sobre ejemplos y mantienen control sobre las preferencias |

El historial de observaciones debe empezar en el fundamento aunque la interfaz completa del radar llegue después. La exactitud de identidad y procedencia condiciona el valor de todos los módulos posteriores.

La próxima pieza de UX recomendada es una ficha de ejemplo completa conectada a un proyecto: resumen, visita, documento energético, presupuesto alternativo, negociación e historial. Permite validar cómo se incorpora información y cómo influye en la decisión antes de multiplicar campos y pantallas.

## 11. Casos que deben mantenerse cubiertos

- Un inmueble vuelve a publicarse con otro ID y conserva visitas, notas y decisiones.
- Dos anuncios discrepan en precio o superficie y la ficha explica la diferencia sin ocultar las fuentes.
- Una captura falla al extraer un dato y no borra el valor previamente documentado.
- Limpiar o reimportar capturas conserva el expediente personal y sus documentos.
- Una visita corrige un atributo y una actualización automática posterior conserva la corrección.
- Un documento energético actualizado cambia una etiqueta sin atribuirle obras inexistentes.
- Dos presupuestos cubren la misma intervención y se comparan como alternativas.
- Un componente de coste desconocido deja el total incompleto de forma visible.
- El asesor recomienda un precio; el precio anunciado y el historial de ofertas conservan sus significados.
- Dos búsquedas valoran de forma diferente el mismo inmueble y preservan su contexto.
- Una fuente deja de responder y la ficha muestra última comprobación, sin declarar vendido el inmueble.
- Una fusión equivocada se deshace conservando evidencias y recuperando los vínculos revisados.
- La información nueva explica un cambio de tier sin borrar la evaluación anterior.

## Fuentes y relación con la implementación

El [informe original](/Users/pablitxn/repos/denicheur-breizh/docs/research/2026-09-12-personal-property-radar.md) contiene las fuentes de producto y el diagnóstico del motor actual. Este documento extiende ese alcance con normalización, trabajo posterior a la visita y contexto de proyecto. Los nombres de entidades, organización de pantallas y orden propuesto quedan disponibles para iteración; no constituyen una migración de datos ejecutada.

La revisión del código actual identifica estos puntos de partida:

- La [tabla de anuncios](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/repository.ts:111) usa fuente e identificador externo. La [consolidación canónica](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/repository.ts:3006) reúne datos del mismo anuncio; no resuelve identidad física entre plataformas.
- Las [observaciones por recopilación](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/repository.ts:2970) aportan una base histórica, pero pueden actualizarse dentro de un mismo run. El [detalle público](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/repository.ts:1417) no ofrece un historial de sus precios. Los [snapshots temporales de paginación](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/paginationSnapshots.ts:86) tienen otra finalidad y caducan.
- La [fusión de datos capturados](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/repository.ts:3369) conserva y combina contenido, por lo que no debe utilizarse como única prueba de lo que una publicación decía en una fecha concreta.
- El [procesamiento multimedia](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/mediaProcessor.ts:7) está orientado a imágenes de anuncios. La carga de documentos personales necesita una capacidad específica. Los [campos energéticos actuales](/Users/pablitxn/repos/denicheur-breizh/packages/contracts/src/index.ts:103) no modelan un expediente documental.
- El [presupuesto de ejecución existente](/Users/pablitxn/repos/denicheur-breizh/packages/contracts/src/index.ts:549) limita consumo de IA. El presupuesto inmobiliario del proyecto requiere un concepto separado.
- La [limpieza de datos recopilados](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/repository.ts:1235) elimina entidades de captura, catálogo, evaluaciones y media. La futura ficha personal necesita conservación independiente.
