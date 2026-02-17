/**
 * Simpler.Grants.gov API client
 * @see https://api.simpler.grants.gov
 */

const BASE_URL = 'https://api.simpler.grants.gov';

/** Base URL for viewing an opportunity on Simpler.Grants.gov */
export const OPPORTUNITY_VIEW_BASE = 'https://simpler.grants.gov/opportunity';

/** Single opportunity (grant) from the API */
export interface GrantsGovOpportunity {
  opportunity_id?: string;
  opportunity_number?: string;
  opportunity_title: string;
  post_date?: string;
  close_date?: string | null;
  [key: string]: unknown;
}

/** Returns the public URL for an opportunity, or null if no ID */
export function getOpportunityUrl(opp: GrantsGovOpportunity): string | null {
  const id = opp.opportunity_id;
  return id ? `${OPPORTUNITY_VIEW_BASE}/${id}` : null;
}

/** Response from the search endpoint */
export interface SearchOpportunitiesResponse {
  data: GrantsGovOpportunity[];
  [key: string]: unknown;
}

/** Filters for the search request */
export interface SearchFilters {
  opportunity_status?: { one_of: string[] };
  applicant_type?: { one_of: string[] };
  [key: string]: unknown;
}

/** Sort order entry */
export interface SortOrderItem {
  order_by: string;
  sort_direction: 'ascending' | 'descending';
}

/** Pagination options */
export interface SearchPagination {
  page_offset: number;
  page_size: number;
  sort_order?: SortOrderItem[];
}

/** Payload for POST /v1/opportunities/search */
export interface SearchOpportunitiesPayload {
  query: string;
  filters?: SearchFilters;
  pagination: SearchPagination;
}

/** Default search payload; can be overridden per call */
const defaultSearchPayload: Omit<SearchOpportunitiesPayload, 'query'> = {
  filters: {
    opportunity_status: { one_of: ['posted'] },
    applicant_type: { one_of: ['nonprofits_non_higher_education_with_501c3', 'state_governments'] },
  },
  pagination: {
    page_offset: 1,
    page_size: 10,
    sort_order: [
      { order_by: 'close_date', sort_direction: 'ascending' },
    ],
  },
};

function getApiKey(): string {
  const key = import.meta.env.VITE_GRANT_API;
  if (!key || typeof key !== 'string') {
    throw new Error('Missing VITE_GRANT_API in environment');
  }
  return key;
}

/**
 * Search grant opportunities via simpler.grants.gov API.
 * Uses browser fetch (no node-fetch). API key from VITE_GRANT_API.
 */
export async function searchOpportunities(
  options: {
    query: string;
    filters?: SearchFilters;
    pagination?: Partial<SearchPagination>;
  }
): Promise<SearchOpportunitiesResponse> {
  const { query, filters, pagination } = options;

  const searchPayload: SearchOpportunitiesPayload = {
    query: query.trim() || 'education',
    filters: filters ?? defaultSearchPayload.filters,
    pagination: {
      ...defaultSearchPayload.pagination,
      ...pagination,
    },
  };

  const response = await fetch(`${BASE_URL}/v1/opportunities/search`, {
    method: 'POST',
    headers: {
      'X-API-Key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(searchPayload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grants.gov API error: ${response.status} ${response.statusText}. ${text}`);
  }

  const data = (await response.json()) as SearchOpportunitiesResponse;
  return data;
}
