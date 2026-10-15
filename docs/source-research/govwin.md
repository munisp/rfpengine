# Deltek GovWin IQ procurement opportunity API research

**Research date:** 2026-10-12. **Source:** Deltek GovWin Web Service API V3 (WSAPI) Quick Reference, March 11, 2025. The PDF is publicly downloadable, but its own notice says the documentation/software is proprietary, confidential, and supplied only under a license agreement; it is not an open/public data API. [1]

## Finding

GovWin has a documented REST/JSON API, **GovWin WSAPI V3**, for opportunity and government-entity retrieval. It is implementable only for a provisioned GovWin customer organization/user. Deltek's own integration help says the customer must subscribe to the GovWin IQ Web Service and obtain a username/password before access. [2] There is no documented anonymous/public opportunity API or public API key in the official material reviewed.

### Source identity and access mode

- **Source ID/name:** `govwin_iq` / **Deltek GovWin IQ — GovWin Web Service API V3 (WSAPI)**.
- **Access mode:** commercial, OAuth2-protected, organization-scoped API. The client authenticates on behalf of a GovWin user account. The API documentation supports password and refresh-token grants; the client ID/client secret come from the GovWin admin UI or provisioning process. Accounts lock for 30 minutes after five failed authorization attempts. [1]
- **Token endpoint:** `POST https://services.govwin.com/neo-ws/oauth/token`, HTTPS, `Content-Type: application/x-www-form-urlencoded`. Password grant fields: `client_id`, `client_secret`, `grant_type=password`, `username`, `password`, `scope=read`. Refresh grant fields: `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`, `scope=read`. Successful response includes `access_token`, `token_type` (`bearer`), `refresh_token`, `expires_in`, and `scope`. Send subsequent requests with `Authorization: Bearer <access_token>`. Access tokens expire after 12 hours; refresh tokens after 30 days. [1]
- **Implementable API base:** `https://services.govwin.com/neo-ws` (all paths below are relative to it). The documentation's examples use this host and the bearer header. [1]

## Opportunity endpoints and sync implementation

### Search / incremental feed

`GET /opportunities?{searchparams}` searches multiple opportunity types; all supplied filters are ANDed. The practical continuously-syncing call is:

```text
GET https://services.govwin.com/neo-ws/opportunities?
  oppType=ALL&oppSelectionDateFrom=2025-03-11T00:00:00&oppSelectionDateTo=2025-03-12T00:00:00&
  oppCategory=2&offset=0&max=100&sort=updatedDate&order=asc
Authorization: Bearer <token>
```

Use the current cursor window and persist each record's `updateDate`; Deltek explicitly recommends querying only new/updated opportunities and comparing returned `updateDate` with the stored value. `oppSelectionDateFrom` is based on create/update date for “new” or “new and updated” searches. If omitted, it defaults to opportunities created or modified in the previous 24 hours; `oppSelectionDateFrom=01/01/1900` retrieves all qualified opportunities. `oppSelectionDateTo` defaults to today. `oppCategory=1` means New; `2` means New and Update. [1]

Documented search filters include:

- `oppType`: `OPP` tracked opportunity, `TNS` task-order opportunity, `BID` bid/lead, `FBO` SAM notice, `OPN` other procurement notice, `TOP` Opportunity Manager, `ALL` all types.
- `oppSubType`: `APFS`, `SBIR_STTR`, or `ALL` (when used, applies to OPN records).
- `govEntityId`, `q` (keyword; maximum 255 chars), `market` (`Federal` or `SLED`).
- Date ranges: `responseDateFrom/To`, `solDateFrom/To`, `pAwardDateFrom/To`; dates accept `MM/DD/YYYY`, `yyyy-MM-dd`, `yyyy-MM-ddTHH:mm:ss`, and documented relative values such as `-24H`, `-1W`, `-30D`, `-3M`, `-6M`, `-1Y`, `-2Y`, `-5Y` (future equivalents for “to” values).
- `classificationCodes`, `naics` (full/partial begins-with, comma-delimited), `hasNoNaics`, `hasNoClassificationCode`, `hasBidTabulation`, `hasPlanHolder`.
- Paging/sort: `offset` integer, default `0`; `max` default `10`, maximum `100`; `sort` values `relevancy`, `title`, `buyingOrg`, `solicitationDate`, `value`, `requirement`, `createdDate`, `updatedDate`; `order` `asc`/`desc` (documented defaults vary by sort). [1]

For a reliable sync, advance `offset` within a window until `offset + page size >= totalCount`, but keep each window narrow: the API currently has a system offset limit of 10,000. Prefer time-window partitioning (and overlap/reconciliation) over attempting to walk huge result sets. [1]

### Detail and related content

- `GET /opportunities/{globaloppid1},{globaloppid2},...` retrieves up to 10 global IDs in one call. IDs are opaque and use documented prefixes such as `OPP`, `TNS`, `BID`, `FBO`, `OPN`, and `TOP`; do not parse their format. [1]
- `GET /opportunities?savedSearchId={id}` uses a saved search belonging to the same authenticated user; the ID is obtained from the GovWin UI. It supports `oppSelectionDateFrom/To`, `oppCategory`, `hasBidTabulation`, `hasPlanHolder`, `offset`, and `max`. [1]
- Extended endpoints: `GET /opportunities/{id}/placesOfPerformance`, `/fboNotices`, `/relatedDocuments`, `/markedByUsers`, `/relatedArticles`, `/contracts`, `/assessments`, `/milestones`, `/contacts`, `/companies`, `/contractVehicles`, `/parentNodes`, and `/verticals`. Most accept `offset`, `max` (maximum 100), `sort`, and `order`; the reference specifies per-endpoint sort fields. [1]
- Attachments/documents are available as metadata through `/relatedDocuments`: `documentDownloadURL`, `documentURL`, `fileName`, `fileTypeDescription`, `id`, `isExternal`, `publicationDate`, `sourceDescription`, and `title`. FBO notices are available through `/fboNotices` with `documentLink`, `id`, `publicationDate`, and `title`. `isExternal=true` means the source is outside GovWin; the download link forwards to a standard PDF explaining that the original document is external. [1]
- Amendments/modifications are not a generic “amendments” feed, but the API documents `/opportunities/{id}/modifications` in the opportunity links and a **Modifications** object containing `actionDate`, `actionType`, `amount`, `createdDate`, `description`, `lastModifiedDate`, `modNum`, and `projectId`. The reference's extended endpoint function list omits a separate modifications section, so availability/permission should be verified against the provisioned account; do not assume every opportunity has modifications. [1]

## Response mapping

Successful list responses are JSON objects with `links`, `meta.paging`, and an array (`opportunities`, `relatedDocuments`, `documentLinks`, etc.). Paging fields are `max`, `offset`, `sort`, `order`, and `totalCount`; offset is zero-based. Default page size is 10 and values over 100 error. [1]

Recommended platform mapping:

- `opportunities[].id` -> stable source opportunity ID; retain `iqOppId` as the numeric GovWin ID where present.
- `title` -> title; `description` -> description (may contain HTML); `type` -> source type; `status` -> acquisition status; `procurement` -> analyst notes/updates; `primaryRequirement` -> requirement.
- `solicitationNumber` -> solicitation/RFP/RFI/sources-sought identifier; `solicitationDate.value` -> solicitation date; `responseDate` (where present) -> response deadline; `firstActionDate`, `lastActionDate`, `createdDate`, `updateDate` -> lifecycle/sync timestamps.
- `govEntity.id/title` -> buying/contracting organization; `country`; `placeOfPerformance` -> place fields; `primaryNAICS`, `additionalNaics`, `classificationCodeDesc`, `competitionTypes`, `contractTypes`, `typeOfAward` -> classification and set-aside/award metadata.
- `oppValue` -> estimated value (documented in thousands of dollars); `duration`; `sourceURL`; `projectId`; `programActivity`; `cfda`; `cmmcRequirements`; `priority` -> corresponding normalized fields.
- Related documents/FBO notices -> attachment records using their IDs, title, publication date, URL/download URL, filename, type, source, and external flag. Store the raw response and links because external links may not be retrievable through GovWin.
- `modifications[]` -> amendment/change records using `modNum`, action type/date, description, amount, project ID, and created/last-modified timestamps.

The schema includes fields useful for RFP/RFI/Sources Sought classification, but the WSAPI does not expose a documented universal `notice_type` value named exactly RFP/RFI/Sources Sought. Use `type`, `procurementNoticeType`, `solicitationNumber`, title/description, source notice metadata, and (for SAM notices) classification/source data; preserve raw fields for later rule updates. The glossary explicitly says solicitation numbers can represent Pre-Solicitation, Sources Sought, or Market Survey numbers. [1]

## Limits, terms, and unavailable capabilities

- **Rate limit:** 4,000 calls per rolling 60 minutes across the entire organization and all WSAPI call types. Fetching one opportunity and all related content typically consumes 6–12 calls, so the limit is not equivalent to 4,000 opportunities/hour. HTTP 403 is documented for too many requests. [1]
- **Authorization/subscription:** HTTP 403 can mean an expired/missing product subscription or incorrectly configured Web Service access. HTTP 401 is invalid/expired token. The official integration help requires a GovWin Web Service subscription and username/password. [1] [2]
- **Pagination/system limits:** page `max` <= 100; system `offset + max` <= 10,000 (documented current `systemLimit=10,000`); HTTP 422 for invalid range/offset/sort. [1]
- **Read-only scope:** Most calls are GET/retrieval, but the API also exposes mutating marking calls (`setMark`, `clearMark`, `clearMarkAll`). A platform integration should not call those; they mutate account/user state. [1]
- **Commercial terms:** The public PDF is a quick reference, not an open-license data grant. Deltek's product page presents GovWin IQ as a subscription/request-demo product and says its analyst-validated coverage includes U.S. Federal, SLED, and Canada markets. Do not redistribute GovWin records/documents without confirming the customer's license and data-use terms. [1] [3]
- **No public test credential:** No credential was requested or created. No public read-only test endpoint was found. The documented API requires OAuth credentials. Public web pages exist, but they are HTML pages and not a supported API/feed.

## Observed safe HTTP results (no credentials, no mutation)

On 2026-10-12, unauthenticated GET requests returned:

- `GET https://services.govwin.com/neo-ws/opportunities?oppType=FBO&max=1` -> **HTTP 401**, `application/json`, body `{"error":"unauthorized","error_description":"Full authentication is required to access this resource"}`.
- `GET https://services.govwin.com/neo-ws/opportunities/OPP12345` -> **HTTP 401** with the same authentication-required response.
- `GET https://services.govwin.com/neo-ws/oauth/token` -> **HTTP 401**; no credentials were sent and no token attempt was made.
- A public sample tag page, `GET https://iq.govwin.com/neo/public/tag/.../Mapping%20services` -> **HTTP 200**, HTML. This confirms a public marketing/sample page, not anonymous WSAPI data access; it is unsuitable as a stable structured feed.

## References

[1]: https://dsm.deltek.com/DeltekSoftwareManagerWebServices/downloadFile.ashx?documentid=8F8FF9D6-7B49-4607-945B-CB3C4D28DC64 "Deltek GovWin Web Service API V3 (WSAPI) Quick Reference, March 11, 2025"
[2]: https://help.deltek.com/product/GovWinCM/7.4/GA/UT_Set_up_the_Web_INPUT_Service.html "Deltek Help: Set Up the GovWin IQ Web Service"
[3]: https://www.deltek.com/products/govwin/ "Deltek GovWin IQ product page"
[4]: https://iq.govwin.com/neo/home "GovWin IQ public home page"
