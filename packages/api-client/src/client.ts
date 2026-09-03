import createClient from "openapi-fetch";

import type { paths } from "./generated/schema.js";

export interface MiteApiClientOptions {
  baseUrl: string;
  bearerToken: string;
}

export function createMiteApiClient({
  baseUrl,
  bearerToken,
}: MiteApiClientOptions) {
  return createClient<paths>({
    baseUrl,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });
}

export type MiteApiClient = ReturnType<typeof createMiteApiClient>;
