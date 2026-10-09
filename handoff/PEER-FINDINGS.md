# Peer findings from lane 07-contoso (not applied: no peer repo writes)

1. **01-mosaicstudio** — at `studio-v0.8.1`, `docs/contracts/artifact.schema.json` does not declare the additive
   provenance lineage fields (`producer`, `inputs`, `inputHash`) that `artifact.ts` and the Python mirror
   `datapass_artifact.py` accept. A strict JSON-schema consumer rejects valid lineage-carrying artifacts.
   Proposed: add the three optional fields to the schema. Contoso checks the base contract without them and
   relies on the TypeScript validator for the full artifact.
2. **Product decision (owner)** — the operational lab's Gold-to-app mapping for retail channels to app
   departments is declared but disabled (`docs/fabric-apps/GOLD-MAPPING.md`). It needs a product choice of
   the mapping before it can be enabled.
3. **02-datapass-react** — two traces stay partial (`docs/datapass-react/TRACES.md`); the analyzer was not edited.
