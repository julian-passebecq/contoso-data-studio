function renderValue(value: unknown) {
  if (value === null || value === undefined) return <span className="nullValue">NULL</span>;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export default function DataTable({columns,rows}:{columns:string[];rows:unknown[][]}) {
  if (!columns.length) return <div className="emptyState">No tabular result.</div>;
  return <div className="tableScroller">
    <table className="dataTable">
      <thead><tr>{columns.map(column=><th key={column}>{column}</th>)}</tr></thead>
      <tbody>
        {rows.map((row,index)=><tr key={index}>
          {columns.map((column,colIndex)=><td key={`${column}-${colIndex}`}>{renderValue(row[colIndex])}</td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}
