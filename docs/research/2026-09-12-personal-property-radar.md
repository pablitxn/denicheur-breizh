# Un radar personal de oportunidades inmobiliarias

La dirección propuesta para dénicheur·breizh es una búsqueda persistente que selecciona candidatos, explica por qué encajan y conserva las decisiones personales. El resultado cotidiano debería ser una pequeña bandeja de oportunidades y dudas concretas por resolver. La calidad se mide por el trabajo de búsqueda que evita y por las buenas opciones que permite descubrir.

El punto de partida de esta investigación fue una búsqueda residencial personal en Bretaña. La visión se amplió a proyectos con finalidad y presupuesto propios, normalización de anuncios y fichas enriquecidas por visitas, documentos, reformas y negociación. Ese alcance y el orden de construcción revisado están en [Proyectos, fichas de inmuebles y radar personal](/Users/pablitxn/repos/denicheur-breizh/docs/property-dossier-product-model.md). Los ejemplos son hipotéticos y sirven para discutir el producto; sus precios, atributos y clasificaciones no son evaluaciones del catálogo.

La documentación pública se consultó el 12 de septiembre de 2026. Las capacidades de otros productos se distinguen de las propuestas para esta aplicación. Las publicaciones comerciales muestran patrones y funciones documentadas, pero no acreditan por sí solas precisión, cobertura completa ni ahorro de tiempo. La disponibilidad general de Zillow AI mode no quedó confirmada: su lanzamiento documentaba una beta limitada.

## 1. Una forma clara de pensar el producto

Conviene separar las preguntas que hoy se concentran en el constructor:

| Concepto | Pregunta que resuelve | Ejemplo |
|---|---|---|
| Búsqueda personal o radar | ¿Qué estoy intentando encontrar y dónde lo buscamos? | Casa para vivir cerca del mar |
| Inmueble | ¿Cuál es la casa sobre la que decido? | Una casa publicada por dos agencias |
| Anuncio | ¿Quién publica qué información y cuándo? | Una publicación con precio y fotos propios |
| Observación y etiqueta | ¿Qué sabemos de la casa y de dónde sale? | Jardín visible; vista al mar mencionada |
| Criterio personal | ¿Cómo afecta ese atributo a esta búsqueda? | Jardín imprescindible; vista al mar deseable |
| Tier sugerido | ¿Qué prioridad merece dentro de esta búsqueda? | S: excepcional; A: muy buen encaje |
| Seguimiento personal | ¿Qué decidí hacer con ella? | Guardada, contactada, visitada, descartada |

Una casa puede tener la etiqueta «para reformar», ser tier B para mudarse pronto y tier A para un proyecto de reforma. También puede ser tier S y estar ya visitada. Cambiar el estado de seguimiento no debería alterar los hechos de la propiedad.

Las colecciones manuales y las vistas dinámicas complementan este modelo. «Mis cinco favoritas» es una selección personal; «Casas con jardín que cumplen el presupuesto» es una consulta que se actualiza. Una propiedad puede aparecer en varias vistas sin duplicarse.

**La promesa de producto:** «Contame qué buscás; te mostramos candidatos con motivos, conservamos tus decisiones y te avisamos cuando cambia algo relevante».

## 2. Referentes y patrones transferibles

| Referente | Capacidad documentada | Aplicación propuesta | Límite de la evidencia |
|---|---|---|---|
| Jinka | Reúne fuentes en una alerta configurable; declara limpieza y deduplicación antes de notificar.[^1] | Guardar una búsqueda viva con estado de vigilancia y novedades. | No aporta una medida independiente de cobertura, precisión ni demora. |
| MoteurImmo | Agrupa publicaciones de un inmueble, permite comparar versiones y conserva historial de republicaciones.[^2] | Mantener notas, descartes y tags aunque cambie el anuncio. Permitir corregir una agrupación. | El proveedor reconoce que pueden escaparse variantes. |
| Redfin | Refina una búsqueda conversacional a partir de una casa y propone flexibilizaciones cuando faltan resultados.[^3] | «Me gusta, salvo…» y propuestas de ajuste con efecto visible. | Sus métricas comerciales no demuestran ahorro de revisión manual. |
| Zillow | Describe búsqueda conversacional, contexto persistente, interpretación de fotos y comparación de alternativas.[^4] | Combinar texto, imágenes y preferencias; mostrar qué evidencia sostiene cada señal. | Beta limitada al lanzamiento; precisión visual y acceso general actual no verificados. |
| Bien’ici | Ofrece contexto cartográfico, puntos de interés, tiempo de viaje y exposición solar.[^5] | Un grupo de criterios «Mi vida alrededor»: playa, compras, estación y destinos habituales. | La exactitud depende de datos y localización disponibles. |
| Airtable | Sus agentes de campo generan valores estructurados, permiten previsualización y preservan correcciones humanas ante actualizaciones automáticas.[^6] | Criterios independientes, corregibles y con fecha; reevaluar lo desactualizado. | Previsualizar un registro no valida los casos difíciles. |
| Clay | Distingue condiciones binarias, puntuaciones y grados; genera fórmulas que se revisan antes de guardar.[^7] | Separar admisión, preferencias y tiers. | La fórmula necesita representar correctamente las prioridades. |
| Feedly | Permite refinar un feed desde un resultado y precisar el motivo de irrelevancia.[^8] | Convertir el descarte en una señal útil con motivos breves. | No publica cuánto feedback necesita ni garantiza la calidad del ajuste. |
| Linear | Distingue sugerencias de IA de metadatos confirmados y muestra explicaciones bajo demanda.[^9] | Una cola de dudas y sugerencias que se pueden aceptar o corregir. | Es un patrón de interacción transferible; su rendimiento en tareas no demuestra rendimiento inmobiliario. |

Dos referencias complementarias ayudan a diseñar el editor. Clay permite describir el objetivo en «Generate» e inspeccionar después instrucciones y salidas en «Configure».[^10] Linear convierte filtros, incluso compuestos, en vistas guardadas y permite suscribirse a nuevas coincidencias.[^11] La combinación sugiere un recorrido corto: intención → criterios editables → ejemplos → búsqueda guardada.

La oportunidad para dénicheur·breizh está en integrar estos patrones alrededor de preferencias personales muy específicas. Esta investigación no prueba que ningún competidor reúna todas las capacidades; sí identifica elementos concretos que merece la pena combinar y probar.

## 3. Qué podemos aprovechar de la aplicación actual

El motor ya admite criterios con descripción, peso, obligatoriedad y exigencia de evidencia. Sus resultados son «cumple», «no cumple» o «no se sabe»; el servidor calcula la puntuación y la decisión. Un obligatorio incumplido descarta; un obligatorio desconocido deriva a revisión. Las referencias a texto e imágenes se validan. Esto ofrece una base real para explicar resultados y distinguir preferencias de condiciones imprescindibles.[^L1][^L2]

Las recetas y planes tienen versiones. Los planes fijan versiones concretas y combinan recetas mediante todas/cualquiera. El score agregado usa mínimo/máximo, respectivamente; ese resultado no representa una suma global de preferencias entre escenarios. La capacidad existente sirve como base para alternativas del tipo «casa costera o casa de campo», con una presentación más comprensible.[^L3]

El constructor conserva borradores, duplicación y publicación. Sin embargo, la pantalla observada en Browser empieza por identificadores, versiones, pesos y descripciones extensas. Evaluaciones empieza por plan, recopilación terminada y ejecución; en la sesión inspeccionada mostraba cero ejecuciones y ningún run terminado seleccionable. La experiencia cotidiana todavía se parece a una herramienta para configurar y ejecutar el motor.[^L4]

Hay infraestructura reutilizable de ejecución, caché, reintentos y cancelación. La extensión puede disparar evaluaciones al terminar una recopilación detallada. Su alarma periódica sincroniza datos; no inicia por sí misma búsquedas recurrentes. El laboratorio de recopilación está separado del producto principal.[^L5]

En los contratos y rutas principales revisados no aparecen todavía entidades de etiquetas personalizadas, tiers, feedback o búsquedas nombradas con notificaciones. La presentación del catálogo privilegia una evaluación reciente; la propuesta necesita resultados asociados a cada búsqueda, para conservar prioridades diferentes sobre una misma casa.[^L6]

**Hallazgo que condiciona el diseño:** los criterios desconocidos quedan fuera del denominador del score actual. Una propiedad puede obtener 100/100 con poca información evaluable. Ese número no significa «100 % compatible» ni «100 % seguro». Antes de convertirlo en tiers hay que mostrar y considerar la cobertura de evidencia.[^L2]

## 4. Criterios personalizados sin obligar a programar

El editor puede empezar con tres grupos: **Necesito**, **Me gustaría** y **Quiero evitar**. Cada fila describe una sola condición y ofrece un ejemplo. Los campos numéricos se evalúan con reglas; el texto y las fotos aportan observaciones semánticas; los cálculos geográficos usan servicios y ubicaciones verificables.

| Criterio de ejemplo | Cómo se interpreta | Evidencia adecuada | Si no hay información |
|---|---|---|---|
| Precio anunciado hasta 400.000 € | Condición numérica obligatoria | Precio y fecha de la publicación | Pedir precio; no inferirlo |
| Jardín privado | Obligatorio o preferencia | Descripción explícita; una foto puede aportar indicios | «No consta si es privado» |
| Vista al mar desde la vivienda | Preferencia fuerte | Texto explícito o imagen contextualizada | Mantener pendiente; cercanía al mar no basta |
| Fachada blanca | Preferencia visual | Foto adecuada de la fachada | Desconocido si iluminación o encuadre impiden distinguir |
| Evitar grandes reformas | Condición con alcance definido | Estado descrito y señales visibles | Listar lo que requiere inspección |
| Llegar caminando a la playa | Tiempo y modo de viaje | Ubicación suficientemente precisa, acceso y ruta | Mostrar aproximación o no calcular |
| Espacio para trabajar | Característica funcional | Habitación, distribución o superficie útil indicada | No equiparar automáticamente a número de habitaciones |
| Aspecto parecido a mis favoritas | Preferencia aprendida | Ejemplos elegidos y atributos que gustan | Pedir el motivo; no asumir que gustan todos sus rasgos |

El precio anunciado y el presupuesto total deben ser conceptos distintos. Si se quiere controlar adquisición más obras y otros costes, los componentes tienen que estar presentes o expresarse como escenarios; un precio atractivo no completa los datos faltantes.

Un criterio como «casa luminosa» requiere precisar el significado: luz aparente en fotos, orientación, superficie acristalada o exposición estimada durante el año. Esas señales pueden convivir, pero no deberían transformarse en una sola afirmación sin matices. «Sin grandes reformas» tampoco puede certificarse a partir de imágenes comerciales.

**Ejemplo de edición:** «Vista al mar» → importancia «me importa mucho» → prueba «desde la vivienda o parcela» → falta de datos «dejar para verificar». El texto avanzado que utiliza el evaluador queda desplegable. La etiqueta resultante muestra «mencionada en el anuncio» o «visible en foto», según corresponda.

Para condiciones complejas, la progresión propuesta es: criterio simple, grupo de alternativas y, finalmente, reglas avanzadas. «Acepto una casa más pequeña si está frente al mar» se representa como dos escenarios comprensibles. Un lienzo de nodos y conexiones debería esperar a que los casos reales lo justifiquen.

## 5. Tiers útiles, incertidumbre visible

La clasificación propuesta tiene tres pasos. Primero se resuelven los imprescindibles y exclusiones. Después se valoran las preferencias sobre los candidatos admisibles. Finalmente se asigna un tier con suficiente información, conservando cualquier duda que pueda cambiar la decisión.

| Resultado | Significado propuesto | Comportamiento |
|---|---|---|
| S · Excepcional | Cumple los imprescindibles y alcanza el mejor nivel de preferencias definido para esta búsqueda | Destacar con motivos y evidencia suficiente |
| A · Muy buen encaje | Cumple lo necesario y ofrece varias ventajas importantes | Mantener en la selección principal |
| B · Alternativa | Cumple lo necesario con compromisos relevantes | Explicar el compromiso; permitir comparar |
| Por verificar | Falta un dato capaz de cambiar admisión o prioridad | Mostrar pregunta pendiente y prioridad potencial |
| Fuera de criterios | Incumple una condición definida | Conservar accesible con motivo y posibilidad de recuperación |

«Por verificar» es una cola de trabajo por falta de información, no una medida de calidad de la casa. Puede coexistir con «potencial A». El tier sugerido también debe diferenciarse de una prioridad fijada manualmente; un favorito personal no borra un incumplimiento.

Los cortes deben ser estables dentro de una versión de búsqueda. Si ningún inmueble merece S, la categoría puede quedar vacía. La entrada de veinte casas mediocres no debería ascender una casa anterior sólo por posición relativa. Los nombres y condiciones de cada tier podrán personalizarse después de validar una primera clasificación sencilla.

Para resolver datos incompletos propongo evaluar un intervalo de encaje posible. Ejemplo: dos preferencias confirmadas suman 40 puntos de un total de 100 y faltan los otros 60. El encaje conocido es favorable, pero el resultado completo podría estar entre 40 y 100. Ese intervalo representa escenarios extremos de información faltante, no una probabilidad ni un intervalo estadístico. Si los extremos producen categorías distintas, la UI explica qué dato decidiría el cambio.

La cobertura indica cuánto se pudo evaluar; la calidad de evidencia indica qué sostiene cada evaluación. Ninguna equivale a confianza calibrada. Una cifra como «92 % seguro» exigiría validación empírica que hoy no tenemos.

La guía pública de análisis multicriterio advierte que los pesos sin escalas claras pueden inducir resultados engañosos y propone estudiar cómo cambian las decisiones al variar supuestos.[^12] Para este producto, eso inspira comparar ejemplos y mostrar sensibilidad antes de activar una nueva configuración. No se propone convertir una suma de preferencias personales en una tasación objetiva.

## 6. La experiencia que conviene prototipar

**Entrada: «¿Qué estás buscando?»** Una frase libre, una plantilla o una vivienda de referencia. El sistema produce un borrador visible. Por ejemplo, «una casa con jardín cerca del mar, para entrar a vivir» se descompone en zona, jardín, relación con el mar y estado. Si «cerca» es ambiguo, se pide esa precisión en contexto.

**Editor con resultados al lado.** A la izquierda, imprescindibles, preferencias y exclusiones. A la derecha, anuncios de ejemplo con resultado y motivo. El cambio de un filtro numérico puede verse al instante; una nueva interpretación de fotos muestra procesamiento y mantiene identificados los resultados anteriores. La interfaz nunca debe presentar evaluaciones antiguas como resultado del criterio recién editado.

**Laboratorio de ejemplos.** Elegir algunas casas que gustan, otras que no y varios casos ambiguos. Sobre los siete anuncios actuales se puede discutir vocabulario e interacción; esa muestra no valida la precisión general. Más adelante se amplía con ejemplos representativos y un conjunto separado que no se usó para ajustar los criterios.

**Activación concreta.** El cierre presenta «Estos criterios se aplicarán a los nuevos anuncios» y permite decidir si también se revisan los existentes. Antes de una evaluación costosa, muestra el alcance y una estimación disponible. Los cambios conservan una versión anterior recuperable.

**Pantalla cotidiana.** La búsqueda abre una bandeja de novedades, con acceso a guardadas, por verificar y descartadas. Lista, mapa y tablero son distintas maneras de recorrer esos resultados. Las ejecuciones y las versiones quedan en el historial de la búsqueda.

Una tarjeta necesita foto, ubicación, precio, tier, dos motivos útiles y la principal duda. Ejemplo ficticio: «Por verificar · Potencial A. Jardín confirmado y dentro del presupuesto. Falta confirmar si la vista corresponde a la vivienda». Al abrir el motivo se ve el fragmento o la imagen original. Las acciones visibles son guardar, comparar y descartar; el resto puede ir en un menú.

**Comparación final.** Una matriz de pocas casas pone en filas los criterios que realmente distinguen las alternativas. Permite fijar una favorita y anotar un compromiso: «prefiero ésta aunque tiene menos superficie». Esas elecciones aportan información más explícita que el tiempo que una foto permaneció abierta.

| Alternativa de editor | Ventaja | Inconveniente | Uso propuesto |
|---|---|---|---|
| Asistente paso a paso | Ayuda a empezar sin conocer el modelo | Hace lentas las modificaciones frecuentes | Creación inicial opcional |
| Criterios + vista previa | Conecta cada cambio con sus consecuencias | Necesita estados de evaluación claros | Experiencia principal |
| Grafo de reglas | Expresa combinaciones complejas | Exige aprender una herramienta | Sólo cuando aparezca una necesidad recurrente |

La interfaz debe conservar lenguaje y apariencia elegidos, navegación por teclado y señales que no dependan sólo del color. «Por verificar» necesita texto y una acción concreta; una foto o un tooltip no pueden ser la única manera de entender el resultado.

## 7. Aprender de las decisiones personales

La primera versión puede recoger feedback explícito sin entrenar un recomendador propio. «No me gusta» abre motivos rápidos y opcionales. Cada motivo se dirige al lugar adecuado:

| Feedback | Qué cambia o propone |
|---|---|
| «La foto no demuestra vista al mar» | Corrección de evidencia de ese inmueble |
| «No quiero esta zona» | Propuesta de cambio en esta búsqueda |
| «Esta casa ya la vi» | Estado personal o posible duplicado |
| «Me gusta pese a la reforma» | Excepción personal; conserva el motivo |
| «Buscá más con este estilo» | Solicitud de semejanza con atributos seleccionados |

El aprendizaje debe conservar alcance y reversibilidad. Un descarte no autoriza a excluir todo un barrio en todas las búsquedas. Las propuestas de ajuste pueden mostrar: «Descartaste varias casas por reformas. Si hacemos este criterio obligatorio, estas opciones quedarían fuera». La decisión se acepta, se modifica o se ignora.

Las guías de interacción humano-IA de Microsoft respaldan corrección sencilla, feedback granular y cambios cautelosos.[^13] Aquí eso se concreta en distinguir dato corregido, preferencia sugerida y regla activa. La evidencia existente debe prevalecer frente a explicaciones convincentes pero no sustentadas.

Para empezar, la mayor parte del valor puede venir de buenos datos, condiciones explícitas y una clasificación comprensible. Google recomienda objetivos medibles y sistemas simples antes de añadir complejidad de aprendizaje.[^14] Un modelo personalizado tendría sentido cuando el historial permita demostrar que mejora las decisiones frente a esa base.

## 8. Mantener candidatos relevantes en el tiempo

La búsqueda automática necesita adquisición fiable además de criterios inteligentes. La propuesta completa conecta búsqueda guardada, captura, normalización, agrupación de publicaciones, enriquecimiento, clasificación y novedades. Si la captura está detenida, la app debe mostrarlo; «no aparecieron candidatos» y «no se pudo revisar la fuente» son situaciones distintas.

Cada búsqueda debería indicar última revisión satisfactoria y estado por fuente. Un dato viejo puede seguir siendo útil, pero conserva fecha y origen. Las agrupaciones dudosas de anuncios deben poder separarse; dos casas similares no bastan para afirmar que son la misma.

La reevaluación debe responder a cambios que afecten la decisión: precio, fotos nuevas, descripción más completa o criterio revisado. Un cambio de precio puede recalcular una condición numérica sin repetir todo el análisis de imágenes. Modificar la importancia de un atributo puede reordenar resultados reutilizando observaciones compatibles; modificar su definición exige revisarlas.

Los avisos deben contar novedades útiles: candidato nuevo, regreso al presupuesto o evidencia que resuelve una duda. Una republicación sin cambios relevantes no merece otra interrupción. Se puede ofrecer resumen periódico y un nivel de prioridad elegido por búsqueda. El canal de notificación se configura cuando se implemente; este informe no activa ninguna vigilancia.

Las oportunidades más inciertas merecen preguntas dirigidas. «Falta confirmar el jardín privado y eso decide si pasa» es una tarea concreta. «Faltan 17 campos» no ayuda a priorizar. El enriquecimiento adicional debería concentrarse primero en datos capaces de cambiar la selección.

## 9. Ampliaciones que podrían diferenciarlo

**Contexto de vida.** La API de isócronas de IGN admite áreas alcanzables según tiempo o distancia, con perfiles de peatón y coche.[^15] Puede apoyar criterios de proximidad real cuando haya una posición adecuada. Una localidad aproximada no permite asegurar el trayecto desde una vivienda; en ese caso el resultado debe quedar explícitamente aproximado o pendiente.

**Contexto territorial documentado.** Géorisques publica mapas, datos y acceso por API.[^16] Es una posible fuente para incorporar capas territoriales a una ficha. La interpretación requiere comprobar cobertura, escala y localización; un punto aproximado del anuncio no debe producir conclusiones categóricas sobre la parcela.

**Historial y comparables.** Los datos DVF geolocalizados contienen transacciones y datos de parcela, con limitaciones de geocodificación documentadas.[^17] Podrían añadir contexto histórico. Su disponibilidad no basta para declarar una «ganga»: hay que definir comparabilidad, temporalidad, estado y alcance de cada transacción.

**Semejanza controlable.** Se puede elegir una favorita y pedir «más con esta distribución» o «con este exterior», conservando presupuesto y condiciones. La dimensión visual elegida debe quedar visible; la similitud de una foto no sustituye las características de la casa.

**Alternativas con un compromiso.** Una vista puede mostrar candidatos casi compatibles e identificar la flexibilización exacta. «Si ampliamos cinco minutos el trayecto, aparecen estas casas» sería una simulación sobre datos comprobados. La búsqueda activa cambia sólo al aceptar el ajuste.

**Memoria de preferencias compartida por escenarios.** Algunas preferencias podrían reutilizarse entre búsquedas, como necesidad de espacio de trabajo. Otras pertenecen únicamente a un proyecto. La UI debe mostrar cuándo se comparte una regla para evitar cambios inesperados en varias selecciones.

## 10. Iteraciones recomendadas y cómo evaluarlas

Esta secuencia es la propuesta inicial de la investigación. La ampliación a fichas personales incorpora primero identidad de inmueble y observaciones trazables; el [orden revisado](/Users/pablitxn/repos/denicheur-breizh/docs/property-dossier-product-model.md) conserva estas capacidades y añade el trabajo de visitas, documentación y escenarios económicos.

| Iteración | Entrega funcional y UX | Evidencia de que sirve |
|---|---|---|
| 1. Hacer comprensible la decisión | Imprescindibles/preferencias/exclusiones; ejemplos al lado; motivos y datos pendientes | Se puede explicar por qué pasan o fallan los ejemplos y corregir un criterio sin editar prompts |
| 2. Crear una selección personal | Búsqueda guardada; tiers explicables; tags; favoritos y descarte con motivo; resultados por búsqueda | Se puede organizar y retomar una selección sin perder decisiones ni confundir perfiles |
| 3. Mantenerla actualizada | Adquisición recurrente integrada, novedades, estado de fuentes, cambios y agrupación de publicaciones | Una casa republicada conserva su seguimiento; un fallo de captura se distingue de cero novedades |
| 4. Afinar mediante feedback | Sugerencias de criterios, comparación de alternativas y búsqueda por semejanza | Mejora frente a la configuración anterior en ejemplos separados de los usados para ajustarla |

Para la primera sesión de diseño conviene elegir tres casas que gustan, dos que no y los motivos. Los siete anuncios actuales pueden servir si contienen contrastes útiles; de lo contrario se añaden ejemplos representativos. A partir de ellos se construyen cinco criterios iniciales y se prueba qué ocurre al convertir una preferencia en obligatoria.

Las métricas propuestas son trabajo manual por candidato útil, proporción de candidatos mostrados que se guardan o se consideran visitar, buenas opciones recuperadas desde descartados y novedades repetidas. Los falsos descartes necesitan revisar una muestra fuera de la bandeja principal: medir únicamente lo mostrado ocultaría ese problema.

También interesa cuánto tarda en resolverse una duda importante, cuántas correcciones requiere cada criterio y qué porcentaje de información crítica queda sin evaluar. Las metas numéricas se fijarán después de obtener una base de uso real. Ni un mayor número de reglas ni más tiempo dentro de la aplicación demuestran éxito.

La recomendación inmediata es prototipar **criterios con vista previa sobre anuncios**, seguido de una selección con motivos y dudas visibles. La infraestructura existente permite empezar por esa experiencia y aprender qué vocabulario y qué reglas ayudan antes de ampliar la automatización.

## Fuentes

Fuentes públicas consultadas el 12/09/2026. «Sin fecha visible» indica ausencia de una fecha editorial confirmada, no ausencia de actualizaciones.

[^1]: Jinka. [Qui est Jinka ? Votre allié pour trouver votre logement vite et bien](https://www.jinka.fr/qui-sommes-nous). Sin fecha visible. Alertas, agregación y capacidades declaradas de limpieza.
[^2]: Thomas / MoteurImmo. [Dédoublonnage des annonces : ne perdez plus de temps avec les doublons](https://blog.moteurimmo.fr/dedoublonnage-des-annonces-ne-perdez-plus-de-temps-avec-les-doublons/). 19/12/2025. Agrupación, versiones e historial.
[^3]: Redfin. [Redfin Debuts Conversational Search to Reinvent How People Find Homes](https://www.redfin.com/news/press-releases/redfin-debuts-conversational-search-to-reinvent-how-people-find-homes/). 13/11/2025. Refinamiento y flexibilización sugerida.
[^4]: Zillow. [How Zillow’s new AI mode works throughout the real estate journey](https://www.zillow.com/news/how-zillows-new-ai-mode-works-throughout-the-real-estate-journey/) y [Zillow debuts AI mode](https://www.zillow.com/news/zillow-debuts-ai-mode/). 25/03/2026. Capacidades anunciadas y límite de beta.
[^5]: Bien’ici. [Cartographie Bien’ici](https://solutionspro.bienici.com/nos-offres/agent-immobilier/renforcer-lattractivite-de-mes-annonces/cartographie-bienici/). Sin fecha visible. Contexto, trayectos y exposición solar.
[^6]: Airtable. [Using Airtable AI in fields](https://support.airtable.com/articles/8052242094-using-airtable-ai-in-fields). Documentación consultada, sin fecha editorial confirmada en este informe. Valores estructurados, previsualización y correcciones humanas.
[^7]: Clay. [Lead scoring](https://university.clay.com/docs/lead-scoring-overview). Sin fecha visible. Condiciones, puntuaciones y grados.
[^8]: Feedly. [Refining Feedly AI Feeds](https://docs.feedly.com/article/549-refining-feedly-ai-feeds). Actualizado el 21/07/2025. Feedback desde resultados.
[^9]: Yann-Edern Gillet y Matthijs Wolting / Linear. [How we built Triage Intelligence](https://linear.app/now/how-we-built-triage-intelligence). 03/09/2025. Distinción visual entre sugerencias y datos confirmados.
[^10]: Clay. [Use AI](https://university.clay.com/docs/use-ai-integration-overview). Sin fecha visible. Generación a partir de intención y configuración inspeccionable.
[^11]: Linear. [Custom Views](https://linear.app/docs/custom-views) y [Filters](https://linear.app/docs/filters). Sin fecha visible. Vistas persistentes, suscripciones y filtros compuestos.
[^12]: Government Analysis Function. [An Introductory Guide to Multi-Criteria Decision Analysis](https://analysisfunction.civilservice.gov.uk/policy-store/an-introductory-guide-to-mcda/). Guía metodológica, fecha editorial no confirmada aquí. Escalas, pesos y sensibilidad.
[^13]: Mihaela Vorvoreanu, Saleema Amershi y Penny Collisson / Microsoft Research. [Guidelines for Human-AI Interaction: Eighteen best practices for human-centered AI design](https://www.microsoft.com/en-us/research/articles/guidelines-for-human-ai-interaction-eighteen-best-practices-for-human-centered-ai-design/). 05/03/2019. Corrección, feedback y adaptación cautelosa.
[^14]: Martin Zinkevich / Google for Developers. [Rules of Machine Learning](https://developers.google.com/machine-learning/guides/rules-of-ml). Guía metodológica, versión consultada. Simplicidad inicial, infraestructura y métricas.
[^15]: IGN / cartes.gouv.fr. [Calcul d’isochrone/isodistance](https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/calcul-isochrone-isodistance/). Modificado el 31/08/2026. Capacidades y parámetros geográficos.
[^16]: Géorisques. [Accéder à la carte interactive, aux bases de données et à l’API](https://www.georisques.gouv.fr/acceder-la-carte-interactive-aux-bases-de-donnees-et-lapi). Sin fecha visible. Disponibilidad de fuentes territoriales.
[^17]: data.gouv.fr, derivado de DGFiP. [Demandes de valeurs foncières géolocalisées](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees). Versión consultada. Campos, procedencia y límites de geocodificación.

Fuentes locales inspeccionadas, correspondientes al checkout de trabajo:

[^L1]: [Contratos de criterios y recetas](/Users/pablitxn/repos/denicheur-breizh/packages/contracts/src/index.ts:162).
[^L2]: [Cálculo del score y tratamiento de desconocidos](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/filterService.ts:95) y [validación de evidencia](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/modelOutput.ts:76).
[^L3]: [Contratos de planes](/Users/pablitxn/repos/denicheur-breizh/packages/contracts/src/index.ts:213) y [combinación de resultados](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/evaluationCombiner.ts:25).
[^L4]: [Constructor](/Users/pablitxn/repos/denicheur-breizh/apps/web/src/features/builder/BuilderView.tsx:195), [editor](/Users/pablitxn/repos/denicheur-breizh/apps/web/src/features/builder/BuilderView.tsx:411) y [Evaluaciones](/Users/pablitxn/repos/denicheur-breizh/apps/web/src/features/scorings/ScoringsView.tsx:145). Contrastados con Browser en localhost:5173.
[^L5]: [Servicio de ejecución](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/evaluationExecutionService.ts:34), [evaluación al completar captura](/Users/pablitxn/repos/denicheur-breizh/apps/extension/src/ui/DashboardApp.tsx:531), [alarma de sincronización](/Users/pablitxn/repos/denicheur-breizh/apps/extension/entrypoints/background.ts:59) y [laboratorio separado](/Users/pablitxn/repos/denicheur-breizh/docs/collector-lab.md:3).
[^L6]: [Contrato de anuncios](/Users/pablitxn/repos/denicheur-breizh/packages/contracts/src/index.ts:745), [API principal](/Users/pablitxn/repos/denicheur-breizh/apps/api/src/app.ts:221) y [normalización del catálogo](/Users/pablitxn/repos/denicheur-breizh/apps/web/src/api/denicheurApi.ts:409).
