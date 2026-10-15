# OpenGov Procurement and Bonfire/Euna supplier opportunity data

Research date: 2026-10-12. Scope: public, read-only acquisition for continuously syncing RFP/RFI/sources-sought-style opportunities. No accounts were registered, secrets requested, access restrictions bypassed, or external data mutated.

## OpenGov Procurement

**Source ID/name:** `opengov-procurement`

**Access mode:** OpenGov publishes an official Procurement & Contract Management API, but it is **authenticated and entity-scoped**, not a public anonymous opportunity feed. The official quickstart says Procurement APIs require an OpenGov platform user, access to the relevant product/entity, developer-level permission, and an API key generated in the product Control Panel. The datasets reference documents legacy alternatives: HTTP Basic Auth (`email` as username and API key as password), or `x-api-key: YOUR_API_KEY`; the standard API authentication is an Authorization token header. The API key only accesses entities/products the account may access. [1] [2]

**Implementable endpoint:**

```http
GET https://api.procurement.opengov.com/gateway/v2/entities/{entityUuid}/datasets/solicitations
```

`{entityUuid}` is a required UUID for an OpenGov entity/agency. The response is a generated `text/csv` binary dataset (not JSON). The only documented query parameter is `utcTime=true|false`; `true` forces UTC, while omitted/false uses the agency-selected timezone. The same endpoint family includes `/datasets/intakes` (intake projects), `/datasets/contracts`, `/datasets/contract-documents`, `/datasets/contracts-with-spend`, `/datasets/vendor-companies`, and `/datasets/vendor-subscribers`. For opportunity syncing, `solicitations` is the closest official dataset; `intakes` can represent pre-solicitation work, but neither is an anonymous public feed. The documentation does **not** describe page/limit/offset/cursor pagination, incremental filters, webhooks, or a last-modified query. Treat each successful CSV export as a full snapshot and diff locally. [2]

**Solicitations mapping:** documented columns include `internal_project_id`, `title`, `project_id`, `template`, `template_abbreviation`, `requisition_id`, `department`, `project_contact`, `procurement_contact`, `release_project_date`, `pre-proposal_meeting`, `question_submission_deadline`, `question_response_deadline`, `proposal_submission_deadline`, `reverse_auction_starting_date`, `reverse_auction_ending_date`, `contractor_selection_date`, `contract_end_date`, `status`, `status_sort`, `created_at`, `last_updated_at`, `budget_amount`, `budget_account`, `budget_description`, `procurement_classification`, `category_codes`, `is_emergency`, plus counts such as `notified`, `viewed`, `followers`, `downloaders`, `applicants`, `no_bids`, and `submissions`. Map `project_id` (or internal ID) to the canonical opportunity key; title/classification/category codes to search fields; release/deadline/status/last-updated fields to lifecycle and sync fields; agency identity comes from `entityUuid` (the CSV schema does not include a portal URL). Dates follow agency timezone unless `utcTime=true`. [2]

**Attachments/amendments:** the datasets reference exposes solicitation metadata only; it does not document attachment or addendum collections in the CSV schema. OpenGov’s public portal does expose project documents, downloads, an Addenda & Notices page, Q&A, and an addendum diff URL. Example public project: `https://procurement.opengov.com/portal/greenvillecounty/projects/235409/document?section=all` shows “Request for Proposal,” project ID, release/due dates, sectioned solicitation text, Downloads, Addenda & Notices, Q&A, and a “Last updated by Addendum #1” link. The official vendor guide says suppliers receive addenda notifications when following/downloading/applying/no-bidding/submitting, and must acknowledge addenda before submitting; addenda may be acknowledged without un-submitting or by un-submitting/re-submitting. [3] [4]

A public attachment route was observed from an official search result and tested read-only: `GET https://api.procurement.opengov.com/api/v1/attachments/677832` returned **HTTP 200**, `Content-Type: application/pdf`, 400,123 bytes, and redirected to a time-limited signed Amazon S3 object. This route is not documented in the Procurement API catalog as an attachment-list/discovery API; it requires already knowing an attachment ID. It is therefore useful for fetching a discovered public document, not for enumerating attachments or amendments. [5]

**Observed HTTP results:**

* Anonymous `GET https://api.procurement.opengov.com/gateway/v2/entities/00000000-0000-0000-0000-000000000000/datasets/solicitations` returned **HTTP 403** in this sandbox (Cloudflare HTML response), consistent with the official requirement for entity access and credentials; no credential was supplied.
* Anonymous `GET` to the public portal example returned **HTTP 403** in this sandbox due to edge protection, although official page extraction/read-only browsing exposed the public project content. This is an environment/edge observation, not evidence that all end-user browsers receive 403.
* The known public attachment route above returned **HTTP 200 PDF**.

**Terms/access limits:** OpenGov’s public developer terms are linked from the catalog, but the dataset page does not publish a numeric rate limit or anonymous-use allowance. Access is contract/account/entity permission based; invalid API keys produce 401 and lacking entity Procurement access produces 403. No public read-only API test without credentials was available for the dataset endpoint. Official API/schema links: [1] [2] [6].

## Bonfire / Euna Supplier Network

**Source ID/name:** `bonfire-euna-supplier-network`

**Access mode:** **No official public developer API, public feed, or documented machine-readable opportunity endpoint was found.** Euna’s official supplier help documentation describes a web portal and UI capabilities, not an API contract. The current supplier login page is `https://vendor.bonfirehub.com/` and requires login/sign-up. The official help article says ESN Pro users can search recommendations by keyword, organization, and location; view all open public opportunities; follow opportunities; receive Public Notice/Addenda/deadline emails; and export lists from certain authenticated detail pages using a download button. It does not publish HTTP endpoint paths, parameters, pagination, response schema, auth tokens, rate limits, or terms for automated extraction. [7] [8]

**Implementable public endpoint:** None officially documented. A public read-only portal HTML view exists per agency, for example `https://gatewayprogram.bonfirehub.com/portal/?tab=openOpportunities`. Official page extraction returned **HTTP success** and an HTML-rendered “Open Public Opportunities” table with columns `Status`, `Ref. #`, `Project`, `Close Date`, `Days Left`, `Action`; this tenant currently displayed “There are no open projects at this time.” This is a human-facing page, not a stable API/feed contract. [9]

**Mapping/coverage:** the public table’s visible fields can map to status, reference number, title, close date, and days remaining. Detail pages may expose description, documents, notices/addenda, and deadlines, but the official Euna documentation does not specify their URLs, schemas, attachment enumeration, amendment identifiers, or a supported bulk export. Euna’s help page explicitly says external-source opportunities are not captured in some widgets, and its export capability is described for authenticated widget/detail lists rather than a public feed. [7]

**Attachments/amendments:** official Euna/Bonfire materials found in this research describe suppliers following opportunities and receiving notifications for public notices and addenda, but do not document a public attachment/addendum API or stable download endpoints. Public project pages may link files in a browser, but relying on reverse-engineered portal requests would be unsupported and potentially subject to change/access limits.

**Commercial/no-docs finding:** Euna Supplier Pro is a supplier subscription/product experience. The official article links registration and subscription-related help, and the supplier login page advertises the network; no public API licensing, rate-limit, or developer terms were published in the documentation reviewed. Therefore do not invent an API endpoint. For a continuously syncing platform, Bonfire/Euna requires a commercial/vendor-approved integration or an agency-by-agency public-page strategy only after confirming permission and terms; no credential-free official feed was verified. [7] [8] [10]

## References

[1]: https://developer.opengov.com/catalog "OpenGov API Catalog"
[2]: https://developer.opengov.com/catalog/pro-api/datasets "OpenGov Procurement Datasets API"
[3]: https://procurement.opengov.com/portal/greenvillecounty/projects/235409/document?section=all "OpenGov public solicitation example with documents and addenda"
[4]: https://opengov.my.site.com/support/s/article/e824568d-8f0d-4632-ab5e-a7bd277732fc "OpenGov Managing Addenda"
[5]: https://api.procurement.opengov.com/api/v1/attachments/677832 "Observed OpenGov public attachment route"
[6]: https://developer.opengov.com/docs/quickstart "OpenGov API Quickstart and authentication requirements"
[7]: https://procurement-help.eunasolutions.com/hc/en-us/articles/48896438064147-Euna-Supplier-Pro-Portal-Overview "Euna Supplier Pro Portal Overview"
[8]: https://vendor.bonfirehub.com/ "Euna Supplier Network login"
[9]: https://gatewayprogram.bonfirehub.com/portal/?tab=openOpportunities "Bonfire public open-opportunities portal example"
[10]: https://procurement-help.eunasolutions.com/hc/en-us/articles/48653049027091 "Euna Supplier Pro account registration help"
