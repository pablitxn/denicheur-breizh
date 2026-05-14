import { properties, providers, recipes, scorings } from "../assets/mockData";
import type { PropertyFilters, PropertyListing, ScoringMetric, ScoringRecipe } from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "");

async function waitForMock() {
  await new Promise((resolve) => window.setTimeout(resolve, 120));
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error("No backend configured");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function applyPropertyFilters(source: PropertyListing[], filters?: Partial<PropertyFilters>) {
  if (!filters) {
    return source;
  }

  return source.filter((property) => {
    const providerMatch = !filters.providers?.length || filters.providers.includes(property.provider);
    const priceMatch =
      (filters.priceMin === undefined || property.price >= filters.priceMin) &&
      (filters.priceMax === undefined || property.price <= filters.priceMax);
    const surfaceMatch = filters.surfaceMin === undefined || property.surfaceM2 >= filters.surfaceMin;
    const dpeMatch = filters.dpeMax === undefined || property.dpe <= filters.dpeMax;

    return providerMatch && priceMatch && surfaceMatch && dpeMatch;
  });
}

export const denicheurApi = {
  async listProperties(filters?: Partial<PropertyFilters>): Promise<PropertyListing[]> {
    if (API_BASE_URL) {
      const params = new URLSearchParams();
      filters?.providers?.forEach((provider) => params.append("provider", provider));
      if (filters?.priceMin !== undefined) params.set("priceMin", String(filters.priceMin));
      if (filters?.priceMax !== undefined) params.set("priceMax", String(filters.priceMax));
      if (filters?.surfaceMin !== undefined) params.set("surfaceMin", String(filters.surfaceMin));
      if (filters?.dpeMax !== undefined) params.set("dpeMax", filters.dpeMax);

      return requestJson<PropertyListing[]>(`/properties?${params.toString()}`);
    }

    await waitForMock();
    return applyPropertyFilters(properties, filters);
  },

  async listProviders() {
    if (API_BASE_URL) {
      return requestJson<string[]>("/providers");
    }

    await waitForMock();
    return [...providers];
  },

  async listScorings(): Promise<ScoringMetric[]> {
    if (API_BASE_URL) {
      return requestJson<ScoringMetric[]>("/scorings");
    }

    await waitForMock();
    return scorings;
  },

  async listRecipes(): Promise<ScoringRecipe[]> {
    if (API_BASE_URL) {
      return requestJson<ScoringRecipe[]>("/recipes");
    }

    await waitForMock();
    return recipes;
  },

  async saveRecipe(recipe: ScoringRecipe): Promise<ScoringRecipe> {
    if (API_BASE_URL) {
      return requestJson<ScoringRecipe>(`/recipes/${recipe.id}`, {
        method: "PUT",
        body: JSON.stringify(recipe),
      });
    }

    await waitForMock();
    return { ...recipe, status: "saved" };
  },
};
