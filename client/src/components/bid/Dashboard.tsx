import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Crosshair,
  FileText,
  FolderKanban,
  Plus,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { readiness, type Workspace } from "@shared/bid";
import { Empty, PageHead, PanelTitle, Progress, Status, TypeBadge } from "./ui";

export const money = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
export const compactMoney = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
export function dateLabel(s: string) {
  return s
    ? new Date(s + "T12:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "Not set";
}

export default function Dashboard({
  workspaces,
  demo,
  onCreate,
  search,
}: {
  workspaces: Workspace[];
  demo: boolean;
  onCreate: () => void;
  search: string;
}) {
  const filtered = workspaces.filter(w =>
    `${w.data.name} ${w.data.customer}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );
  const all = workspaces.flatMap(w => w.data.requirements);
  const approved = all.filter(r => r.status === "Approved").length;
  const coverage = all.length ? Math.round((approved / all.length) * 100) : 0;
  const gaps = all.filter(r => r.status === "Missing").length;
  const milestones = workspaces
    .flatMap(w =>
      w.data.milestones.filter(m => !m.done).map(m => ({ ...m, workspace: w }))
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);
  return (
    <>
      <PageHead
        eyebrow="YOUR CAPTURE COMMAND CENTER"
        title="Every pursuit. A stronger position."
        description="Turn complex solicitations into clear, compliant, winning responses."
        action={
          <button className="button primary" onClick={onCreate}>
            <Plus size={17} />
            New pursuit
          </button>
        }
      />
      {demo && (
        <div className="sample-banner">
          <span>
            <span className="pulse-dot" /> You’re exploring a sample workspace.
            All opportunities and evidence are illustrative.
          </span>
          <button onClick={onCreate}>
            Make it yours <ArrowRight size={14} />
          </button>
        </div>
      )}
      <section className="metrics">
        <div className="metric">
          <div className="metric-top">
            <span>Active pursuits</span>
            <FolderKanban size={18} />
          </div>
          <div className="metric-value">
            {workspaces.filter(w => w.data.stage !== "Submitted").length}
            <span className="metric-tag">IN MOTION</span>
          </div>
          <div className="metric-note">Across RFPs, RFIs & sources sought</div>
          <div className="metric-spark">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="metric">
          <div className="metric-top">
            <span>Pipeline value</span>
            <Crosshair size={18} />
          </div>
          <div className="metric-value">
            {compactMoney(workspaces.reduce((s, w) => s + w.data.value, 0))}
          </div>
          <div className="metric-note">
            <span className="green">Potential contract value</span> · Not
            awarded
          </div>
        </div>
        <div className="metric">
          <div className="metric-top">
            <span>Approved coverage</span>
            <ShieldCheck size={18} />
          </div>
          <div className="metric-value">
            {coverage}
            <span className="metric-unit">%</span>
          </div>
          <div className="metric-note">
            {approved} of {all.length} requirements approved
          </div>
          <div className="metric-progress">
            <i style={{ width: `${coverage}%` }} />
          </div>
        </div>
        <div className="metric">
          <div className="metric-top">
            <span>Needs attention</span>
            <TriangleAlert size={18} className="amber" />
          </div>
          <div className="metric-value">
            {gaps}
            <span className="metric-tag amber-tag">COMPLIANCE GAPS</span>
          </div>
          <div className="metric-note">
            Missing evidence or response coverage
          </div>
        </div>
      </section>
      <div className="dashboard-columns">
        <div className="dashboard-primary">
          <section className="panel pursuit-panel">
            <PanelTitle
              title="Active pursuits"
              subtitle="Your next wins, in progress."
              action={
                <Link href="/pursuits" className="text-link">
                  View all pursuits <ArrowUpRight size={14} />
                </Link>
              }
            />
            <div className="table-scroll">
              <table className="pursuit-table">
                <thead>
                  <tr>
                    <th>OPPORTUNITY</th>
                    <th>STATUS</th>
                    <th>COMPLIANCE</th>
                    <th>DUE DATE</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 4).map(w => (
                    <tr key={w.id}>
                      <td>
                        <Link
                          href={`/pursuits/${w.id}`}
                          className="opportunity-cell"
                        >
                          <span className="opportunity-icon">
                            <FileText size={19} />
                          </span>
                          <span>
                            <strong>{w.data.name}</strong>
                            <small>
                              {w.data.customer || "Customer not set"} <i />{" "}
                              <TypeBadge value={w.data.type} />
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <Status value={w.data.stage} />
                      </td>
                      <td>
                        <Progress value={readiness(w.data).coverage} />
                      </td>
                      <td>
                        <span className="due-date">
                          <Clock3 size={13} />
                          {dateLabel(w.data.dueDate)}
                        </span>
                      </td>
                      <td>
                        <Link
                          href={`/pursuits/${w.id}`}
                          className="row-arrow"
                          aria-label={`Open ${w.data.name}`}
                        >
                          <ChevronRight size={17} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <Empty
                title="Your next pursuit starts here"
                text="Import a solicitation to build its compliance matrix and response workspace."
                action={
                  <button className="button secondary" onClick={onCreate}>
                    <Plus size={15} />
                    Create pursuit
                  </button>
                }
              />
            )}
            <div className="table-footer">
              <span>
                <span className="pulse-dot" />
                {filtered.length} pursuits in your workspace
              </span>
              <span>Built for the entire capture lifecycle</span>
            </div>
          </section>
          <section className="intelligence-panel">
            <div className="intelligence-symbol">
              <Sparkles size={23} />
            </div>
            <div>
              <span className="eyebrow">FROM REQUIREMENTS TO RESPONSE</span>
              <h3>Your next draft starts with better intelligence.</h3>
              <p>
                Extract the requirements. Find the gaps. Build a response
                <br className="desktop-break" /> that can stand behind every
                claim.
              </p>
              <button className="button subtle" onClick={onCreate}>
                Analyze a solicitation <ArrowRight size={16} />
              </button>
            </div>
            <div className="intelligence-visual" aria-hidden="true">
              <div className="scan-orbit orbit-one" />
              <div className="scan-orbit orbit-two" />
              <div className="scan-center">
                <ShieldCheck size={32} />
              </div>
              <span className="scan-point point-one">
                <Check size={12} />
              </span>
              <span className="scan-point point-two">
                <FileText size={13} />
              </span>
              <span className="scan-point point-three">
                <Check size={12} />
              </span>
            </div>
          </section>
          <section className="panel activity-panel">
            <PanelTitle
              title="Recent activity"
              action={
                <Link href="/reviews" className="text-link">
                  Review workspace <ArrowUpRight size={14} />
                </Link>
              }
            />
            {workspaces
              .flatMap(w =>
                w.data.activity.map(a => ({
                  ...a,
                  name: w.data.name,
                  id: w.id + a.id,
                }))
              )
              .sort((a, b) => b.at.localeCompare(a.at))
              .slice(0, 3)
              .map((a, i) => (
                <div className="activity-row" key={a.id}>
                  <span className={`activity-icon ${i === 0 ? "mint" : ""}`}>
                    {i === 0 ? (
                      <CheckCheck size={16} />
                    ) : (
                      <FileText size={16} />
                    )}
                  </span>
                  <div>
                    <strong>{a.message}</strong>
                    <small>{a.name}</small>
                  </div>
                  <time>
                    {new Date(a.at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </div>
              ))}
            {!workspaces.some(w => w.data.activity.length) && (
              <p className="subtle-text activity-empty">
                Analysis, edits and approvals will appear here.
              </p>
            )}
          </section>
        </div>
        <aside className="dashboard-secondary">
          <section className="panel deadlines-panel">
            <PanelTitle
              title="On the horizon"
              subtitle="Keep the critical dates in sight."
              action={<Clock3 size={17} className="subtle-text" />}
            />
            {milestones.map((m, i) => (
              <Link
                href={`/pursuits/${m.workspace.id}`}
                key={m.id}
                className="deadline-row"
              >
                <span
                  className={`date-tile ${i === 0 ? "date-highlight" : ""}`}
                >
                  <small>
                    {new Date(m.date + "T12:00:00")
                      .toLocaleDateString("en-US", { month: "short" })
                      .toUpperCase()}
                  </small>
                  <strong>{new Date(m.date + "T12:00:00").getDate()}</strong>
                </span>
                <span>
                  <strong>{m.title}</strong>
                  <small>{m.workspace.data.customer}</small>
                  {i === 0 && (
                    <span className="upcoming-badge">NEXT MILESTONE</span>
                  )}
                </span>
                <ChevronRight size={15} />
              </Link>
            ))}
            {!milestones.length && (
              <p className="subtle-text">Add milestones inside a pursuit.</p>
            )}
            <Link href="/settings" className="deadline-footer">
              Configure deadline watch <ArrowRight size={14} />
            </Link>
          </section>
          <section className="panel attention-panel">
            <div className="attention-heading">
              <TriangleAlert size={17} />
              <h3>Close the gaps</h3>
              <span>{gaps}</span>
            </div>
            <p>A stronger submission starts here.</p>
            {workspaces
              .flatMap(w =>
                w.data.requirements
                  .filter(r => r.status === "Missing")
                  .map(r => ({ ...r, w }))
              )
              .slice(0, 2)
              .map(r => (
                <Link href="/compliance" className="gap-item" key={r.id}>
                  <span className="gap-dot" />
                  <div>
                    <strong>{r.text}</strong>
                    <small>
                      {r.w.data.customer} · {r.id}
                    </small>
                    <span>
                      Evidence needed <ArrowUpRight size={12} />
                    </span>
                  </div>
                </Link>
              ))}
            {gaps === 0 && (
              <div className="gap-item">
                <ShieldCheck size={18} className="green" />
                <p>No missing requirements flagged.</p>
              </div>
            )}
            <Link href="/compliance" className="text-link">
              Open compliance matrix <ArrowRight size={14} />
            </Link>
          </section>
          <div className="workflow-mini">
            <span className="eyebrow">THE BIDFORGE WAY</span>
            <h3>
              Clarity. Confidence.
              <br />A competitive edge.
            </h3>
            <div>
              <span>01</span>Analyze the opportunity
            </div>
            <div>
              <span>02</span>Build a grounded response
            </div>
            <div>
              <span>03</span>Find your winning position
            </div>
            <span className="mini-end">Intelligence, with human judgment.</span>
          </div>
        </aside>
      </div>
    </>
  );
}
