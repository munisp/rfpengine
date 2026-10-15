# UK Contracts Finder OCDS API

**Source ID:** `uk-contracts-finder-ocds`

**Finding:** Contracts Finder has a documented, public read-only OCDS REST API and daily CSV harvester. Public GETs do not require a credential in the tested paths. Credentials are required only for restricted API areas; the documented token flow uses Sid4Gov client credentials. This is therefore implementable for a continuously syncing opportunity feed, subject to rate limiting and the API’s publication-date semantics.

## Implementable endpoints

### Incremental OCDS release-package search

```text
GET https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search
    ?publishedFrom=2026-10-10T00:00:00
    &publishedTo=2026-10-12T23:59:59
    &stages=planning,tender,award,implementation
    &limit=100
    &cursor=<opaque cursor>
```

Documented query parameters are:

- `publishedFrom` and `publishedTo`: optional ISO-8601 bounds on publication date, defined as the latest edit and first publication in the current stage.
- `stages`: optional comma-separated values `planning`, `tender`, `award`, `implementation`.
- `limit`: optional integer, default 100, allowed 1–100.
- `cursor`: optional opaque continuation token, up to 300 characters and matching `[A-Za-z0-9=]{0,300}`.

The response is an OCDS **release package**. It includes top-level `uri`, `version`, `extensions`, `publishedDate`, `publisher`, `license`, `publicationPolicy`, `releases`, and (observed live) `links.next`. Follow `links.next` exactly rather than constructing a cursor. A release has `ocid`, release `id`, `language`, `date`, `tag`, `initiationType`, and procurement sections such as `planning`, `tender`, `parties`, `buyer`, `awards`, and contracts where present.

### Process-level synchronization

```text
GET https://www.contractsfinder.service.gov.uk/Published/OCDS/Record/{ocid}
```

The record package is keyed by the stable Open Contracting Process ID (`ocid`) and contains `records[]`; each record contains the process’s releases. The documentation’s sample shows `packages[]` release URLs and the same OCDS release structures. Use this after an incremental hit when the platform needs the complete history of a procurement process.

### Notice-level release

```text
GET https://www.contractsfinder.service.gov.uk/Published/OCDS/Release/{id}
GET https://www.contractsfinder.service.gov.uk/Published/Notice/OCDS/{notice-guid}
```

The first takes a release identifier and returns an OCDS release package. The second takes a globally unique published-notice ID and returns a release package (404 if it does not exist). The GOV.UK publication also documents the stable JSON URL forms:

```text
https://www.contractsfinder.service.gov.uk/Published/Notice/releases/{NoticeId}.json
https://www.contractsfinder.service.gov.uk/Published/Notice/records/{OCID}.json
```

### Daily bulk feed

```text
GET https://www.contractsfinder.service.gov.uk/harvester/Notices/Data/CSV/{year}/{month}/{day}
```

This returns that date’s OCDS releases as `text/csv`. It is useful for backfills, reconciliation, and replay; the API documentation lists year, month, and day as required integer path parameters. The observed request for `2026/10/12` returned HTTP 200 and a CSV header with flattened OCDS paths including release OCID/id, title, planning documents, tender fields, and more.

## Mapping for an RFP/RFI/source-sought feed

Use `releases[].ocid` as the durable procurement-process key and `releases[].id` as the immutable release/change key. Use `releases[].date` and `tender.datePublished` (when present) for event timestamps; retain top-level `publishedDate` for package metadata. Map `tender.title`, `tender.description`, `tender.status`, `tender.classification`/`items[].classification` (CPV), `tender.deliveryAddresses` or item delivery addresses, `tender.value`/`minValue`, `tender.tenderPeriod`, `tender.contractPeriod`, `tender.procurementMethod`, `tender.mainProcurementCategory`, and `tender.suitability` to the platform’s opportunity fields. Map `buyer`/`parties` to buyer and contact/organization fields, subject to personal-data handling.

The API’s stage filter is not a direct `RFP`, `RFI`, or `source sought` filter. Preserve `tag` and `initiationType`, then classify candidate opportunities from the notice’s published type/title/description and retain the original OCDS values. The official search endpoint exposes only `publishedFrom`, `publishedTo`, `stages`, `limit`, and `cursor`; there is no documented keyword, CPV, buyer, notice-type, or status query parameter on this endpoint. For robust sync, overlap publication windows and upsert by release ID, then refresh the OCID record to capture later releases and withdrawals/amendments.

## Documents, attachments, and amendments

OCDS releases can carry `planning.documents[]` and `tender.documents[]`. The record documentation sample shows document objects with `id`, `documentType`, `description`, `url`, `datePublished`, `dateModified`, `format`, and `language`; a live search response contained an `extensions` list and release data, but its first sampled release had no `tender.documents` field, so document presence is notice-dependent.

The legacy `GET Published/AdditionalDetails/{id}` endpoint documents attachment metadata (`DataType`, `DocumentType`, `Filename`, `MimeType`, `Link`, `TextData`, `FileContent`) and says an attachment can be fetched at `https://www.contractsfinder.service.gov.uk/Notice/{DataType}/{Id}` after extracting its ID and data type. The documented file-content limit is less than 100 MB before encoding. Treat attachment URLs as optional and preserve metadata; do not assume every OCDS document has an independently downloadable file.

For amendment/change history, `GET Published/NoticeVersions/{notice-guid}` returns version rows with `DateChanged`, `NoticeStatus`, `NoticeType`, `VersionNumber`, `VisibleToPublic`, and the published notice ID. It does not itself return full historical notice bodies. Retrieve the associated OCDS record/release packages to materialize the actual release history. OCDS’s release model is explicitly designed to publish a new release when contracting information changes.

## Access, terms, and limits

The API help says authentication is required for certain Web API parts. The token endpoint is `POST /Token`, with an HTTP Basic `username:password` header, `application/x-www-form-urlencoded` body `grant_type=client_credentials`, and a bearer response normally expiring in 3600 seconds. The overview identifies the credentials as Sid4Gov login credentials. Do not put credentials in a public sync client; the public OCDS GETs tested here worked without one.

The search, release, record, CSV, versions, and attachment documentation all specify HTTP 403 when too many requests have been submitted and say no further requests should be made for 5 minutes. No numeric requests-per-minute quota is published in the API pages reviewed. Implement bounded concurrency, exponential backoff, and a minimum five-minute pause on this 403 response; never bypass it.

Contracts Finder terms state that most content is under the Open Government Licence (OGL), feeds are made available for other websites/applications, and the latest content remains on Contracts Finder. The terms prohibit crawling that impairs or disrupts the service, avoiding use limitations, and unauthorized access. They also disclaim guarantees of current, accurate, complete, secure, or virus-free content and state that service access/download metadata may be recorded. Attribute and comply with OGL v3 and preserve the service’s caveats.

## Public read-only HTTP observation

On 12 October 2026, a low-volume unauthenticated request to:

```text
GET https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?publishedFrom=2026-10-10T00:00:00&publishedTo=2026-10-12T23:59:59&limit=1
```

returned **HTTP 200**, `application/json`, one release, and a `links.next` URL containing an opaque cursor. The sampled release had OCID `ocds-b5fd17-63f9689e-e50e-4021-aa10-8d530bfb7f95`, release ID `9dc03e97-0fce-49b0-a773-ce0c18ec1786-915499`, tag `award`, and title `Client Financial Affairs Case Management System`. The same day’s unauthenticated CSV endpoint returned **HTTP 200** and `text/csv`. A request to the documented record JSON URL for the documentation’s sample OCID returned **HTTP 200** with JSON `null`, demonstrating that the route is public but that sample OCIDs may no longer resolve to a populated record.

## Official sources

[1]: https://www.contractsfinder.service.gov.uk/apidocumentation "Contracts Finder API Help Page"
[2]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-Notice-OCDS-Search "GET Published/Notices/OCDS/Search"
[3]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-OCDS-Record "GET Published/OCDS/Record/{ocid}"
[4]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-OCDS-Release "GET Published/OCDS/Release/{id}"
[5]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-Notice-OCDS-id "GET Published/Notice/OCDS/{id}"
[6]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Harvester-Notices-Data-CSV "GET Harvester/Notices/Data/CSV/{year}/{month}/{day}"
[7]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-AdditionalDetails-id "GET Published/AdditionalDetails/{id}"
[8]: https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-NoticeVersions-id "GET Published/NoticeVersions/{id}"
[9]: https://www.contractsfinder.service.gov.uk/apidocumentation/Authentication "POST /Token"
[10]: https://www.gov.uk/government/publications/open-contracting "GOV.UK Open Contracting publication"
[11]: https://www.contractsfinder.service.gov.uk/Home/TermsAndConditions "Contracts Finder terms and conditions"
[12]: https://www.gov.uk/government/publications/open-standards-for-government/open-contracting-data-standard-profile "GOV.UK publishing contract data / OCDS profile"
