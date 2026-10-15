# SAM.gov Contract Opportunities source research

**Source ID:** `sam-gov-contract-opportunities`

**Finding:** SAM.gov has an official **Get Opportunities Public API v2** for published opportunity notices. It is the relevant public read/search source for RFP/RFI/Sources Sought ingestion, but it is **not anonymous**: every API request requires a personal public API key. I did not register an account or obtain a key. SAM.gov's ordinary web opportunity search is publicly viewable without an account, but that does not make the API anonymous.

## Official API access

Production endpoint documented by GSA:

```text
GET https://api.sam.gov/opportunities/v2/search
```

Alpha endpoint:

```text
GET https://api-alpha.sam.gov/opportunities/v2/search
```

The API is synchronous and paginated. `postedFrom` and `postedTo` are mandatory for the documented v2 request, in `MM/dd/yyyy` format; the date window may not exceed one year. `limit` is the records per page (documented maximum 1000; default 1) and `offset` is the page index, default 0. The request must include `api_key` as a query parameter. Example implementation shape:

```text
GET https://api.sam.gov/opportunities/v2/search?api_key=<PUBLIC_KEY>&postedFrom=01%2F01%2F2025&postedTo=01%2F31%2F2025&limit=1000&offset=0&ptype=r
```

For continuous sync, partition the `postedFrom`/`postedTo` window into <=1-year slices, page until the returned records are exhausted (`totalRecords`, `limit`, `offset`), and persist `noticeId` as the stable source key. Because the API exposes the latest active version only, it is not sufficient by itself for amendment/version history.

### Request filters

Officially documented v2 filters include:

- `ptype` procurement type (the page lists `r` Sources Sought, `o` Solicitation, `p` Pre-solicitation, `k` Combined Synopsis/Solicitation, `s` Special Notice, `a` Award Notice, `u` Justification/J&A, `g` Sale of Surplus Property, `i` Intent to Bundle Requirements; retired values include `f` and `l`).
- `solnum`, `noticeid`, `title`.
- `postedFrom`, `postedTo` (required), and `rdlfrom`, `rdlto` (response-deadline date filters, also max one-year range).
- `state`, `zip`, `organizationCode`, `organizationName`, `ncode` (NAICS, max six digits), `ccode` (classification), `typeOfSetAside`, `typeOfSetAsideDescription`.
- `limit`, `offset`.
- The page lists `status` as “Coming Soon”; do not assume it is usable without testing against the live service.

### Response-to-platform mapping

The documented response is JSON containing `totalRecords`, `limit`, `offset`, and an opportunity array. The record fields include:

- `noticeId` -> immutable external ID / deduplication key.
- `title`, `solicitationNumber`, `postedDate`, `type`, `baseType`, `archiveType`, `archiveDate`, `active` -> title, solicitation number, timestamps, notice type, lifecycle status.
- `fullParentPathName` and `fullParentPathCode` -> department/agency/office hierarchy. `department`, `subtier`, and `office` are marked deprecated in v2.
- `responseDeadLine` (the documentation spells this field inconsistently in one table as `reponseDeadLine`) -> due date; code should accept the actual JSON spelling returned by the service and test fixtures.
- `naicsCode`, `classificationCode`, `setAside`, `setAsideCode` / `typeOfSetAside*` -> classification and set-aside.
- `pointOfContact[]` with type, title, full name, email, phone, fax, and optional additional information -> contacts.
- `officeAddress` and `placeOfPerformance` -> office and performance locations.
- `award` / `data.award` when present -> award number, amount, date, and awardee (name, UEI, location).
- `description` -> URL to the notice description; the official documentation says to append the public API key to download it, and that a missing description returns “Description not found.”
- `additionalInfoLink` -> optional additional-information URL.
- `uiLink` -> UI notice link, but the docs warn that following it without the required contracting role can result in a 404.
- `links[]` -> self links for the record/request; the docs say an API key is required to access the API link directly.
- `resourceLinks[]` -> direct URLs to opportunity attachments, when present.

## Attachments, amendments, and extracts

The public API documentation explicitly exposes `resourceLinks` for direct attachment URLs. It does **not** document a separate public amendment endpoint in the Get Opportunities API. Its overview explicitly says the API returns only the latest active version; to view all versions, use SAM.gov **Data Services**. GSA says active notices are updated daily and archived notices weekly. Therefore an RFP/RFI platform needing amendment history must additionally consume the official Contract Opportunities file extracts (active and archived) from Data Services, or retain each API snapshot and compare `noticeId` records over time. The Data Services page exposes a public “Contract Opportunities” folder and metadata/data-dictionary links through the site UI, but the fetched official page does not publish a stable machine-readable bulk-download URL or a documented feed protocol. Do not invent one; resolve the current file URLs from the Data Services UI when implementing.

The ordinary SAM.gov Contract Opportunities page states that anyone may search without an account and identifies pre-solicitation, solicitation, award, and sole-source notices. That is a public read-only web fallback for human access, **not** a supported scraping/feed interface. SAM.gov Terms of Use prohibit automated web scraping and automated gathering outside the documented APIs/extracts.

## Authentication, terms, and limits

- A registered user must generate a public API key from SAM.gov Account Details/Profile. The official API page says the key is required and daily requests are limited according to federal/non-federal/general roles. This research did not register, log in, or request credentials.
- The fetched Get Opportunities page documents `limit <= 1000`, positive numeric `limit`/`offset`, required dates, and the error messages for missing/invalid keys, invalid dates, and >1-year windows. It does **not** publish a numeric per-day table on that page. Do not assume the numeric daily quota; obtain the current quota from the authenticated account/API documentation. Related GSA public-API pages commonly distinguish non-federal personal keys from role-bearing/federal keys, but that is not a substitute for a numeric quota stated on this specific page.
- SAM.gov Terms of Use say not to use bots to download/copy restricted or sensitive data, permit software connections to some data with permission, require only public API versions for public sharing, prohibit sharing individual/system API keys, and state that automated data gathering/web scraping can result in account denial. Keys/passwords must be updated every 90 days.
- The API is public in data scope, but access is credential-gated. No commercial/resale license or unrestricted redistribution guarantee was found in the official API page; Terms of Use and any source-specific restrictions control.

## Observed HTTP result (no credential)

I made only read-only GET probes, without an API key, to the documented production URL and the older `/prod/opportunities/...` paths. On **2026-10-12** from this sandbox:

```text
GET https://api.sam.gov/opportunities/v2/search?postedFrom=01%2F01%2F2025&postedTo=01%2F02%2F2025&limit=1&offset=0
HTTP/2 404
content-length: 0
```

```text
GET https://api.sam.gov/prod/opportunities/v2/search?...
HTTP/2 404
```

```text
GET https://api.sam.gov/prod/opportunities/v1/search?...
HTTP/2 404
```

The official OpenAPI file documents 401/403/404 but the no-key probe returned 404 rather than a useful authentication error. This may indicate routing/deployment drift, an environment/network gateway behavior, or a stale public document; it is not evidence that the API works anonymously. No public read-only test endpoint that returns a successful opportunity payload without a credential was found in the official documentation. Alpha is documented but also requires an API key.

## Official URLs

[1]: https://open.gsa.gov/api/get-opportunities-public-api/ "SAM.gov Get Opportunities Public API v2 documentation"
[2]: https://open.gsa.gov/api/get-opportunities-public-api/v1/get-opportunities-v2.yml "Official Get Opportunities API v2 OpenAPI YAML"
[3]: https://open.gsa.gov/api/opportunities-api/ "SAM.gov Opportunity Management API documentation"
[4]: https://sam.gov/data-services "SAM.gov Data Services and Contract Opportunities file extracts"
[5]: https://sam.gov/opportunities "SAM.gov Contract Opportunities public search"
[6]: https://sam.gov/about/terms-of-use "SAM.gov Terms of Use"
[7]: https://www.fsd.gov/gsafsd_sp?id=kb_article_view&sysparm_article=KB0029693 "FSD: How do I access contract opportunities data files?"
[8]: https://www.fsd.gov/gsafsd_sp?id=kb_article_view&sysparm_article=KB0029694 "FSD: How do I use data services?"
