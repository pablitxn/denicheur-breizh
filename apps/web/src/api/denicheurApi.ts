import { properties, providers, recipes, scorings } from "../assets/mockData";
import type { PropertyFilters, PropertyListing, ScoringMetric, ScoringRecipe } from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "");
export const usesMockApi = !API_BASE_URL;

async function waitForMock(signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Request aborted", "AbortError"));
      return;
    }

    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, 120);
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function requestJson<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error("No backend configured");
  }

  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, signal });

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
    const providerMatch = filters.providers === undefined || filters.providers.includes(property.provider);
    const propertyTypeMatch =
      filters.propertyTypes === undefined || filters.propertyTypes.includes(property.propertyType);
    const priceMatch =
      (filters.priceMin === undefined || property.price >= filters.priceMin) &&
      (filters.priceMax === undefined || property.price <= filters.priceMax);
    const surfaceMatch = filters.surfaceMin === undefined || property.surfaceM2 >= filters.surfaceMin;
    const dpeMatch = filters.dpeMax === undefined || property.dpe <= filters.dpeMax;

    return providerMatch && propertyTypeMatch && priceMatch && surfaceMatch && dpeMatch;
  });
}

export const denicheurApi = {
  async listProperties(filters?: Partial<PropertyFilters>, signal?: AbortSignal): Promise<PropertyListing[]> {
    if (filters?.providers?.length === 0 || filters?.propertyTypes?.length === 0) {
      return [];
    }

    if (API_BASE_URL) {
      const params = new URLSearchParams();
      filters?.providers?.forEach((provider) => params.append("provider", provider));
      filters?.propertyTypes?.forEach((propertyType) => params.append("propertyType", propertyType));
      if (filters?.priceMin !== undefined) params.set("priceMin", String(filters.priceMin));
      if (filters?.priceMax !== undefined) params.set("priceMax", String(filters.priceMax));
      if (filters?.surfaceMin !== undefined) params.set("surfaceMin", String(filters.surfaceMin));
      if (filters?.dpeMax !== undefined) params.set("dpeMax", filters.dpeMax);

      return requestJson<PropertyListing[]>(`/properties?${params.toString()}`, undefined, signal);
    }

    await waitForMock(signal);
    return applyPropertyFilters(properties, filters);
  },

  async listProviders(signal?: AbortSignal) {
    if (API_BASE_URL) {
      return requestJson<string[]>("/providers", undefined, signal);
    }

    await waitForMock(signal);
    return [...providers];
  },

  async listScorings(signal?: AbortSignal): Promise<ScoringMetric[]> {
    if (API_BASE_URL) {
      return requestJson<ScoringMetric[]>("/scorings", undefined, signal);
    }

    await waitForMock(signal);
    return scorings;
  },

  async listRecipes(signal?: AbortSignal): Promise<ScoringRecipe[]> {
    if (API_BASE_URL) {
      return requestJson<ScoringRecipe[]>("/recipes", undefined, signal);
    }

    await waitForMock(signal);
    return recipes;
  },

  async saveRecipe(recipe: ScoringRecipe, signal?: AbortSignal): Promise<ScoringRecipe> {
    if (API_BASE_URL) {
      return requestJson<ScoringRecipe>(`/recipes/${recipe.id}`, {
        method: "PUT",
        body: JSON.stringify(recipe),
      }, signal);
    }

    await waitForMock(signal);
    return { ...recipe, status: "saved" };
  },
};
