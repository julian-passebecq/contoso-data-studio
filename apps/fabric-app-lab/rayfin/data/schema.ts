// Rayfin layout: every entity of the app is listed here as a type map.
// This file and ./entities/* carry over unchanged to a real Fabric App.
import { Actual } from './entities/Actual.js';
import { Department } from './entities/Department.js';
import { Forecast } from './entities/Forecast.js';

export const schema = {
  Department,
  Forecast,
  Actual,
};

export type Schema = typeof schema;
export { Actual, Department, Forecast };
