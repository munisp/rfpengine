import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Calculator,
  CircleAlert,
  CopyPlus,
  Plus,
  Save,
  TrendingDown,
  TrendingUp,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  priceScenario,
  type PriceScenario,
  type Workspace,
  type WorkspaceData,
} from "@shared/bid";
import { PageHead, PanelTitle } from "./ui";
import FixedBid from "./FixedBid";

export type PricingProps = {
  workspace: Workspace;
  onChange: (data: WorkspaceData) => void;
  onSave: () => void;
  saving: boolean;
  demo: boolean;
};

type RemovedScenario = { scenario: PriceScenario; index: number };

const currency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);

const compactCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);

function localId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newScenario(source?: PriceScenario): PriceScenario {
  if (source) {
    return {
      ...source,
      id: localId(),
      name: `${source.name || "Scenario"} copy`,
    };
  }

  return {
    id: localId(),
    name: "New scenario",
    labor: 0,
    other: 0,
    overhead: 0,
    margin: 0,
    competitorLow: 0,
    competitorHigh: 0,
    rationale: "",
    assumptions: "",
  };
}

function numberValue(raw: string, min: number, max?: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, parsed));
}

export function Pricing({
  workspace,
  onChange,
  onSave,
  saving,
  demo,
}: PricingProps) {
  const [mode, setMode] = useState("target");
  const [scenarios, setScenarios] = useState<PriceScenario[]>(
    workspace.data.scenarios
  );
  const [activeId, setActiveId] = useState<string>(
    workspace.data.scenarios[0]?.id ?? ""
  );
  const [removedScenarios, setRemovedScenarios] = useState<RemovedScenario[]>(
    []
  );

  useEffect(() => {
    setScenarios(workspace.data.scenarios);
    setActiveId(workspace.data.scenarios[0]?.id ?? "");
    setRemovedScenarios([]);
  }, [workspace.id]);

  useEffect(() => {
    setScenarios(workspace.data.scenarios);
    setActiveId(id =>
      workspace.data.scenarios.some(scenario => scenario.id === id)
        ? id
        : (workspace.data.scenarios[0]?.id ?? "")
    );
  }, [workspace.version]);

  const activeScenario =
    scenarios.find(scenario => scenario.id === activeId) ?? scenarios[0];
  const activeTotals = activeScenario
    ? priceScenario(activeScenario)
    : undefined;

  const comparisonData = useMemo(
    () =>
      scenarios.map(scenario => {
        const totals = priceScenario(scenario);
        const marketLow = Math.min(
          scenario.competitorLow,
          scenario.competitorHigh
        );
        const marketHigh = Math.max(
          scenario.competitorLow,
          scenario.competitorHigh
        );
        return {
          name: scenario.name || "Untitled",
          price: Math.round(totals.price),
          marketLow: Math.round(marketLow),
          marketHigh: Math.round(marketHigh),
        };
      }),
    [scenarios]
  );

  const saveScenarios = (next: PriceScenario[]) => {
    setScenarios(next);
    onChange({ ...workspace.data, scenarios: next });
  };

  const updateScenario = <K extends keyof PriceScenario>(
    key: K,
    value: PriceScenario[K]
  ) => {
    if (!activeScenario) return;
    const next = scenarios.map(scenario =>
      scenario.id === activeScenario.id
        ? { ...scenario, [key]: value }
        : scenario
    );
    saveScenarios(next);
  };

  const addScenario = () => {
    const created = newScenario(activeScenario);
    saveScenarios([...scenarios, created]);
    setActiveId(created.id);
  };

  const removeScenario = () => {
    if (!activeScenario) return;
    const index = scenarios.findIndex(
      scenario => scenario.id === activeScenario.id
    );
    const next = scenarios.filter(
      scenario => scenario.id !== activeScenario.id
    );
    setRemovedScenarios(removed => [
      ...removed,
      { scenario: activeScenario, index },
    ]);
    saveScenarios(next);
    setActiveId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "");
  };

  const undoRemove = () => {
    const mostRecent = removedScenarios.at(-1);
    if (!mostRecent) return;
    const next = [...scenarios];
    next.splice(
      Math.min(mostRecent.index, next.length),
      0,
      mostRecent.scenario
    );
    saveScenarios(next);
    setActiveId(mostRecent.scenario.id);
    setRemovedScenarios(removed => removed.slice(0, -1));
  };

  const sensitivity = activeScenario
    ? [0.9, 1, 1.1].map(multiplier => {
        const estimate = priceScenario({
          ...activeScenario,
          labor: activeScenario.labor * multiplier,
          other: activeScenario.other * multiplier,
        });
        return { multiplier, estimate };
      })
    : [];

  if (mode === "fixed" || workspace.role === "reviewer")
    return (
      <>
        <div className="pricing-mode-switch">
          <button
            className="button secondary"
            onClick={() => setMode("target")}
            disabled={workspace.role === "reviewer"}
          >
            Target margin / required price
          </button>
          <button className="button primary" onClick={() => setMode("fixed")}>
            Fixed bid / profit erosion
          </button>
        </div>
        <PageHead
          eyebrow="DELIVERY RISK"
          title="Hold the bid. See the exposure."
          description="Lock revenue, stress costs, and see remaining profit and margin."
        />
        <FixedBid key={workspace.id} workspace={workspace} demo={demo} />
      </>
    );
  return (
    <>
      <div className="pricing-mode-switch">
        <button className="button primary" onClick={() => setMode("target")}>
          Target margin / required price
        </button>
        <button className="button secondary" onClick={() => setMode("fixed")}>
          Fixed bid / profit erosion
        </button>
      </div>
      <PageHead
        eyebrow="PRICE PLANNING"
        title="Build a defensible price position"
        description="Model direct costs, overhead, and gross margin transparently before the pricing review."
        action={
          <button
            className="button primary"
            type="button"
            onClick={onSave}
            disabled={saving}
          >
            <Save size={16} />
            {saving ? "Saving…" : "Save scenarios"}
          </button>
        }
      />

      <div className="pricing-notice" role="note">
        <CircleAlert size={17} />
        <p>
          <strong>Planning estimates only.</strong> Market competitor ranges are
          hypotheses, not observed bid data. They are not a bid forecast or a
          win probability.
        </p>
      </div>

      <section
        className="panel scenario-panel"
        aria-labelledby="scenario-heading"
      >
        <PanelTitle
          title="Pricing scenarios"
          subtitle="Work locally in this pursuit, then save when the assumptions are ready for review."
          action={
            <div className="scenario-actions">
              <button
                className="button secondary"
                type="button"
                onClick={addScenario}
              >
                <CopyPlus size={15} />
                Duplicate / add
              </button>
              {removedScenarios.length > 0 && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={undoRemove}
                >
                  <Undo2 size={15} />
                  Undo remove
                </button>
              )}
            </div>
          }
        />
        <div
          className="scenario-tabs"
          role="tablist"
          aria-label="Pricing scenarios"
        >
          {scenarios.map(scenario => (
            <button
              key={scenario.id}
              className={`scenario-tab ${scenario.id === activeScenario?.id ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={scenario.id === activeScenario?.id}
              onClick={() => setActiveId(scenario.id)}
            >
              <span>{scenario.name || "Untitled scenario"}</span>
              <small>{currency(priceScenario(scenario).price)}</small>
            </button>
          ))}
          <button
            className="scenario-tab add-scenario-tab"
            type="button"
            onClick={addScenario}
            aria-label="Add pricing scenario"
          >
            <Plus size={16} />
            Add scenario
          </button>
        </div>

        {!activeScenario && (
          <div className="pricing-empty-state">
            <Calculator size={24} />
            <div>
              <h3>No pricing scenarios yet</h3>
              <p>
                Create a local scenario to start documenting the price basis.
              </p>
            </div>
            <button
              className="button primary"
              type="button"
              onClick={addScenario}
            >
              <Plus size={16} />
              Create scenario
            </button>
          </div>
        )}

        {activeScenario && activeTotals && (
          <div className="pricing-layout">
            <form
              className="scenario-form"
              onSubmit={event => event.preventDefault()}
            >
              <div className="form-row">
                <label className="field">
                  <span>Scenario name</span>
                  <input
                    className="input"
                    value={activeScenario.name}
                    onChange={event =>
                      updateScenario("name", event.target.value)
                    }
                    placeholder="e.g. Balanced"
                  />
                </label>
              </div>

              <div className="form-row cost-fields">
                <label className="field">
                  <span>
                    Labor <small>Direct cost</small>
                  </span>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="1000"
                    value={activeScenario.labor}
                    onChange={event =>
                      updateScenario(
                        "labor",
                        numberValue(event.target.value, 0)
                      )
                    }
                  />
                </label>
                <label className="field">
                  <span>Other direct costs</span>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="1000"
                    value={activeScenario.other}
                    onChange={event =>
                      updateScenario(
                        "other",
                        numberValue(event.target.value, 0)
                      )
                    }
                  />
                </label>
              </div>

              <div className="form-row rate-fields">
                <label className="field">
                  <span>Overhead rate</span>
                  <div className="input-suffix">
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={activeScenario.overhead}
                      onChange={event =>
                        updateScenario(
                          "overhead",
                          numberValue(event.target.value, 0, 100)
                        )
                      }
                    />
                    <span>%</span>
                  </div>
                </label>
                <label className="field">
                  <span>Gross margin</span>
                  <div className="input-suffix">
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="95"
                      step="0.1"
                      value={activeScenario.margin}
                      onChange={event =>
                        updateScenario(
                          "margin",
                          numberValue(event.target.value, 0, 95)
                        )
                      }
                    />
                    <span>%</span>
                  </div>
                </label>
              </div>

              <div className="market-hypothesis">
                <div>
                  <span className="eyebrow">MARKET HYPOTHESIS</span>
                  <h3>Competitor planning range</h3>
                  <p>
                    This is a planning input only, not verified competitor bid
                    data.
                  </p>
                </div>
                <div className="form-row market-fields">
                  <label className="field">
                    <span>Low</span>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="1000"
                      value={activeScenario.competitorLow}
                      onChange={event =>
                        updateScenario(
                          "competitorLow",
                          numberValue(event.target.value, 0)
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    <span>High</span>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="1000"
                      value={activeScenario.competitorHigh}
                      onChange={event =>
                        updateScenario(
                          "competitorHigh",
                          numberValue(event.target.value, 0)
                        )
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="form-row narrative-fields">
                <label className="field">
                  <span>Rationale</span>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={activeScenario.rationale}
                    onChange={event =>
                      updateScenario("rationale", event.target.value)
                    }
                    placeholder="Explain the pricing position and trade-offs."
                  />
                </label>
                <label className="field">
                  <span>Assumptions and qualifications</span>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={activeScenario.assumptions}
                    onChange={event =>
                      updateScenario("assumptions", event.target.value)
                    }
                    placeholder="Document cost basis, term, exclusions, and evidence still needed."
                  />
                </label>
              </div>

              <div className="scenario-form-footer">
                <span>Changes remain in the workspace until saved.</span>
                <button
                  className="button secondary destructive"
                  type="button"
                  onClick={removeScenario}
                >
                  <Trash2 size={15} />
                  Remove locally
                </button>
              </div>
            </form>

            <aside
              className="price-summary"
              aria-label="Selected scenario price summary"
            >
              <span className="eyebrow">PRICE SUMMARY</span>
              <div className="price-total">
                <span>Indicative price</span>
                <strong>{currency(activeTotals.price)}</strong>
              </div>
              <dl className="price-breakdown">
                <div>
                  <dt>Direct costs</dt>
                  <dd>{currency(activeTotals.direct)}</dd>
                </div>
                <div>
                  <dt>Overhead ({activeScenario.overhead.toFixed(1)}%)</dt>
                  <dd>{currency(activeTotals.cost - activeTotals.direct)}</dd>
                </div>
                <div>
                  <dt>Cost base</dt>
                  <dd>{currency(activeTotals.cost)}</dd>
                </div>
                <div>
                  <dt>Gross margin ({activeScenario.margin.toFixed(1)}%)</dt>
                  <dd>{currency(activeTotals.profit)}</dd>
                </div>
              </dl>
              <div
                className={`market-position ${activeTotals.inRange ? "in-range" : "outside-range"}`}
              >
                <span>Market hypothesis</span>
                <strong>
                  {currency(
                    Math.min(
                      activeScenario.competitorLow,
                      activeScenario.competitorHigh
                    )
                  )}{" "}
                  –{" "}
                  {currency(
                    Math.max(
                      activeScenario.competitorLow,
                      activeScenario.competitorHigh
                    )
                  )}
                </strong>
                <small>
                  {activeTotals.inRange
                    ? "Indicative price falls inside this unverified planning range."
                    : "Indicative price falls outside this unverified planning range."}
                </small>
              </div>
              <p className="formula-note">
                Formula: (labor + other direct costs) × (1 + overhead) ÷ (1 −
                gross margin).
              </p>
            </aside>
          </div>
        )}
      </section>

      {activeScenario && (
        <div className="pricing-insights-grid">
          <section
            className="panel sensitivity-panel"
            aria-labelledby="sensitivity-heading"
          >
            <PanelTitle
              title="Cost sensitivity"
              subtitle="Price recalculated with direct costs at −10%, baseline, and +10%; overhead and margin remain unchanged."
            />
            <div className="sensitivity-table-wrap">
              <table className="sensitivity-table">
                <thead>
                  <tr>
                    <th scope="col">Cost case</th>
                    <th scope="col">Direct costs</th>
                    <th scope="col">Cost base</th>
                    <th scope="col">Indicative price</th>
                  </tr>
                </thead>
                <tbody>
                  {sensitivity.map(({ multiplier, estimate }) => (
                    <tr
                      key={multiplier}
                      className={multiplier === 1 ? "baseline" : ""}
                    >
                      <td>
                        {multiplier < 1 ? (
                          <TrendingDown size={15} />
                        ) : multiplier > 1 ? (
                          <TrendingUp size={15} />
                        ) : (
                          <Calculator size={15} />
                        )}
                        <strong>
                          {multiplier === 1
                            ? "Baseline"
                            : `${multiplier < 1 ? "−" : "+"}10% direct costs`}
                        </strong>
                      </td>
                      <td>{currency(estimate.direct)}</td>
                      <td>{currency(estimate.cost)}</td>
                      <td>{currency(estimate.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className="panel price-comparison-panel"
            aria-labelledby="comparison-heading"
          >
            <PanelTitle
              title="Scenario comparison"
              subtitle="Compare each indicative price with its stated market-planning range."
            />
            <div
              className="price-comparison-chart"
              role="img"
              aria-label="Bar chart comparing indicative prices and market hypothesis ranges for each scenario"
            >
              {comparisonData.length > 0 && (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={comparisonData}
                    margin={{ top: 10, right: 12, left: 6, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} />
                    <YAxis
                      tickFormatter={compactCurrency}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                    />
                    <Tooltip
                      formatter={(value: number | string) =>
                        currency(Number(value))
                      }
                    />
                    <Legend />
                    <Bar
                      dataKey="price"
                      name="Indicative price"
                      fill="#34D399"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="marketLow"
                      name="Market hypothesis low"
                      fill="#5A667C"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="marketHigh"
                      name="Market hypothesis high"
                      fill="#9AA5B6"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default Pricing;
