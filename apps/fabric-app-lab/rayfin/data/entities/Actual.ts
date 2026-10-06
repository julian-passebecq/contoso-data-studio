import { authenticated, decimal, email, entity, one, text, uuid } from '@microsoft/rayfin-core';
import { Department } from './Department.js';

/** Booked monthly sales (loaded from the synthetic ERP feed). Read only in the app. */
@entity()
@authenticated('read', {
  policy: (claims, item) => claims.role.eq('executive').or(claims.email.eq(item.owner_email)),
})
export class Actual {
  @uuid() id!: string;
  @one(() => Department) department!: Department;
  @text({ regex: /^\d{4}-(0[1-9]|1[0-2])$/ }) month!: string;
  @decimal({ min: 0, max: 100000000, precision: 18, scale: 2 }) amount!: number;
  @email() owner_email!: string;
}
