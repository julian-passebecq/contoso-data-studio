import { authenticated, email, entity, many, text, uuid } from '@microsoft/rayfin-core';
import { Actual } from './Actual.js';
import { Forecast } from './Forecast.js';

/** A business unit that owns a monthly sales forecast. Everyone signed in may read the list. */
@entity()
@authenticated('read')
export class Department {
  @uuid() id!: string;
  @text({ unique: true, max: 12, regex: /^[A-Z]{2,12}$/ }) code!: string;
  @text({ max: 80 }) name!: string;
  /** Finance owner. Forecast and Actual rows copy it into owner_email so the row policy can use it. */
  @email() finance_owner_email!: string;
  @many(() => Forecast) forecasts?: Forecast[];
  @many(() => Actual) actuals?: Actual[];
}
