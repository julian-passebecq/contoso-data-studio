# Peer findings from lane 07-contoso (not applied: no peer repo writes)

1. **01-mosaicstudio** - RESOLVED 2026-10-10 by MosaicStudio #46 (`f3a02bc`): `artifact.schema.json` now declares the
   provenance lineage fields; Contoso exports pass it strictly and the gate is required.
2. **Product decision (owner)** - RESOLVED 2026-10-09 by #15 (NORD/SOUTH/ONLINE mapping, `GOLD-MAPPING.md` section 3).
3. **02-datapass-react** - traces completed on the Contoso side with verified/inferred/unresolved labels (#16); one
   trace stays PARTIAL because its SQL is user input. No headless analyzer CLI at React 2e922ea; a cross-check needs
   a wrapper around `analyzeWorkspace` in the React repo (React lane's choice).
4. Noted, not changed (product behaviour, see `docs/datapass-react/TRACES.md`): on a retail project the Transform
   selector accepts `forecast_vs_actual`, which builds nothing unless `fabric_apps_enabled` is passed; on a FOIL project
   `dbt build` rebuilds only the FOIL models and retail Gold keeps its last build.
