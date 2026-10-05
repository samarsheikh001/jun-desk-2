import { useEffect, useState } from "react";
import { formatDuration, MAX_METRIC_CONVERSATIONS, METRIC_PERIODS, type DayPoint, type MetricPeriod, type MetricsReport } from "../../shared/metrics.ts";
import { api, describeError } from "../api.ts";
import { navigate } from "../lib/router.ts";

// A-01: core metrics. Days are calendar days in the browser's time zone; the Worker
// aggregates and shared/metrics.ts defines every number (see docs/features.md A-01).

const timezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const percent = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
const duration = (ms: number | null) => (ms === null ? "–" : formatDuration(ms));
const dayLabel = (key: string, weekday = false) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", ...(weekday ? { weekday: "short" } : {}) });

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="muted small">{detail}</div>
    </div>
  );
}

/** Conversations per day, stacked: resolved by the AI alone at the bottom, the rest above. */
function DayChart({ series }: { series: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.conversations));
  const width = 100 / series.length;
  const gap = series.length > 40 ? 0.15 : 0.6; // % of the width between bars
  const point = series[hover ?? -1];
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  return (
    <div className="chart">
      <div className="chart-caption small">
        {point ? (
          <>
            <span className="strong">{dayLabel(point.day, true)}</span>: {point.conversations} conversation{point.conversations === 1 ? "" : "s"}, {point.aiResolved} resolved by the AI
          </>
        ) : (
          <span className="muted">Hover or tap a day for its numbers.</span>
        )}
      </div>
      <div className="chart-plot">
        <span className="chart-max muted small">{max}</span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Conversations per day" onMouseLeave={() => setHover(null)}>
          <line x1="0" x2="100" y1="0" y2="0" className="chart-grid" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2="100" y1="100" y2="100" className="chart-base" vectorEffect="non-scaling-stroke" />
          {series.map((d, i) => {
            const total = (d.conversations / max) * 100;
            const ai = (d.aiResolved / max) * 100;
            const x = i * width + gap / 2;
            const w = Math.max(width - gap, 0.2);
            return (
              <g key={d.day} className={hover === i ? "on" : ""} onMouseEnter={() => setHover(i)}>
                {/* Taller than the bar, so short days are easy to hover. */}
                <rect x={i * width} width={width} y={0} height={100} className="chart-hit" />
                {total > ai && <rect x={x} width={w} y={100 - total} height={total - ai - (ai > 0 ? 1.5 : 0)} className="bar-rest" />}
                {ai > 0 && <rect x={x} width={w} y={100 - ai} height={ai} className="bar-ai" />}
                <title>{`${dayLabel(d.day)}: ${d.conversations} conversations, ${d.aiResolved} resolved by the AI`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-axis muted small">
        {ticks.filter((t, i) => ticks.indexOf(t) === i).map((t) => (
          <span key={t} style={{ left: `${(t + 0.5) * width}%` }}>{dayLabel(series[t]!.day)}</span>
        ))}
      </div>
      <div className="legend small">
        <span><i className="swatch bar-ai" /> Resolved by the AI</span>
        <span><i className="swatch bar-rest" /> Everything else</span>
      </div>
    </div>
  );
}

export function ReportsPage({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<MetricPeriod>(7);
  const [report, setReport] = useState<MetricsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api<{ report: MetricsReport }>(`/workspaces/${workspaceId}/metrics?days=${days}&tz=${encodeURIComponent(timezone)}`).then(
      (r) => current && setReport(r.report),
      (e) => current && setError(describeError(e)),
    );
    return () => {
      current = false;
    };
  }, [workspaceId, days]);

  const r = report?.days === days ? report : null;
  const empty = r && r.conversations.total === 0 && r.csat.good + r.csat.bad === 0;

  return (
    <div className="content wide reports">
      <div className="row reports-head">
        <h2>Reports</h2>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Period">
          {METRIC_PERIODS.map((p) => (
            <button key={p} className={p === days ? "active" : ""} aria-pressed={p === days} onClick={() => setDays(p)}>{p} days</button>
          ))}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!r ? (
        !error && <p className="muted">Loading…</p>
      ) : empty ? (
        <section className="panel">
          <p className="muted">No conversations in the last {days} days. Numbers show up here once visitors start chatting.</p>
        </section>
      ) : (
        <>
          {r.truncated && <p className="muted small">Based on the newest {MAX_METRIC_CONVERSATIONS.toLocaleString()} conversations in this period.</p>}
          <div className="stats">
            <Stat label="Conversations" value={r.conversations.total.toLocaleString()} detail={`${r.conversations.resolved} resolved`} />
            <Stat label="AI resolved" value={percent(r.ai.resolutionRate)} detail={`${r.ai.resolved} of ${r.ai.conversations} AI chats`} />
            <Stat label="Handed off" value={percent(r.ai.handoffRate)} detail={`${r.ai.handedOff} of ${r.ai.conversations} AI chats`} />
            <Stat
              label="First response"
              value={duration(r.team.firstResponse.median)}
              detail={r.team.firstResponse.p90 === null ? "No team replies yet" : `90% within ${duration(r.team.firstResponse.p90)}`}
            />
            <Stat label="CSAT" value={percent(r.csat.score)} detail={`👍 ${r.csat.good} · 👎 ${r.csat.bad}`} />
          </div>
          <p className="muted small reports-note">
            First response is the median time from a visitor's first message to the team's first reply.
            {r.ai.firstResponse.median !== null && ` The AI's first answer takes ${duration(r.ai.firstResponse.median)} (median).`}
          </p>

          <section className="panel">
            <h2>Conversations per day</h2>
            <DayChart series={r.conversations.series} />
          </section>

          <div className="reports-grid">
            <section className="panel">
              <h2>Top handoff reasons</h2>
              {r.ai.reasons.length === 0 ? (
                <p className="muted small">No handoffs in this period.</p>
              ) : (
                <ul className="reasons">
                  {r.ai.reasons.map((x) => (
                    <li key={x.reason}>
                      <div className="row">
                        <span className="reason-text">{x.reason}</span>
                        <span className="muted small">{x.count}</span>
                      </div>
                      <div className="meter"><span style={{ width: `${(x.count / r.ai.reasons[0]!.count) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel">
              <h2>Recent 👎 comments</h2>
              {r.csat.badComments.length === 0 ? (
                <p className="muted small">No comments on bad ratings in this period.</p>
              ) : (
                <ul className="bad-comments">
                  {r.csat.badComments.map((x) => (
                    <li key={`${x.conversationId}:${x.createdAt}`}>
                      <a href={`/inbox/${x.conversationId}`} onClick={(e) => { e.preventDefault(); navigate(`/inbox/${x.conversationId}`); }}>
                        <span className="bad-comment">“{x.comment}”</span>
                        <span className="muted small">{new Date(x.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel">
            <h2>Team</h2>
            <table className="team-table">
              <thead>
                <tr>
                  <th>Teammate</th>
                  <th>Replies</th>
                  <th>Conversations</th>
                  <th>First response</th>
                </tr>
              </thead>
              <tbody>
                {r.teammates.map((t) => (
                  <tr key={t.userId}>
                    <td className="strong">{t.name}</td>
                    <td data-label="Replies">{t.replies}</td>
                    <td data-label="Conversations">{t.conversations}</td>
                    <td data-label="First response">{duration(t.firstResponse.median)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Replies the teammate sent in this period (not notes), the conversations they replied in, and their median first response when they answered first.</p>
          </section>
        </>
      )}
    </div>
  );
}
