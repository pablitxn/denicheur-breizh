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
  en: {
    p1: "Stone house",
    p2: "Renovated longhouse",
    p3: "Three-room flat",
    p4: "Seaside house",
    p5: "Family house",
    p6: "Stone house",
    p7: "House within the city walls",
    p8: "Village house",
    p9: "Contemporary house",
    p10: "Renovated Breton cottage",
    p11: "House",
    p12: "Period house",
  },
};

const sourcePropertyTitles: Record<string, string> = {
  p1: "Maison en pierre",
  p2: "Longere renovee",
  p3: "Appartement T3",
  p4: "Maison de bord de mer",
  p5: "Maison familiale",
  p6: "Maison en pierre",
  p7: "Maison intra-muros",
  p8: "Maison de bourg",
  p9: "Maison contemporaine",
  p10: "Penty renove",
  p11: "Maison",
  p12: "Maison ancienne",
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
      name: "Escapade week-end",
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
  en: {
    coast: {
      group: "Location",
      name: "Coastal access",
      short: "Distance, terrain and actual travel time to the coast.",
      formula: "100 x exp(-coast_distance / 8 km) - road_penalty",
      inputs: ["IGN coastal polygons", "OSM road network", "Cumulative elevation gain"],
      sample: { good: "Cancale, 800 m from the beach", weak: "Central Rennes, 65 km" },
    },
    quiet: {
      group: "Environment",
      name: "Night-time quiet",
      short: "Estimated median noise level between 10 pm and 6 am.",
      formula: "55 - Lden_night, normalised to 0-10",
      inputs: ["Noise maps", "Major roads", "Railways"],
      sample: { good: "Saint-Briac, 38 dB", weak: "Near the D137, 67 dB" },
    },
    value: {
      group: "Market",
      name: "IRIS value",
      short: "Difference between the listing price/m² and comparable transactions.",
      formula: "inverse z-score of price/m² vs IRIS over 12 months",
      inputs: ["DVF", "INSEE IRIS", "Comparable property type"],
      sample: { good: "12% below IRIS, 8 sales", weak: "24% above IRIS" },
    },
    family: {
      group: "Daily life",
      name: "Family life",
      short: "Schools, nurseries, parks and local safety.",
      formula: "0.4 x schools + 0.3 x nurseries + 0.2 x parks + 0.1 x safety",
      inputs: ["French Education Ministry", "OSM parks", "Municipal indicators"],
      sample: { good: "Pleurtuit, A-rated school + park 300 m", weak: "Industrial estate, no nearby school" },
    },
    transit: {
      group: "Mobility",
      name: "Rail and bus",
      short: "Travel time and frequency to Rennes and Saint-Malo.",
      formula: "10 x (1 - time_to_Rennes / 90 min) with frequency adjustment",
      inputs: ["TER GTFS", "BreizhGo", "OSRM walking"],
      sample: { good: "Dinan, 28 min by rail", weak: "Plouër, infrequent bus" },
    },
    dpe: {
      group: "Property",
      name: "DPE energy",
      short: "DPE rating converted into a score with an age adjustment.",
      formula: "lookup(DPE) - 0.5 x (assessment > 5 years)",
      inputs: ["Listing DPE", "ADEME open data", "Assessment year"],
      sample: { good: "B, assessed in 2024", weak: "F, assessed in 2017" },
    },
    flood: {
      group: "Risk",
      name: "Flood risk",
      short: "Likelihood of being in a high-risk PPRI zone.",
      formula: "10 x (1 - zoning_probability) with red-zone discount",
      inputs: ["Géorisques PPRI", "Elevation", "Distance from waterways"],
      sample: { good: "Outside zone, elevation +18 m", weak: "Blue zone, 100-year flood" },
    },
    weekend: {
      group: "Composite",
      name: "Weekend retreat",
      short: "Composite score for a second home in northern Brittany.",
      formula: "0.35 x coast + 0.25 x quiet + 0.20 x value + 0.10 x rail + 0.10 x DPE",
      inputs: ["Coastal access", "Quiet", "Value", "Mobility", "DPE"],
      sample: { good: "Cancale, 8.2 overall", weak: "Lamballe, 6.4 overall" },
    },
  },
};

const recipeCopies: Record<LocaleCode, Record<string, Pick<ScoringRecipe, "name" | "description">>> = {
  fr: {
    weekend: {
      name: "Escapade week-end",
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
      name: "Escapade week-end",
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
  en: {
    weekend: {
      name: "Weekend retreat",
      description: "Second home with quick sea access, quiet nights and a defensible price.",
    },
    family: {
      name: "Family house",
      description: "Daily life, schools, quiet and mobility take priority over proximity to the coast.",
    },
    invest: {
      name: "Buy-to-let investment",
      description: "Potential yield, transport and local undervaluation.",
    },
    draft: {
      name: "Weekend retreat",
      description: "Second home with quick sea access, quiet nights and a defensible price.",
    },
  },
};

const sourceRecipeCopies: Record<string, Pick<ScoringRecipe, "name" | "description">> = {
  weekend: {
    name: "Weekend retreat",
    description: "Residence secondaire, acces mer rapide, calme la nuit, prix defendable.",
  },
  family: {
    name: "Maison famille",
    description: "Vie quotidienne, ecoles, calme et mobilite avant proximite littorale.",
  },
  invest: {
    name: "Investissement locatif",
    description: "Rendement potentiel, transport et sous-valorisation locale.",
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
  en: {
    Lieu: "Location",
    Environnement: "Environment",
    Marche: "Market",
    Marché: "Market",
    "Vie quotidienne": "Daily life",
    Mobilite: "Mobility",
    Mobilité: "Mobility",
    Bien: "Property",
    Risque: "Risk",
    Composite: "Composite",
  },
};

const scoringTagCopies: Record<LocaleCode, Record<string, string>> = {
  fr: { Custom: "Personnalisé", Composite: "Composite" },
  es: { Custom: "Personalizado", Composite: "Compuesto" },
  en: { Custom: "Custom", Composite: "Composite" },
};

export function getPropertyTitle(property: PropertyListing, locale: LocaleCode) {
  const localizedTitle = propertyTitles[locale][property.id];
  if (!localizedTitle) return property.title;

  const isMockDomainCopy =
    sourcePropertyTitles[property.id] === property.title ||
    Object.values(propertyTitles).some((catalog) => catalog[property.id] === property.title);
  return isMockDomainCopy ? localizedTitle : property.title;
}

export function localizeScoring(scoring: ScoringMetric, locale: LocaleCode): ScoringMetric {
  const isKnownDomainCopy =
    scoring.builtIn ||
    Object.values(scoringCopies).some((catalog) => catalog[scoring.id]?.name === scoring.name);
  const copy = isKnownDomainCopy ? scoringCopies[locale][scoring.id] : undefined;
  if (!copy) return { ...scoring, inputs: [...scoring.inputs], tags: [...scoring.tags] };

  const tags = scoring.tags.map((tag) => scoringTagCopies[locale][tag] ?? tag);
  return { ...scoring, ...copy, tags };
}

export function localizeScoringGroup(group: string, locale: LocaleCode) {
  return scoringGroupCopies[locale][group] ?? group;
}

export function localizeRecipe(recipe: ScoringRecipe, locale: LocaleCode): ScoringRecipe {
  const localizedCopy = recipeCopies[locale][recipe.id];
  const isKnownDomainCopy = [
    sourceRecipeCopies[recipe.id],
    ...Object.values(recipeCopies).map((catalog) => catalog[recipe.id]),
  ].some((copy) => copy?.name === recipe.name && copy.description === recipe.description);
  const copy = isKnownDomainCopy ? localizedCopy : undefined;
  const filters = recipe.filters.map((filter) => ({ ...filter }));

  return copy ? { ...recipe, ...copy, filters } : { ...recipe, filters };
}
