export type ProviderName = "SeLoger" | "Bien'ici" | "Leboncoin" | "Ouest-France";

export type DpeGrade = "A" | "B" | "C" | "D" | "E" | "F" | "G";
export type PropertyType = "house" | "apartment" | "land";

export type ScoreKey = "coast" | "quiet" | "value" | "family" | "transit" | "dpe" | "flood";

export interface PropertyScores extends Record<ScoreKey, number> {
  overall: number;
}

export interface PropertyListing {
  id: string;
  title: string;
  propertyType: PropertyType;
  locality: string;
  address: string;
  price: number;
  surfaceM2: number;
  rooms: number;
  provider: ProviderName;
  coordinates: {
    lat: number;
    lng: number;
  };
  dpe: DpeGrade;
  scores: PropertyScores;
  postedDaysAgo: number;
  diagnostics: {
    irisMedianPrice: number;
    comparableSales: number;
    noiseDbNight: number;
    coastalDistanceKm: number;
    transitMinutes: number;
  };
}

export interface ScoringMetric {
  id: ScoreKey | "weekend";
  group: string;
  name: string;
  icon: string;
  short: string;
  formula: string;
  inputs: string[];
  sample: {
    good: string;
    weak: string;
  };
  tags: string[];
  builtIn: boolean;
}

export interface RecipeFilter {
  id: string;
  field: "price" | "type" | "dpe" | "surface" | "rooms" | ScoreKey;
  operator: "eq" | "neq" | "lte" | "gte" | "between";
  value: string;
}

export interface ScoringRecipe {
  id: string;
  name: string;
  description: string;
  status: "draft" | "saved";
  weights: Record<ScoreKey, number>;
  filters: RecipeFilter[];
}

export interface PropertyFilters {
  providers: ProviderName[];
  priceMin: number;
  priceMax: number;
  surfaceMin: number;
  dpeMax: DpeGrade;
}

export type WorkspaceView = "map" | "properties" | "scorings" | "builder" | "realtime";

export type ThemeMode = "dark" | "light";

export type AccentMode = "lavender" | "sunset" | "sea";

export type DensityMode = "comfortable" | "compact";

export interface RankedProperty extends PropertyListing {
  customScore: number;
}
