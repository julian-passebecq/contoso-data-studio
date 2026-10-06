import { authenticated, decimal, email, entity, one, text, uuid } from '@microsoft/rayfin-core';
import { Department } from './Department.js';

/**
 * Monthly sales forecast, edited by the department's finance owner.
 *
 * Rayfin 1.36.2 only accepts the built-in roles (`authenticated`, `anonymous`) in
 * `@role`, so the app roles `finance` and `executive` are carried by the `role`
 * claim and checked inside the policy (see docs/fabric-apps/ADR-001.md).
 *  - executive: read every department
 *  - finance:   read, create and update rows of its own department only
 */
@entity()
@authenticated('read', {
  policy: (claims, item) => claims.role.eq('executive').or(claims.email.eq(item.owner_email)),
})
@authenticated(['create', 'update'], {
  policy: (claims, item) => claims.role.eq('finance').and(claims.email.eq(item.owner_email)),
})
export class Forecast {
  @uuid() id!: string;
  @one(() => Department) department!: Department;
  @text({ regex: /^\d{4}-(0[1-9]|1[0-2])$/ }) month!: string;
  @decimal({ min: 0, max: 100000000, precision: 18, scale: 2 }) amount!: number;
  @text({ optional: true, max: 200 }) note?: string;
  @email() owner_email!: string;
  @text({ optional: true, max: 120 }) updated_by?: string;
  @text({ optional: true, max: 40 }) updated_at?: string;
}
