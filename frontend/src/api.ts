export interface ApiIssue { code: string; field: string; message: string; }
export interface Page<T> { items: T[]; next_cursor: string | null; }
export interface Rule {
  id: number;
  effective_from: string;
  effective_to: string | null;
  max_quantity_per_dispense: number;
  max_quantity_per_30_days: number;
  requires_authorisation: boolean;
  is_current?: boolean;
}
export interface Medicine {
  code: string;
  name: string;
  form: string;
  strength_value: string;
  strength_unit: string;
  is_active: boolean;
  current_rule?: Rule | null;
}
export interface Dispense {
  id: number;
  medicine_code: string;
  patient_ref: string;
  quantity: number;
  dispensed_at: string;
  authorisation_ref: string | null;
}

export class ApiFailure extends Error {
  /** Carry server errors and distinguish a definitive rejection from an unknown outcome. */
  constructor(public issues: ApiIssue[], public status: number) {
    // Preserve readable messages while keeping their field associations.
    super(issues.map(issue => issue.message).join(' '));
  }
}

/** Fetch JSON from the same-origin API without another HTTP abstraction dependency. */
export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Preserve AbortError so views can discard canceled requests silently.
  const response = await fetch(`/api/v1${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new ApiFailure(body.errors, response.status);
  return body as T;
}

/** Display a safe message for either a structured rejection or a network failure. */
export function describeError(error: unknown): string {
  return error instanceof ApiFailure ? error.message : 'Could not reach the server. Please try again.';
}
