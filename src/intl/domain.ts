import type { PropertyListing, ScoreKey, ScoringMetric, ScoringRecipe } from "../types";
import type { LocaleCode } from "./locales";
import type { MessageId } from "./messages";

export const scoreMessageIds: Record<ScoreKey | "overall", MessageId> = {
  overall: "score.overall",
  coast: "score.coast",
  quiet: "score.quiet",
  value: "score.value",
  family: "score.family",
  transit: "score.transit",
  dpe: "score.dpe",
  flood: "score.flood",
};

const propertyTitles: Record<LocaleCode, Record<string, string>> = {
  fr: {
    p1: "Maison en pierre",
    p2: "Longère rénovée",
    p3: "Appartement T3",
    p4: "Maison de bord de mer",
    p5: "Maison familiale",
    p6: "Maison en pierre",
    p7: "Maison intra-muros",
    p8: "Maison de bourg",
    p9: "Maison contemporaine",
    p10: "Penty rénové",
    p11: "Maison",
    p12: "Maison ancienne",
  },
  es: {
    p1: "Casa de piedra",
    p2: "Casa rural renovada",
    p3: "Apartamento T3",
    p4: "Casa junto al mar",
    p5: "Casa familiar",
    p6: "Casa de piedra",
    p7: "Casa intramuros",
    p8: "Casa de pueblo",
    p9: "Casa contemporánea",
    p10: "Casa bretona renovada",
    p11: "Casa",
    p12: "Casa antigua",
  },
};

type ScoringCopy = Pick<ScoringMetric, "group" | "name" | "short" | "formula" | "inputs" | "sample">;

const scoringCopies: Record<LocaleCode, Record<ScoringMetric["id"], ScoringCopy>> = {
  fr: {
    coast: {
      group: "Lieu",
      name: "Accès littoral",
      short: "Distance, relief et temps d'accès réel vers la côte.",
      formula: "100 x exp(-d_côte / 8 km) - pénalité_route",
      inputs: ["Polygones côtiers IGN", "Réseau routier OSM", "Dénivelé cumulé"],
      sample: { good: "Cancale, 800 m de la plage", weak: "Rennes centre, 65 km" },
    },
    quiet: {
      group: "Environnement",
      name: "Calme nuit",
      short: "Niveau sonore médian estimé entre 22h et 6h.",
      formula: "55 - Lden_nuit, ramené sur 0-10",
      inputs: ["Cartes de bruit", "Axes routiers majeurs", "Voies ferrées"],
      sample: { good: "Saint-Briac, 38 dB", weak: "Abords D137, 67 dB" },
    },
    value: {
      group: "Marché",
      name: "Valeur IRIS",
      short: "Écart prix/m² du bien contre transactions comparables.",
      formula: "z-score inverse du prix/m² vs IRIS sur 12 mois",
      inputs: ["DVF", "IRIS INSEE", "Typologie comparable"],
      sample: { good: "-12 % vs IRIS, 8 ventes", weak: "+24 % vs IRIS" },
    },
    family: {
      group: "Vie quotidienne",
      name: "Vie de famille",
      short: "Écoles, crèches, parcs et sécurité de secteur.",
      formula: "0.4 x écoles + 0.3 x crèches + 0.2 x parcs + 0.1 x sécurité",
      inputs: ["Éducation nationale", "Parcs OSM", "Indicateurs communaux"],
      sample: { good: "Pleurtuit, école A + parc 300 m", weak: "ZI, pas d'école proche" },
    },
    transit: {
      group: "Mobilité",
      name: "TER et bus",
      short: "Temps de trajet et fréquence vers Rennes / Saint-Malo.",
      formula: "10 x (1 - t_rennes / 90 min) avec correctif fréquence",
      inputs: ["GTFS TER", "BreizhGo", "Marche OSRM"],
      sample: { good: "Dinan, TER 28 min", weak: "Plouër, bus rare" },
    },
    dpe: {
      group: "Bien",
      name: "Énergie DPE",
      short: "Étiquette DPE convertie en score avec correction âge.",
      formula: "lookup(DPE) - 0.5 x (diagnostic > 5 ans)",
      inputs: ["DPE annonce", "ADEME open data", "Année diagnostic"],
      sample: { good: "B, diagnostic 2024", weak: "F, diagnostic 2017" },
    },
    flood: {
      group: "Risque",
      name: "Inondation",
      short: "Probabilité d'être en zone PPRI risquée.",
      formula: "10 x (1 - P_zonage) avec décote zone rouge",
      inputs: ["PPRI Géorisques", "Altitude", "Distance cours d'eau"],
      sample: { good: "Hors zone, altitude +18 m", weak: "Zone bleue crue centennale" },
    },
    weekend: {
      group: "Composite",
      name: "Weekend retreat",
      short: "Score composite pour résidence secondaire en Bretagne nord.",
      formula: "0.35 x côte + 0.25 x calme + 0.20 x valeur + 0.10 x TER + 0.10 x DPE",
      inputs: ["Accès littoral", "Calme", "Valeur", "Mobilité", "DPE"],
      sample: { good: "Cancale, 8.2 global", weak: "Lamballe, 6.4 global" },
    },
  },
  es: {
    coast: {
      group: "Ubicación",
      name: "Acceso al litoral",
      short: "Distancia, relieve y tiempo real de acceso a la costa.",
      formula: "100 x exp(-d_costa / 8 km) - penalización_ruta",
      inputs: ["Polígonos costeros IGN", "Red vial OSM", "Desnivel acumulado"],
      sample: { good: "Cancale, 800 m de la playa", weak: "Centro de Rennes, 65 km" },
    },
    quiet: {
      group: "Entorno",
      name: "Calma nocturna",
      short: "Nivel sonoro mediano estimado entre 22h y 6h.",
      formula: "55 - Lden_noche, normalizado en 0-10",
      inputs: ["Mapas de ruido", "Ejes viales principales", "Vías ferroviarias"],
      sample: { good: "Saint-Briac, 38 dB", weak: "Alrededores D137, 67 dB" },
    },
    value: {
      group: "Mercado",
      name: "Valor IRIS",
      short: "Desvío del precio/m² frente a transacciones comparables.",
      formula: "z-score inverso del precio/m² vs IRIS en 12 meses",
      inputs: ["DVF", "IRIS INSEE", "Tipología comparable"],
      sample: { good: "-12 % vs IRIS, 8 ventas", weak: "+24 % vs IRIS" },
    },
    family: {
      group: "Vida diaria",
      name: "Vida familiar",
      short: "Escuelas, guarderías, parques y seguridad del sector.",
      formula: "0.4 x escuelas + 0.3 x guarderías + 0.2 x parques + 0.1 x seguridad",
      inputs: ["Educación nacional", "Parques OSM", "Indicadores comunales"],
      sample: { good: "Pleurtuit, escuela A + parque 300 m", weak: "Zona industrial, sin escuela cercana" },
    },
    transit: {
      group: "Movilidad",
      name: "TER y buses",
      short: "Tiempo de viaje y frecuencia hacia Rennes / Saint-Malo.",
      formula: "10 x (1 - t_rennes / 90 min) con ajuste de frecuencia",
      inputs: ["GTFS TER", "BreizhGo", "Caminata OSRM"],
      sample: { good: "Dinan, TER 28 min", weak: "Plouër, bus escaso" },
    },
    dpe: {
      group: "Inmueble",
      name: "Energía DPE",
      short: "Etiqueta DPE convertida en score con corrección por antigüedad.",
      formula: "lookup(DPE) - 0.5 x (diagnóstico > 5 años)",
      inputs: ["DPE del anuncio", "ADEME open data", "Año del diagnóstico"],
      sample: { good: "B, diagnóstico 2024", weak: "F, diagnóstico 2017" },
    },
    flood: {
      group: "Riesgo",
      name: "Inundación",
      short: "Probabilidad de estar en una zona PPRI riesgosa.",
      formula: "10 x (1 - P_zonificación) con descuento zona roja",
      inputs: ["PPRI Géorisques", "Altitud", "Distancia a cursos de agua"],
      sample: { good: "Fuera de zona, altitud +18 m", weak: "Zona azul crecida centenaria" },
    },
    weekend: {
      group: "Compuesto",
      name: "Escapada de fin de semana",
      short: "Score compuesto para segunda residencia en el norte de Bretaña.",
      formula: "0.35 x costa + 0.25 x calma + 0.20 x valor + 0.10 x TER + 0.10 x DPE",
      inputs: ["Acceso al litoral", "Calma", "Valor", "Movilidad", "DPE"],
      sample: { good: "Cancale, 8.2 global", weak: "Lamballe, 6.4 global" },
    },
  },
};

const recipeCopies: Record<LocaleCode, Record<string, Pick<ScoringRecipe, "name" | "description">>> = {
  fr: {
    weekend: {
      name: "Weekend retreat",
      description: "Résidence secondaire, accès mer rapide, calme la nuit, prix défendable.",
    },
    family: {
      name: "Maison famille",
      description: "Vie quotidienne, écoles, calme et mobilité avant proximité littorale.",
    },
    invest: {
      name: "Investissement locatif",
      description: "Rendement potentiel, transport et sous-valorisation locale.",
    },
    draft: {
      name: "Weekend retreat",
      description: "Résidence secondaire, accès mer rapide, calme la nuit, prix défendable.",
    },
  },
  es: {
    weekend: {
      name: "Escapada de fin de semana",
      description: "Segunda residencia, mar rápido, calma nocturna y precio defendible.",
    },
    family: {
      name: "Casa familiar",
      description: "Vida diaria, escuelas, calma y movilidad antes que proximidad al litoral.",
    },
    invest: {
      name: "Inversión en alquiler",
      description: "Rentabilidad potencial, transporte e infravaloración local.",
    },
    draft: {
      name: "Escapada de fin de semana",
      description: "Segunda residencia, mar rápido, calma nocturna y precio defendible.",
    },
  },
};

const scoringGroupCopies: Record<LocaleCode, Record<string, string>> = {
  fr: {
    Lieu: "Lieu",
    Environnement: "Environnement",
    Marche: "Marché",
    Marché: "Marché",
    "Vie quotidienne": "Vie quotidienne",
    Mobilite: "Mobilité",
    Mobilité: "Mobilité",
    Bien: "Bien",
    Risque: "Risque",
    Composite: "Composite",
  },
  es: {
    Lieu: "Ubicación",
    Environnement: "Entorno",
    Marche: "Mercado",
    Marché: "Mercado",
    "Vie quotidienne": "Vida diaria",
    Mobilite: "Movilidad",
    Mobilité: "Movilidad",
    Bien: "Inmueble",
    Risque: "Riesgo",
    Composite: "Compuesto",
  },
};

export function getPropertyTitle(property: PropertyListing, locale: LocaleCode) {
  return propertyTitles[locale][property.id] ?? property.title;
}

export function localizeScoring(scoring: ScoringMetric, locale: LocaleCode): ScoringMetric {
  const copy = scoringCopies[locale][scoring.id];
  return copy ? { ...scoring, ...copy } : scoring;
}

export function localizeScoringGroup(group: string, locale: LocaleCode) {
  return scoringGroupCopies[locale][group] ?? group;
}

export function localizeRecipe(recipe: ScoringRecipe, locale: LocaleCode): ScoringRecipe {
  const copy = recipeCopies[locale][recipe.id];
  const filters = recipe.filters.map((filter) =>
    filter.field === "type" && ["Maison", "Casa"].includes(filter.value)
      ? { ...filter, value: locale === "es" ? "Casa" : "Maison" }
      : filter,
  );

  return copy ? { ...recipe, ...copy, filters } : { ...recipe, filters };
}
