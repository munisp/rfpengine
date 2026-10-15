# TED (Tenders Electronic Daily) — Search API v3

**Source ID/name:** `ted-eu-search-v3` — European Commission Publications Office, TED Search API v3 (public procurement notices).

## Access mode and implementable endpoint

TED’s official v3 documentation says published-notice services (search/retrieve) allow **anonymous access**; API keys are required only for operations on unpublished notices. The production endpoint is:

```http
POST https://api.ted.europa.eu/v3/notices/search
Content-Type: application/json
```

The authoritative v3 OpenAPI document is [`api-v3.yaml`](https://api.ted.europa.eu/api-v3.yaml), also exposed in [Swagger UI](https://api.ted.europa.eu/swagger-ui/index.html#/Search/search). No account, API key, or secret is needed for the read-only search operation. TED explicitly says Search API is not available in the Preview environment, so use production for public notice reads. [1] [2]

### Request body and pagination

Required JSON properties are `query` (expert-search string) and `fields` (array of field names to return). The OpenAPI schema also defines:

- `paginationMode`: `PAGE_NUMBER` (default) or `ITERATION`.
- `limit`: page size (the OpenAPI request schema defines the page-size property; production enforces max 250 notices/page).
- `pageNumber`: page number for `PAGE_NUMBER` mode.
- `iterationNextToken`: opaque token returned by the previous response; omit on the first `ITERATION` call and send it on subsequent calls.
- `scope`: `LATEST`, `ACTIVE`, or `ALL` (default `ALL`), controlling latest OJ-S release, active notices, or all notices.
- `onlyLatestVersions`: boolean, default `false`.
- `checkQuerySyntax`: boolean; `true` validates syntax without executing the search.

The schema requires `query` and `fields`; fields are selected from TED’s official [search-field list](https://docs.ted.europa.eu/ODS/latest/reuse/field-list.html), not arbitrary JSON properties. Business sectors/places are hierarchical, so CPV and NUTS codes must be handled as hierarchies. [1] [3] [4]

`PAGE_NUMBER` can retrieve at most 15,000 matches; maximum page size is 250 and maximum fields per page is 10,000 (notices × returned fields). `ITERATION` has no total-result cap, but pages must be consumed sequentially with the opaque token; it still has max 250 notices/page and 10,000 fields/page. The OpenAPI description says the token is optional for page-number mode and mandatory for subsequent iteration calls. [2]

Minimal example:

```json
{
  "query": "publication-date >= 20260101",
  "fields": ["publication-number", "notice-type", "notice-title", "publication-date"],
  "paginationMode": "ITERATION",
  "limit": 100,
  "onlyLatestVersions": true
}
```

A continuously syncing client should query a bounded publication-date window, use `ITERATION` to avoid the 15k cap, persist the last successful token/page and a high-water mark, and de-duplicate by publication/notice identifiers. The expert-query syntax should be validated using `checkQuerySyntax` or the TED Expert Search UI before production use. Query errors are documented as HTTP 400 responses (syntax, unknown field, unsupported operation/value, expired/invalid iteration token).

## Response and mapping

The documented response schema is an object with:

- `notices`: array of notice objects. Each object contains only requested fields plus a `links` object when available.
- `totalNoticeCount`: integer total matching the query (useful in page-number mode; iteration clients should not rely on it as a completion signal).
- `iterationNextToken`: opaque continuation token.
- `timedOut`: boolean indicating search timeout.

Observed anonymous production result (HTTP **200**, `application/json`) for `POST /v3/notices/search` with `publication-date >= 20260101`, fields `publication-number` and `title-proc`, `limit:2`, `paginationMode:PAGE_NUMBER`, `pageNumber:1`: response keys were `notices`, `totalNoticeCount`, `iterationNextToken`, and `timedOut`; two notices were returned. A notice included `publication-number` (`1-2026` in the observed response), multilingual `title-proc` (e.g. `{ "hrv": "..." }`), and `links` containing XML, multilingual HTML, PDF and signed-PDF URLs. The first XML link was `https://ted.europa.eu/en/notice/1-2026/xml`.

Recommended BidForge mapping (field names are exact TED search fields; select only what is needed to stay under field-page limits):

- **identity:** `publication-number`; `notice-identifier` (`BT-701-notice`), `notice-version` (`BT-757-notice`), `procedure-identifier`/`identifier-glo` where present.
- **classification:** `notice-type` (`BT-02-notice`), `notice-subtype` (`OPP-070-notice`), `form-type`, `procedure-type`, `main-classification-proc`/lot, CPV and NUTS/place fields.
- **display:** `notice-title`/`title-proc`, official-language fields, buyer/organisation names and contacts.
- **timing:** publication/dispatch/preferred publication dates, tender receipt deadline (`deadline-receipt-request`), question/document deadlines where exposed by the field list.
- **commercial:** estimated/maximum values, currency, duration, lots, award/result fields.
- **links/raw:** retain returned `links.xml`, `links.html`, `links.pdf`, `links.pdfs`; fetch XML as canonical raw notice and preserve the JSON snapshot.

The official field list confirms useful amendment and lineage fields, including `modification-previous-notice-identifier` (`BT-1501(n)-Contract`), `modification-description`, `modification-justification`, `notice-identifier`, `notice-version`, and related previous-notice identifiers. [3]

## RFP/RFI/sources-sought fit, amendments, and attachments

TED does not provide a generic U.S.-style “RFP/RFI” object. Its eForms notice taxonomy includes a voluntary pre-market consultation **PMC** (consultation) notice, PIN/planning notices, contract/competition notices, qualification-system notices, results, modifications, completions and change notices. The official eForms documentation identifies PMC as “Voluntary Pre-Market Consultation” and explains that **Change** notices correct earlier information or announce changes to procurement documents; a change notice contains the consolidated notice plus latest changes. Therefore, map “RFI/sources sought” primarily from `notice-type`/`notice-subtype` (especially PMC and planning/PIN), not by assuming every TED record is an RFP. [5]

Amendment handling is available at the notice level through subsequent change/corrigendum notices and previous-notice/procedure identifiers. Ingest every published change notice, link it to its parent using the identifiers in XML, and replace/reconcile the consolidated record while retaining an immutable amendment event. [3] [5]

The public Search API response exposes notice metadata and direct XML/HTML/PDF manifestations. TED’s official reuse documentation does **not** document a public Search API attachment-list or attachment-download endpoint. Notice XML may include document URLs/submission URLs and the notice may link to buyer-hosted procurement documents, but those external documents are not guaranteed to be present or downloadable through TED. Do not invent an attachment API; treat external document URLs as optional fields and fetch them only under a separate, policy-controlled process. TED’s direct link formats are:

- `https://ted.europa.eu/{lang}/notice/{publication-number}/xml`
- `https://ted.europa.eu/{lang}/notice/{publication-number}/html`
- `https://ted.europa.eu/{lang}/notice/{publication-number}/pdf`
- `https://ted.europa.eu/{lang}/notice/{publication-number}/pdfs`

## Bulk/feed alternatives and limits

For backfills, TED publishes public XML packages: daily `https://ted.europa.eu/packages/daily/{yyyynnnnn}` (OJ-S number) and monthly `https://ted.europa.eu/packages/monthly/{yyyy-n}`. A package contains all notices for the selected day/month. The portal also exposes RSS feeds by country and business sector, but the RSS page documents selectable feeds rather than a v3 API contract; use Search API or bulk XML as the authoritative sync path. [3] [6]

TED’s official fair-use policy states: **700 HTTP requests/minute**, **600 visualizations/downloads per single IP in less than 6 minutes**, and **3 concurrent HTTPS daily/monthly package downloads**. The notice data can generally be freely reused commercially or non-commercially; TED notice data is subject to the legal notice, while editorial website content is CC BY 4.0 and system metadata is CC0. TED disclaims completeness/accuracy and service continuity. [3] [7]

## Limitations and caveats

- Search covers **published** notices only; unpublished/submitted notices are not publicly readable.
- Search API is anonymous, but other v3 operations (publication, validation of unpublished submissions, etc.) require a developer API key. API keys require EU Login; no registration was performed for this research. [1] [2]
- Production Search API is not available in Preview; Preview notices are not published to TED. [1]
- PAGE_NUMBER is capped at 15,000 matches; use ITERATION or date-window partitioning for a complete sync. Keep requests below page/field caps and honor 700 requests/minute.
- Schema field names are numerous and can evolve independently; pin/version-test your selected mapping and retain raw XML.
- Attachments/supplementary tender documents are not guaranteed by TED and no official public attachment endpoint was found in v3 docs. Buyer-hosted URLs may be inaccessible, expire, require separate terms, or change.
- TED is not a commercial API vendor; official documentation and public endpoints are available. No commercial subscription or paid API requirement was identified in the official sources reviewed.

## References

[1]: https://docs.ted.europa.eu/api/latest/index.html "TED API v3 overview and authentication"
[2]: https://docs.ted.europa.eu/api/latest/search.html "TED Search API v3 documentation"
[3]: https://ted.europa.eu/en/simap/developers-corner-for-reusers "TED developers’ corner for reusers"
[4]: https://api.ted.europa.eu/api-v3.yaml "TED API v3 OpenAPI specification"
[5]: https://docs.ted.europa.eu/eforms/latest/schema/all-in-one.html "TED eForms schema: change notices and notice types"
[6]: https://ted.europa.eu/en/simap/xml-bulk-download "TED XML bulk download packages"
[7]: https://ted.europa.eu/en/legal-notice "TED legal notice, reuse and disclaimer"
