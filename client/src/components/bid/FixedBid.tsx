import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import type { Workspace } from "@shared/bid";
import {
  BASELINE_STRESS,
  baselineSchema,
  calculateErosion,
  exampleBaseline,
  stressSchema,
  uniformStress,
  type BidBaseline,
  type CostStress,
} from "@shared/erosion";
import { PanelTitle } from "./ui";
import "./fixed-bid.css";

export function FixedBid({
  workspace,
  demo,
}: {
  workspace: Workspace;
  demo: boolean;
}) {
  const utils = trpc.useUtils();
  const list = trpc.erosion.list.useQuery(
    { workspaceId: workspace.id },
    { enabled: !demo, retry: false }
  );
  const [selected, setSelected] = useState("");
  const saved = trpc.erosion.get.useQuery(
    { workspaceId: workspace.id, baselineId: selected },
    { enabled: !demo && !!selected, retry: false }
  );
  const create = trpc.erosion.create.useMutation();
  const revise = trpc.erosion.revise.useMutation();
  const saveCase = trpc.erosion.saveCase.useMutation();
  const [draft, setDraft] = useState<BidBaseline>(exampleBaseline),
    [locked, setLocked] = useState<BidBaseline | null>(
      demo ? exampleBaseline : null
    );
  const [stress, setStress] = useState<CostStress>(uniformStress(10)),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(false);
  const createRequest = useRef<{ payload: string; key: string } | null>(null),
    caseRequest = useRef<{ payload: string; key: string } | null>(null);
  const [sampleCases, setSampleCases] = useState<CostStress[]>([]);
  const requestKey = (ref: typeof createRequest, payload: unknown) => {
    const text = JSON.stringify(payload);
    if (ref.current?.payload !== text)
      ref.current = { payload: text, key: crypto.randomUUID() };
    return ref.current!.key;
  };
  useEffect(() => {
    setSelected("");
    setLocked(demo ? exampleBaseline : null);
    setRevision(false);
    setReason("");
    setSampleCases([]);
    setError("");
    const scenario = workspace.data.scenarios[0];
    const initial = scenario
      ? {
          ...exampleBaseline,
          name: scenario.name + " locked bid",
          labor: scenario.labor.toFixed(2),
          other: scenario.other.toFixed(2),
          overheadBps: Math.round(scenario.overhead * 100),
          bidPrice: (
            ((scenario.labor + scenario.other) *
              (1 + scenario.overhead / 100)) /
            (1 - scenario.margin / 100)
          ).toFixed(2),
          assumptions: scenario.assumptions || exampleBaseline.assumptions,
        }
      : exampleBaseline;
    setDraft(initial);
    if (demo) setLocked(initial);
  }, [workspace.id, demo]);
  useEffect(() => {
    if (list.data?.length && !selected) setSelected(list.data[0].id);
  }, [list.data, selected]);
  useEffect(() => {
    if (saved.data) {
      const row = saved.data.baseline;
      const b: BidBaseline = {
        name: row.name,
        bidPrice: row.bidPrice,
        labor: row.labor,
        other: row.other,
        overheadBps: row.overheadBps,
        minimumMarginBps: row.minimumMarginBps,
        currency: row.currency as BidBaseline["currency"],
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        assumptions: row.assumptions,
      };
      setLocked(b);
      setDraft(b);
      setRevision(false);
      setReason("");
    }
  }, [saved.data]);
  const busy = create.isPending || revise.isPending || saveCase.isPending;
  const canWrite = workspace.role !== "reviewer";
  const output = (() => {
    if (!locked) return null;
    try {
      return { result: calculateErosion(locked, stress), error: "" };
    } catch (e) {
      return {
        result: null,
        error: e instanceof Error ? e.message : "Invalid inputs.",
      };
    }
  })();
  const values = locked
    ? [-10, 0, 5, 10, 20, 25].map(p => ({
        stress: uniformStress(p),
        result: calculateErosion(locked, uniformStress(p)),
      }))
    : [];
  const format = (v: string) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: locked?.currency || draft.currency,
      maximumFractionDigits: 2,
    }).format(Number(v));
  const field = <K extends keyof BidBaseline>(key: K, value: BidBaseline[K]) =>
    setDraft(prev => ({ ...prev, [key]: value }));
  async function lock() {
    setError("");
    try {
      const b = baselineSchema.parse(draft);
      if (revision && !reason.trim())
        throw new Error("Enter a revision reason.");
      if (demo) {
        setLocked(b);
        setRevision(false);
        toast.info(
          "Sample baseline locked locally; no database record created."
        );
        return;
      }
      const base = { workspaceId: workspace.id, baseline: b };
      const payload = revision
        ? { ...base, previousId: selected, reason }
        : base;
      const key = requestKey(createRequest, payload);
      const row = revision
        ? await revise.mutateAsync({
            ...base,
            previousId: selected,
            reason,
            requestKey: key,
          })
        : await create.mutateAsync({ ...base, requestKey: key });
      setSelected(row.id);
      setLocked(b);
      setRevision(false);
      createRequest.current = null;
      await utils.erosion.list.invalidate({ workspaceId: workspace.id });
      await utils.erosion.get.invalidate();
      toast.success("Immutable baseline recorded. Fixed bid price is locked.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Baseline save failed.");
    }
  }
  async function persistCase() {
    setError("");
    try {
      if (!locked) throw new Error("Lock a baseline first.");
      const s = stressSchema.parse(stress);
      calculateErosion(locked, s);
      if (demo) {
        setSampleCases(prev => [s, ...prev]);
        toast.info("Sample case saved locally only.");
        return;
      }
      if (!selected) throw new Error("Select a saved baseline.");
      const payload = {
        workspaceId: workspace.id,
        baselineId: selected,
        stress: s,
      };
      await saveCase.mutateAsync({
        ...payload,
        requestKey: requestKey(caseRequest, payload),
      });
      caseRequest.current = null;
      await utils.erosion.get.invalidate({
        workspaceId: workspace.id,
        baselineId: selected,
      });
      toast.success("Stress case and audit event saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Case save failed.");
    }
  }
  async function exportCases() {
    try {
      let content: string;
      if (demo) {
        content =
          "Case,Fixed bid,Stressed cost,Profit,Margin percent\r\n" +
          [BASELINE_STRESS, ...sampleCases]
            .map(s => {
              const r = calculateErosion(locked!, s);
              return [
                '"' +
                  (/^[\s]*[=+@-]/.test(s.name)
                    ? "'" + s.name
                    : s.name
                  ).replaceAll('"', '""') +
                  '"',
                r.bidPrice,
                r.stressedCost,
                r.profit,
                r.realizedMarginPercent,
              ].join(",");
            })
            .join("\r\n");
      } else
        content = (
          await utils.erosion.export.fetch({
            workspaceId: workspace.id,
            baselineId: selected,
          })
        ).content;
      const url = URL.createObjectURL(
        new Blob([content], { type: "text/csv;charset=utf-8" })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = demo ? "sample-fixed-bid.csv" : `fixed-bid-${selected}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    }
  }
  const showForm = !locked || revision;
  return (
    <div className="fb-root">
      <div className="pricing-notice">
        <strong>
          {demo
            ? "Sample calculator — local changes only."
            : "Immutable baseline and case history."}
        </strong>
        <span>Fixed-price risk modeling does not submit or modify a bid.</span>
      </div>
      {(error || list.error || saved.error) && (
        <div className="error-banner" role="alert">
          {error || list.error?.message || saved.error?.message}
          {list.error && <button onClick={() => list.refetch()}>Retry</button>}
        </div>
      )}
      {!demo && list.isLoading && (
        <p role="status">Loading fixed-bid baselines…</p>
      )}
      {!demo && !!list.data?.length && (
        <label className="field fb-select">
          Saved baseline revision
          <select
            value={selected}
            onChange={e => {
              setSelected(e.target.value);
              setRevision(false);
            }}
          >
            {list.data.map(b => (
              <option key={b.id} value={b.id}>
                {b.name} · revision {b.revision} · {b.currency} {b.bidPrice}
              </option>
            ))}
          </select>
        </label>
      )}
      {showForm ? (
        <section className="panel fb-form">
          <PanelTitle
            title={
              revision
                ? "Create a new immutable revision"
                : "Lock a fixed-bid baseline"
            }
            subtitle="All revenue and costs must cover the same scope and performance period."
          />
          <div className="form-row">
            <label className="field">
              Baseline name
              <input
                value={draft.name}
                onChange={e => field("name", e.target.value)}
              />
            </label>
            <label className="field">
              Fixed bid amount
              <input
                inputMode="decimal"
                value={draft.bidPrice}
                onChange={e => field("bidPrice", e.target.value)}
              />
            </label>
            <label className="field">
              Currency
              <select
                value={draft.currency}
                onChange={e =>
                  field("currency", e.target.value as BidBaseline["currency"])
                }
              >
                {["USD", "EUR", "GBP", "CAD", "AUD"].map(v => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              Baseline labor
              <input
                inputMode="decimal"
                value={draft.labor}
                onChange={e => field("labor", e.target.value)}
              />
            </label>
            <label className="field">
              Baseline other costs
              <input
                inputMode="decimal"
                value={draft.other}
                onChange={e => field("other", e.target.value)}
              />
            </label>
            <label className="field">
              Overhead %
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={draft.overheadBps / 100}
                onChange={e =>
                  field("overheadBps", Math.round(Number(e.target.value) * 100))
                }
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              Minimum margin %
              <input
                type="number"
                min="0"
                max="95"
                step="0.01"
                value={draft.minimumMarginBps / 100}
                onChange={e =>
                  field(
                    "minimumMarginBps",
                    Math.round(Number(e.target.value) * 100)
                  )
                }
              />
            </label>
            <label className="field">
              Period start
              <input
                type="date"
                value={draft.periodStart}
                onChange={e => field("periodStart", e.target.value)}
              />
            </label>
            <label className="field">
              Period end
              <input
                type="date"
                value={draft.periodEnd}
                onChange={e => field("periodEnd", e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            Scope and cost assumptions
            <textarea
              value={draft.assumptions}
              onChange={e => field("assumptions", e.target.value)}
            />
          </label>
          {revision && (
            <label className="field">
              Revision reason
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </label>
          )}
          <div className="button-row">
            <button
              className="button primary"
              disabled={busy || !canWrite}
              onClick={lock}
            >
              {busy ? "Saving…" : "Lock bid baseline"}
            </button>
            {revision && (
              <button
                className="button secondary"
                onClick={() => setRevision(false)}
              >
                Cancel revision
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="panel fb-locked">
          <PanelTitle
            title={locked.name}
            subtitle={`Locked ${locked.currency} bid · ${locked.periodStart} through ${locked.periodEnd}`}
            action={
              <div className="button-row">
                <button
                  className="button secondary"
                  disabled={!canWrite}
                  onClick={() => setRevision(true)}
                >
                  New revision
                </button>
                <button
                  className="button secondary"
                  onClick={exportCases}
                  disabled={!locked}
                >
                  Export cases CSV
                </button>
              </div>
            }
          />
          <div className="fb-lock-amount">
            {format(locked.bidPrice)}
            <span>Fixed revenue — cost stresses never change this amount.</span>
          </div>
          <p className="subtle-text">{locked.assumptions}</p>
        </section>
      )}
      {locked && !revision && (
        <>
          <section className="panel fb-form">
            <PanelTitle
              title="Custom cost stress"
              subtitle="Independent changes; overhead shock is in percentage points. Extra cost is already fully burdened."
            />
            <div className="form-row">
              <label className="field">
                Case name
                <input
                  value={stress.name}
                  onChange={e => setStress({ ...stress, name: e.target.value })}
                />
              </label>
              <label className="field">
                Labor change %
                <input
                  type="number"
                  min="-100"
                  max="1000"
                  step="0.01"
                  value={stress.laborChangeBps / 100}
                  onChange={e =>
                    setStress({
                      ...stress,
                      laborChangeBps: Math.round(Number(e.target.value) * 100),
                    })
                  }
                />
              </label>
              <label className="field">
                Other cost change %
                <input
                  type="number"
                  min="-100"
                  max="1000"
                  step="0.01"
                  value={stress.otherChangeBps / 100}
                  onChange={e =>
                    setStress({
                      ...stress,
                      otherChangeBps: Math.round(Number(e.target.value) * 100),
                    })
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label className="field">
                Overhead change (points)
                <input
                  type="number"
                  min="-100"
                  max="100"
                  step="0.01"
                  value={stress.overheadChangeBps / 100}
                  onChange={e =>
                    setStress({
                      ...stress,
                      overheadChangeBps: Math.round(
                        Number(e.target.value) * 100
                      ),
                    })
                  }
                />
              </label>
              <label className="field">
                Extra fully burdened cost
                <input
                  inputMode="decimal"
                  value={stress.extraCost}
                  onChange={e =>
                    setStress({ ...stress, extraCost: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="field">
              Case rationale
              <textarea
                value={stress.rationale}
                onChange={e =>
                  setStress({ ...stress, rationale: e.target.value })
                }
              />
            </label>
            {output?.error && (
              <p role="alert" className="amber">
                {output.error}
              </p>
            )}
            {output?.result && (
              <div className="fb-output" aria-live="polite">
                <div>
                  <span>Remaining profit</span>
                  <strong>{format(output.result.profit)}</strong>
                </div>
                <div>
                  <span>Realized margin</span>
                  <strong>
                    {Number(output.result.realizedMarginPercent).toFixed(2)}%
                  </strong>
                </div>
                <div>
                  <span>Profit erosion</span>
                  <strong>{format(output.result.profitErosion)}</strong>
                </div>
                <div>
                  <span>Margin-floor headroom</span>
                  <strong>{format(output.result.minimumMarginHeadroom)}</strong>
                </div>
                <p
                  className={
                    output.result.status === "WITHIN_FLOOR" ? "green" : "amber"
                  }
                >
                  {output.result.status.replaceAll("_", " ")} ·{" "}
                  {output.result.profitErosionPercent === null
                    ? "Profit erosion percentage is undefined for a zero/loss baseline."
                    : `${Number(output.result.profitErosionPercent).toFixed(2)}% of baseline profit eroded.`}
                </p>
              </div>
            )}
            <button
              className="button primary"
              onClick={persistCase}
              disabled={busy || !canWrite || !output?.result}
            >
              {busy ? "Saving…" : "Save stress case"}
            </button>
          </section>
          <section className="panel">
            <PanelTitle
              title="Fixed-price sensitivity"
              subtitle="Labor and other costs move together. Price and overhead remain unchanged."
            />
            <div className="table-scroll">
              <table className="sensitivity-table">
                <thead>
                  <tr>
                    <th>Cost case</th>
                    <th>Fixed price</th>
                    <th>Stressed cost</th>
                    <th>Profit</th>
                    <th>Margin</th>
                    <th>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {values.map(({ stress: s, result: r }) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{format(r.bidPrice)}</td>
                      <td>{format(r.stressedCost)}</td>
                      <td>{format(r.profit)}</td>
                      <td>{Number(r.realizedMarginPercent).toFixed(2)}%</td>
                      <td
                        className={
                          r.status === "WITHIN_FLOOR" ? "green" : "amber"
                        }
                      >
                        {r.status.replaceAll("_", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <PanelTitle
              title="Saved stress cases"
              subtitle={
                demo
                  ? "Session-only sample cases."
                  : "Immutable cases attached to the selected baseline revision."
              }
            />
            {demo
              ? sampleCases.map((s, i) => (
                  <p key={i}>
                    {s.name} · {format(calculateErosion(locked, s).profit)}{" "}
                    profit
                  </p>
                ))
              : saved.data?.cases.map(c => (
                  <div className="fb-history" key={c.id}>
                    <strong>{c.name}</strong>
                    <span>
                      {format(c.result.profit)} profit ·{" "}
                      {Number(c.result.realizedMarginPercent).toFixed(2)}%
                      margin
                    </span>
                    <small>{c.rationale}</small>
                  </div>
                ))}
            {!(demo ? sampleCases.length : saved.data?.cases.length) && (
              <p className="subtle-text">No cases saved yet.</p>
            )}
            {!demo && !!saved.data?.audit.length && (
              <details>
                <summary>Audit events ({saved.data.audit.length})</summary>
                {saved.data.audit.map(a => (
                  <p key={a.id}>
                    {a.createdAt} · {a.action} · actor {a.actorId} · {a.reason}
                  </p>
                ))}
              </details>
            )}
          </section>
        </>
      )}
    </div>
  );
}
export default FixedBid;
