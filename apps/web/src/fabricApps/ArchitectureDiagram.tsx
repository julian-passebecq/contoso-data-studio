import type { Architecture } from "./architecture";

const W = 1080;
const LAYER_X = 16;
const LAYER_W = 640;
const ROW_H = 74;
const GAP = 14;
const AUTH_X = LAYER_X + LAYER_W + 48;
const AUTH_W = W - AUTH_X - 16;

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Static SVG of the app's layers, top (UI) to bottom (chart), with auth on the side. */
export default function ArchitectureDiagram({ architecture }: { architecture: Architecture }) {
  const { layers, auth } = architecture;
  const height = 16 + layers.length * (ROW_H + GAP);
  const y = (index: number) => 16 + index * (ROW_H + GAP);
  // Auth guards the request path: UI, data client, model policies and SQL DB.
  const authTop = y(0);
  const authBottom = y(3) + ROW_H;

  return <svg className="faArch" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Sales Forecasting app architecture">
    <defs>
      <marker id="faArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0L10,5L0,10z" className="faArchArrowHead" />
      </marker>
    </defs>
    {layers.map((layer, index) => <g key={layer.key} data-layer={layer.key}>
      <rect x={LAYER_X} y={y(index)} width={LAYER_W} height={ROW_H} rx={6} className={`faArchBox ${layer.key}`} />
      <text x={LAYER_X + 14} y={y(index) + 22} className="faArchTitle">{layer.title}</text>
      <text x={LAYER_X + 14} y={y(index) + 40} className="faArchSub">local: {clip(layer.local, 40)}</text>
      <text x={LAYER_X + 14} y={y(index) + 57} className="faArchSub">Fabric: {clip(layer.fabric, 40)}</text>
      {layer.items.slice(0, layer.items.length > 4 ? 3 : 4).map((item, i) =>
        <text key={item} x={LAYER_X + 330} y={y(index) + 20 + i * 15} className="faArchItem">{clip(item, 46)}</text>)}
      {layer.items.length > 4 && <text x={LAYER_X + 330} y={y(index) + 20 + 3 * 15} className="faArchItem">+{layer.items.length - 3} more</text>}
      {index < layers.length - 1 && <line x1={LAYER_X + 60} x2={LAYER_X + 60} y1={y(index) + ROW_H} y2={y(index + 1) - 2} className="faArchArrow" markerEnd="url(#faArrow)" />}
    </g>)}
    <g data-layer="auth">
      <rect x={AUTH_X} y={authTop} width={AUTH_W} height={authBottom - authTop} rx={6} className="faArchBox auth" />
      <text x={AUTH_X + 14} y={authTop + 22} className="faArchTitle">{auth.title}</text>
      <text x={AUTH_X + 14} y={authTop + 40} className="faArchSub">local: {auth.local}</text>
      <text x={AUTH_X + 14} y={authTop + 57} className="faArchSub">Fabric: {auth.fabric}</text>
      {auth.items.slice(0, 5).map((item, i) => {
        const [head, ...rest] = item.split(": ");
        // Policies wrap at their top-level and/or, e.g. "(a) and" / "(b)".
        const lines = rest.join(": ").split(/(?<=\)) (?=and |or )/);
        return <g key={item}>
          <text x={AUTH_X + 14} y={authTop + 86 + i * 48} className="faArchItem strong">{head}</text>
          {lines.slice(0, 2).map((line, n) =>
            <text key={n} x={AUTH_X + 14 + (n ? 12 : 0)} y={authTop + 100 + i * 48 + n * 14} className="faArchItem">{clip(line, 56)}</text>)}
        </g>;
      })}
      {[0, 1, 2, 3].map(index => <line key={index} x1={AUTH_X} x2={LAYER_X + LAYER_W + 2} y1={y(index) + ROW_H / 2} y2={y(index) + ROW_H / 2} className="faArchArrow dashed" markerEnd="url(#faArrow)" />)}
    </g>
  </svg>;
}
