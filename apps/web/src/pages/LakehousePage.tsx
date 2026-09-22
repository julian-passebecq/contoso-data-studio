import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson } from "../api";
import type { CatalogTable } from "../types";

export default function LakehousePage({refreshToken=0}:{refreshToken?:number}) {
  const [tables,setTables] = useState<CatalogTable[]>([]);
  const [error,setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await getJson<{tables:CatalogTable[]}>("/api/lakehouse/catalog");
      setTables(data.tables); setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load catalog.");
    }
  },[]);

  useEffect(()=>{ void load(); },[load,refreshToken]);

  return <Card>
    <CardHeader
      header={<Title3>DuckLake catalog</Title3>}
      description="Bronze / Silver / Gold"
      action={<Button onClick={load}>Refresh</Button>}
    />
    {error && <Text className="errorText">{error}</Text>}
    <div className="layerColumns">
      {["bronze","silver","gold"].map(layer=><section className="layer" key={layer}>
        <div className="layerTitle"><b>{layer.toUpperCase()}</b><Badge appearance="outline">{tables.filter(t=>t.schema===layer).length}</Badge></div>
        {tables.filter(t=>t.schema===layer).map(table=><div className="tableItem" key={`${table.schema}.${table.name}`}>
          <span>{table.name}</span><small>{table.type}</small>
        </div>)}
        {!tables.some(t=>t.schema===layer) && <div className="emptyState">No tables yet.</div>}
      </section>)}
    </div>
  </Card>;
}
