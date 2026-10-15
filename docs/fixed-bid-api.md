# Implemented fixed-bid database and API

The feature is registered as `erosion` in the application's root tRPC router and served by the existing Express `/api/trpc` middleware. It is not a parallel unauthenticated calculator service. React uses the existing `trpc.erosion` client.

## Database model

The additive migrations `drizzle/0002_fixed_bid_erosion.sql` and `drizzle/0003_audit_case_integrity.sql` creates three tables. No existing business rows are changed or seeded.

**fixed_bid_baselines** stores immutable locked bid assumptions: ID, workspace ID, series ID, revision number, previous revision ID, name, bid price, labor cost, other cost, overhead/minimum-margin basis points, currency, performance dates, assumptions, revision reason, creator and timestamp. Financial columns are `DECIMAL(18,2)` and arrive at the API as decimal strings. A unique `(seriesId, revision)` index prevents competing successor revisions. A unique `(workspaceId, requestKey)` index supports idempotent create/revise retries. A SHA-256 request fingerprint rejects key reuse for a different payload.

**fixed_bid_cases** stores baseline/workspace IDs, independent labor and other cost changes, overhead percentage-point change, fully burdened extra cost, rationale, immutable calculated result, request fingerprint/key, actor and timestamp. Results carry `calculationVersion: fixed-bid-v1` for reproducibility. A case always references the precise baseline revision, never a mutable 'latest' alias.

**fixed_bid_audit** records baseline creation, revisions and saved cases with actor, timestamp and reason. A foreign key enforces case references as well. Audit writes share the same transaction as the corresponding financial record. No update/delete API is exposed for these tables.

Foreign keys tie workspace and actor identifiers to existing data. Owner/editor membership permits writes; reviewer membership permits reads, evaluation and export. All operations resolve membership through `getAccessibleWorkspace`. The API takes no trusted client actor or role field.

This is an application-immutable audit trail, not a claim of database-admin tamper resistance. Revisions are internal analysis records; creating one does not submit or amend a bid with the buyer.

## API operations

| tRPC procedure | HTTP transport | Behavior |
| --- | --- | --- |
| `erosion.list` | GET `/api/trpc/erosion.list` | List accessible baselines/revisions for a workspace |
| `erosion.get` | GET `/api/trpc/erosion.get` | Read baseline, saved cases and audit events |
| `erosion.create` | POST `/api/trpc/erosion.create` | Save initial immutable baseline and audit event |
| `erosion.revise` | POST `/api/trpc/erosion.revise` | Save new revision of the latest series revision; reason required |
| `erosion.evaluate` | GET `/api/trpc/erosion.evaluate` | Calculate stress against an accessible locked baseline, without persistence |
| `erosion.saveCase` | POST `/api/trpc/erosion.saveCase` | Calculate server-side and save immutable case plus audit event |
| `erosion.export` | GET `/api/trpc/erosion.export` | Return CSV file content for baseline and saved cases |

These are tRPC endpoints, not plain REST bodies. Use the generated client or the application's SuperJSON tRPC encoding. Responses use the usual tRPC result envelope. Money in results remains decimal strings; percentage results are decimal strings with four places; undefined percentages are `null`.

### Baseline input

```json
{
  "workspaceId": "existing-workspace-id",
  "requestKey": "client-generated-unique-key",
  "baseline": {
    "name": "Balanced locked bid",
    "bidPrice": "4017073.17",
    "labor": "2350000.00",
    "other": "350000.00",
    "overheadBps": 2200,
    "minimumMarginBps": 1000,
    "currency": "USD",
    "periodStart": "2026-11-01",
    "periodEnd": "2029-10-31",
    "assumptions": "All costs and revenue cover the same three-year base scope."
  }
}
```

For revision, supply `previousId` and a nonempty `reason` along with these fields. A stale predecessor returns `CONFLICT`; reload and revise the latest record. Repeated keys return the existing identical operation rather than a second audit event. Changed payload with an existing key returns `CONFLICT`.

Money must be nonnegative base-10 strings with at most two decimal places and at most 12 integer digits. Bid price must be positive. Overhead is 0–100%; minimum margin 0–95%. Dates must be valid calendar dates and end cannot precede start. The calculation uses Decimal.js with 40-digit precision, rounds modeled costs to cents and does not hide losses.

### Stress input

```json
{
  "workspaceId": "existing-workspace-id",
  "baselineId": "saved-baseline-id",
  "stress": {
    "name": "+10% direct costs",
    "laborChangeBps": 1000,
    "otherChangeBps": 1000,
    "overheadChangeBps": 0,
    "extraCost": "0.00",
    "rationale": "Same scope; labor and other direct costs increase together."
  }
}
```

For `saveCase`, add `requestKey`. A basis point is 0.01 percentage point: 1000 is +10%; for overhead it means an additive +10 percentage points. Labor/other shocks permit −100% through +1000%; stressed overhead must remain 0–100%. Extra cost is already fully burdened and is not charged overhead again.

### Result

For the +10% case above:

```json
{
  "calculationVersion": "fixed-bid-v1",
  "bidPrice": "4017073.17",
  "baselineCost": "3294000.00",
  "stressedCost": "3623400.00",
  "profit": "393673.17",
  "realizedMarginPercent": "9.8000",
  "profitErosion": "329400.00",
  "profitErosionPercent": "45.5556",
  "minimumMarginBreached": true,
  "loss": false,
  "status": "MARGIN_FLOOR_BREACHED"
}
```

The result also includes baseline profit/direct costs, stressed component costs/overhead, margin erosion in percentage points, break-even headroom, minimum-margin headroom and baseline percentage growth to each threshold. If baseline profit is nonpositive, profit-erosion percentage is `null`; dollar erosion remains available. If baseline cost is zero, cost-growth percentages are `null`.

Read/authorization failure, missing baseline and malformed inputs return normal `UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST` or `CONFLICT` tRPC errors. Database failures do not return partial persisted records because record/audit writes are transactional.

## React workflow

In **Price to win**, select **Fixed bid / profit erosion**. Enter all-scope baseline amounts, dates and assumptions; select **Lock bid baseline**. Choose a saved revision, vary independent costs, inspect remaining profit and margin-floor headroom, and save a stress case. To change the bid or baseline assumptions, create a new immutable revision with a reason. Export the selected revision's baseline and saved cases as CSV.

Sample mode is clearly labeled and creates no managed database records. Reviewers can inspect and export fixed-bid results but cannot lock, revise or save pricing records.

## Operational limits

The feature is not accounting net income, a bid-submission service, or a probability-of-win model. It assumes cost components and revenue are comparable in scope, currency and period. It models aggregate costs rather than hours/rates, separate G&A/fringe or stochastic risks. DB constraints, arithmetic tests, router tests and frontend probes supplement but do not replace a signed-in production acceptance run.
