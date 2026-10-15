# UK Find a Tender (FTS) OCDS API

**Source ID:** `uk-find-a-tender-ocds`

**Source name:** UK Find a Tender Service (FTS) public OCDS API

## Access mode and implementable endpoints

FTS publishes notice data under the **Open Government Licence v3.0**. The official data/API page states that notices are mapped to **OCDS 1.1.5** with Open Contracting Partnership EU-profile extensions. The public read-only API works without a CDP API key:

```text
GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages
```

`latest` also worked in the observed test and resolved to version 1.0:

```text
GET https://www.find-tender.service.gov.uk/api/latest/ocdsReleasePackages
```

Use the release-package feed for continuous synchronization. It returns releases (individual notice/lifecycle publications), and supports an update window and cursor. A practical first request is:

```text
GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=100&updatedFrom=YYYY-MM-DDTHH:MM:SS&updatedTo=YYYY-MM-DDTHH:MM:SS
```

The official endpoint documentation defines these query parameters:

- `limit`: optional integer, default 100, minimum 1, maximum 100.
- `cursor`: opaque pagination token, maximum length 300; follow the `links.next` URL returned by the API rather than constructing it.
- `updatedFrom` / `updatedTo`: optional date-times in `YYYY-MM-DDTHH:MM:SS`; they filter by when the record was last updated.
- `stages`: optional comma-delimited contracting-process stages; documented values are `planning,tender,award` (for example `stages=tender`).

An individual notice can be requested with its notice ID (`nnnnnn-yyyy`):

```text
GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages/{notice-id}
```

An individual procurement process can be requested by OCID (`ocds-h6vhtk-hhhhhh`):

```text
GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages/{ocid}
GET https://www.find-tender.service.gov.uk/api/1.0/ocdsRecordPackages/{ocid}
```

The release endpoint returns an OCDS **release package**. The record endpoint returns an OCDS **record package** for one OCID and includes releases, a compiled release, and a versioned release. The record endpoint has no query parameters; its path identifier is the OCID.

## Authentication, terms, and limits

The general FTS REST API specification says the REST API used by eSenders and submission/retrieval operations requires a CDP API key in the `CDP-Api-Key` header. That requirement applies to the submission/status REST operations documented there. In contrast, the two OCDS download endpoints are explicitly published as public data outputs, and the probes below succeeded with **no credentials and no account**. Do not send or request a secret for read-only syncing unless FTS changes this behavior.

The OCDS endpoint documentation specifies HTTP 429 when too many requests are submitted and says to stop until the seconds in `Retry-After`; it likewise specifies 503 with `Retry-After` for temporary unavailability. It does not publish a numeric rate limit. Implement exponential/backoff handling and honor `Retry-After`. Invalid query names produce HTTP 400 and the response lists allowed parameters.

The official data page says notice data is available under the Open Government Licence. The response carries a `license` URL and `publicationPolicy` URL. FTS page terms also state that content is OGL v3.0 except where otherwise stated.

## Schema and mapping for an RFP/RFI/source-sought platform

A release package has top-level `uri`, `version`, `extensions`, `publishedDate`, `publisher`, `license`, `publicationPolicy`, `releases`, and `links`. Each release commonly contains `ocid`, release `id`, `date`, `tag`, `initiationType`, `parties`, `buyer`, `tender`, and `language`.

Useful implementation mapping:

- Stable procurement key: `release.ocid`; stable publication/release key: `release.id` (release IDs are unique within an OCID).
- Title/summary: `release.tender.title`, `release.tender.description`.
- Lifecycle: `release.tag` (for example `planning`, `tender`, `award`) and `release.tender.status`.
- Classification: `release.tender.classification` plus `additionalClassifications`; usually CPV IDs/descriptions.
- Buyer: `release.buyer` and the matching party in `release.parties` (name, identifier, address, contactPoint, roles, details).
- Estimated value: `release.tender.value.amount` and `.currency`; lot-level values are in `release.tender.lots[].value`.
- Locations/items: `release.tender.items[]`, including classifications, deliveryAddresses and relatedLot.
- Dates: `tenderPeriod`, `enquiryPeriod`, `awardPeriod`, and `communication.futureNoticeDate` where present.
- Submission: `submissionMethod`, `submissionMethodDetails`, and `submissionTerms`.
- Lots: `release.tender.lots[]` and `lotDetails`.
- Documents/attachments: `release.tender.documents[]` objects can include `id`, `documentType`, `noticeType`, `description`, `url`, `datePublished`, and `format`. In the live sample, the tender notice document linked to the public HTML notice URL. Some document entries are metadata only (for example a conflict-of-interest item marked “Not published”), so do not assume every document has a downloadable URL.

The API response advertises extensions including the EU profile and UK/extension URLs for amendment rationale classifications, budget breakdown, contract completion, documentation, pagination, suitability, links, and the Cabinet Office UK extension. Amendment/revision data is represented through OCDS releases and the record package’s compiled/versioned release. However, the live release sample was a first `tender` release and had no top-level amendment field; consumers should upsert by OCID and release ID, retain all releases, and inspect extension fields rather than assuming a dedicated amendment object. The API provides notice/document URLs, but it is not an authenticated bid-document repository; access to a linked document may be governed by the buyer/notice.

For RFI/source-sought ingestion, include `planning` releases and treat the notice type/fields as source data rather than assuming every `tender` is an open RFP. The documented `stages` filter is only `planning,tender,award`; filter notice type (`tender.documents[].noticeType` when present), titles/descriptions, and the detailed OCDS fields in your own pipeline for RFI, PIN, market engagement, or source-sought classifications.

## Observed public HTTP results (12 October 2026)

- `GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=1` → **HTTP 200**, `Content-Type: application/json`, no API key. It returned one release and a `links.next` URL containing an opaque `cursor`; the returned `uri` also included an automatically added `updatedTo` timestamp.
- `GET https://www.find-tender.service.gov.uk/api/latest/ocdsReleasePackages?limit=1` → **HTTP 200**, no API key; returned URI resolved to `/api/1.0/ocdsReleasePackages`.
- `GET .../ocdsReleasePackages?limit=1&stages=tender` → **HTTP 200**, no API key.
- `GET .../ocdsReleasePackages/000001-2021` → **HTTP 200**, no API key.
- `GET .../ocdsRecordPackages/ocds-h6vhtk-000cb9` → **HTTP 404** with JSON `"identifier" is not found` (the documentation’s sample integration OCID is not necessarily present in production).
- `GET .../ocdsReleasePackages/not-a-real-id` → **HTTP 404** with JSON `"identifier" is not found`.

The live feed sample had `ocid=ocds-h6vhtk-06e3d2`, `id=096326-2026`, `tag=["tender"]`, buyer `Wigan Council`, CPV/classification and an HTML `tenderNotice` document URL. The `links.next` object was present and should be the pagination source of truth.

## Official URLs

[1]: https://www.find-tender.service.gov.uk/Developer/Documentation "Find a Tender data and API documentation"
[2]: https://www.find-tender.service.gov.uk/apidocumentation/1.0/GET-ocdsReleasePackages "GET OCDS release packages"
[3]: https://www.find-tender.service.gov.uk/apidocumentation/1.0/GET-ocdsRecordPackages "GET OCDS record packages"
[4]: https://www.find-tender.service.gov.uk/apidocumentation "Find a Tender REST API specification"
[5]: https://www.gov.uk/government/publications/open-contracting "GOV.UK Open Contracting data publication"
[6]: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/ "Open Government Licence v3.0"
[7]: https://standard.open-contracting.org/profiles/eu/master/en/ "OCDS EU profile and mapping"
