# Probar el laboratorio

## Abrirlo en esta máquina

Abrir [http://127.0.0.1:5175](http://127.0.0.1:5175). Si la demo sigue encendida, no hace falta arrancar otro proceso. Las claves ya están configuradas en el backend de este checkout; no reemplazar su `.env`.

Si no responde, ejecutar desde la raíz del repositorio:

```bash
pnpm dev:collector
```

La interfaz usa el puerto 5175 y su API el 4315. Cerrar la pestaña no cancela una captura; detener el backend sí interrumpe su seguimiento. Para capturar mientras se edita código, usar el arranque sin recarga automática de [collector-lab.md](collector-lab.md).

## Revisar lo obtenido sin gastar créditos

1. Entrar en **Capturas / Captures**.
2. Seleccionar **34 URLs découvertes par Firecrawl — détails dépliés v3**. La foto de la primera campaña contiene 34 anuncios: 18 fichas validadas y 16 incompletas.
3. Abrir una tarjeta. Revisar descripción, imágenes, campos recuperados y campos sin resolver. Una ficha incompleta conserva igualmente los datos que sí se obtuvieron.
4. Cambiar entre tarjetas y tabla. **Exportar / Export** descarga la captura completa, incluidas las evidencias; la paginación de pantalla no recorta el archivo.
5. En **Evaluación / Evaluation**, abrir un informe del historial. Las referencias históricas incompletas dan un resultado **inconcluso**, como corresponde; no sirven para certificar cobertura actual.

Consultar, abrir informes y exportar no realizan llamadas pagadas. **Reanudar / Resume** sí puede enviar nuevas solicitudes para los trabajos fallidos.

## Hacer una captura nueva con Firecrawl

1. Entrar en **Nueva captura / New capture**.
2. Fuente: **Leboncoin**. Proveedor: **Firecrawl**.
3. Estrategia: **Agent + detalles desplegados / Agent + expanded details** (`firecrawl-agent-expanded-v3`).
4. Modo: **URLs conocidas / Known listings**. Pegar una URL de anuncio por línea y darle un nombre a la captura.
5. Iniciar y observar el progreso. **Detener / Stop** impide los siguientes despachos; una solicitud que ya está en curso puede facturarse.

Una URL utilizada en la POC fue `https://www.leboncoin.fr/ad/ventes_immobilieres/3196687682`. Su disponibilidad puede cambiar; también se puede pegar cualquier anuncio inmobiliario activo de Leboncoin.

El modo **Búsqueda completa / Complete search** prueba descubrimiento y detalle. Sigue siendo experimental en Leboncoin: los bloqueos, filtros sin verificar o páginas pendientes impiden declarar cobertura completa. Empezar con URLs conocidas permite observar la extracción dirigida de forma más clara.

Las claves permanecen en el backend. El presupuesto acumulado del laboratorio se consulta en **Settings → Development**. Una captura nueva consume créditos; nunca se activan recargas automáticas desde el laboratorio.

## Evidencias y comandos útiles

```bash
# Verificación del software con proveedores simulados, sin gasto real:
pnpm check:collector

# Regenerar el informe local de todas las capturas, sin gasto real:
pnpm report:collector
```

Los informes se generan en `apps/collector-api/.data/reports/`. La base, las capturas y las claves quedan en esta máquina, excluidas de Git. El commit conserva el código, los tests, la configuración de ejemplo y la documentación; en otro checkout habrá que configurar claves y copiar las evidencias que se deseen consultar.

Resultados observados y limitaciones: [collector-poc-findings.md](collector-poc-findings.md). Referencia completa de arranque, API y adaptadores: [collector-lab.md](collector-lab.md).
