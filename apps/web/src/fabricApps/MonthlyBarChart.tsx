import { useState } from "react";
import { formatCompact, formatMoney, type MonthBar } from "./forecastLogic";

// Categorical slots 1-2 of the validated default palette (blue, orange). Text never uses them.
const FORECAST = "#2a78d6";
const ACTUAL = "#eb6834";

const W = 760;
const H = 250;
const PAD = { top: 12, right: 8, bottom: 26, left: 46 };

function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export default function MonthlyBarChart({ bars, highlightMonth }: { bars: MonthBar[]; highlightMonth?: string | null }) {
  const [hover, setHover] = useState<string | null>(null);
  if (!bars.length) return <div className="faEmpty">Gold is not built yet. Save a forecast or press “Rebuild Gold”.</div>;
  const max = Math.max(...bars.flatMap(b => [b.forecast, b.actual ?? 0])) * 1.08 || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / bars.length;
  const barW = Math.min(18, (slot - 10) / 2);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => t * max);
  const hovered = bars.find(b => b.month === hover);

  return <div className="faChart">
    <div className="faLegend" aria-hidden="true">
      <span><i style={{ background: FORECAST }} />Forecast</span>
      <span><i style={{ background: ACTUAL }} />Actual</span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly forecast and actual sales from Gold">
      {ticks.map(t => <g key={t}>
        <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="faGrid" />
        <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="faAxis">{formatCompact(t)}</text>
      </g>)}
      {bars.map((bar, index) => {
        const x0 = PAD.left + index * slot + (slot - (barW * 2 + 2)) / 2;
        const active = hover === bar.month;
        return <g key={bar.month} data-month={bar.month}
          onMouseEnter={() => setHover(bar.month)} onMouseLeave={() => setHover(null)}>
          <rect x={PAD.left + index * slot} y={PAD.top} width={slot} height={innerH} className={active ? "faHit active" : "faHit"} />
          {highlightMonth === bar.month && <rect x={PAD.left + index * slot + 2} y={PAD.top} width={slot - 4} height={innerH} className="faEdited" />}
          <path d={barPath(x0, y(bar.forecast), barW, y(0) - y(bar.forecast))} fill={FORECAST} />
          {bar.actual !== null && <path d={barPath(x0 + barW + 2, y(bar.actual), barW, y(0) - y(bar.actual))} fill={ACTUAL} />}
          <text x={PAD.left + index * slot + slot / 2} y={H - 8} textAnchor="middle" className="faAxis">{bar.month.slice(5)}</text>
        </g>;
      })}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="faBaseline" />
    </svg>
    <div className="faTooltip" aria-live="polite">
      {hovered ? <>
        <b>{hovered.month}</b> · Forecast {formatMoney(hovered.forecast)} · Actual {formatMoney(hovered.actual)}
        {hovered.actual !== null && <> · Variance {formatMoney(hovered.actual - hovered.forecast)}</>}
      </> : <span className="muted">Hover a month for values. Months with no Actual bar are not closed yet.</span>}
    </div>
  </div>;
}
