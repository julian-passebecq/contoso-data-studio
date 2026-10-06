/**
 * LOCAL ADAPTER, NOT RAYFIN API.
 *
 * A stand-in for `RayfinClient` from @microsoft/rayfin-client with the same call shapes, so app
 * code can move to Fabric by swapping this file for `new RayfinClient<AppSchema>(...)`:
 *   client.data.Forecast.select([...]).where({...}).orderBy({...}).first(n).execute()   (rayfin-guide 1.36.2)
 *   client.data.forecasts.query().select([...]).execute()                                (Learn article shape)
 *   client.data.Forecast.findById(id) / .create(data) / .update({ id }, patch)           (rayfin-guide 1.36.2)
 *   client.auth.getSession()
 * Transport: REST to /api/fabric-apps/<app>; the fake user travels in `X-Local-User` instead of an Entra ID token.
 */
import type { AppSchema, LocalUser } from "./types";

export const APP_BASE = "/api/fabric-apps/sales-forecasting";

type Fetch = typeof fetch;
type Where<T> = { [K in keyof T]?: { eq: T[K] } };
type OrderBy<T> = { [K in keyof T]?: "asc" | "desc" };

export class LocalRayfinError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class QueryBuilder<T> {
  private body: { select?: string[]; where?: Where<T>; orderBy?: OrderBy<T>; first: number } = { first: 100 };

  constructor(private readonly run: (body: unknown) => Promise<T[]>) {}

  select(fields: string[]): this {
    this.body.select = fields;
    return this;
  }

  where(filter: Where<T>): this {
    this.body.where = { ...this.body.where, ...filter };
    return this;
  }

  orderBy(order: OrderBy<T>): this {
    this.body.orderBy = { ...this.body.orderBy, ...order };
    return this;
  }

  /** Page size; -1 asks for every matching row (Rayfin caps it server-side). */
  first(count: number): this {
    this.body.first = count;
    return this;
  }

  toJSON() {
    return { ...this.body };
  }

  execute(): Promise<T[]> {
    return this.run(this.toJSON());
  }
}

export class EntityClient<T> {
  constructor(private readonly client: LocalRayfinClient, readonly entity: string) {}

  select(fields: string[]): QueryBuilder<T> {
    return this.query().select(fields);
  }

  where(filter: Where<T>): QueryBuilder<T> {
    return this.query().where(filter);
  }

  /** Learn-article shape: client.data.<plural>.query().select([...]).execute() */
  query(): QueryBuilder<T> {
    return new QueryBuilder<T>(async body => {
      const result = await this.client.request<{ items: T[] }>("POST", `/data/${this.entity}/query`, body);
      return result.items;
    });
  }

  findById(id: string): Promise<T> {
    return this.client.request<T>("GET", `/data/${this.entity}/${encodeURIComponent(id)}`);
  }

  create(data: Partial<T> & Record<string, unknown>): Promise<T & { _seq: number }> {
    return this.client.request("POST", `/data/${this.entity}`, data);
  }

  update(filter: { id: string }, patch: Partial<T> & Record<string, unknown>): Promise<T & { _seq: number }> {
    return this.client.request("PATCH", `/data/${this.entity}`, { filter, patch });
  }
}

const PLURALS: Record<string, keyof AppSchema> = { departments: "Department", forecasts: "Forecast", actuals: "Actual" };

export type DataProxy = { [K in keyof AppSchema]: EntityClient<AppSchema[K]> } & {
  departments: EntityClient<AppSchema["Department"]>;
  forecasts: EntityClient<AppSchema["Forecast"]>;
  actuals: EntityClient<AppSchema["Actual"]>;
};

export class LocalRayfinClient {
  readonly data: DataProxy;
  readonly auth = {
    getSession: () => ({
      isAuthenticated: Boolean(this.user),
      user: this.user ? { id: this.user.id, email: this.user.email, name: this.user.display_name, role: this.user.role } : null,
    }),
  };

  constructor(private user: LocalUser | null, private readonly fetcher: Fetch = (...args) => fetch(...args)) {
    const entities = {} as Record<string, EntityClient<unknown>>;
    for (const name of ["Department", "Forecast", "Actual"] as const) entities[name] = new EntityClient(this, name);
    for (const [plural, name] of Object.entries(PLURALS)) entities[plural] = entities[name];
    this.data = entities as unknown as DataProxy;
  }

  /** Local only: the role switcher signs in as another fake user. */
  signInAs(user: LocalUser) {
    this.user = user;
  }

  async request<R>(method: string, path: string, body?: unknown): Promise<R> {
    const headers: Record<string, string> = {};
    if (this.user) headers["X-Local-User"] = this.user.id;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetcher(`${APP_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new LocalRayfinError(String(payload.detail ?? `Request failed: ${response.status}`), response.status);
    }
    return payload as R;
  }
}
