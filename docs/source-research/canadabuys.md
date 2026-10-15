# CanadaBuys open tender data

**Source ID:** `canadabuys`
**Source name:** CanadaBuys tender opportunities and CanadaBuys tender notices open-data dataset (Public Services and Procurement Canada / Government of Canada)

## Finding

CanadaBuys provides a **public, read-only CSV feed**, not a documented JSON tender API. The practical synchronization interface is the official open-data CSV collection. It requires no account, API key, or authentication. The CanadaBuys portal itself also exposes public HTML search and notice-detail pages. The Open Government Portal’s CKAN API is useful for discovering current resource URLs and metadata, but it is **catalog metadata**, not a query API for individual tenders.

The authoritative dataset is federal-only, even though the CanadaBuys website also displays opportunities from other levels of government. [1] The dataset is licensed under the Open Government Licence – Canada; commercial reuse is permitted subject to attribution and exclusions described below. [2]

## Implementable public endpoints

Use these as full-file snapshots and periodically diff/upsert locally:

```text
GET https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv
GET https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv
GET https://canadabuys.canada.ca/opendata/pub/tenderNoticeComplete-avisAppelOffresComplet.csv
GET https://canadabuys.canada.ca/opendata/pub/YYYY-YYYY-TenderNotice-AvisAppelOffres.csv
GET https://canadabuys.canada.ca/opendata/pub/2009-2022-tenderNoticeHistorical-AvisAppelOffresHistorique.csv
```

The first two and the complete/current fiscal-year resources are linked from the official dataset record. [1] The exact URL for the all-notices file is shown in that record as `tenderNoticeComplete-avisAppelOffresComplet.csv`; the page labels it “All CanadaBuys tender notices, 2022-08-08 onwards.” [1]

**HTTP parameters/pagination:** The CSV resources are static downloads. Official documentation specifies no query parameters, cursor, page size, delta token, ETag protocol, or pagination for these files. A consumer should download the snapshot and reconcile by solicitation number plus amendment number/date. The CanadaBuys HTML search page is separate: the observed/public URL supports parameters such as `words`, `items_per_page` (`50`, `100`, or `200`), `page`, `order`, `sort`, `current_tab`, and filter arrays such as `status[0]`; this is an HTML presentation/search interface, not an official API contract. [3] The official search guide documents keyword, exact-title/solicitation-number, organization, trade-agreement, UNSPSC/GSIN, status/category/location/date filters and sorting, but does not document a machine API. [4]

**Metadata discovery endpoint (not tender query):**

```text
GET https://open.canada.ca/data/api/action/package_show?id=6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2
```

This public CKAN endpoint returns the dataset record and resource URLs. [1]

## Refresh and synchronization behavior

- **New tender notices:** updated every two hours from 06:15 through 22:15, UTC−05:00. It contains notices published that day (or the previous day where an upstream system feeds nightly). [1] [5]
- **Open tender notices:** refreshed each morning between 07:00 and 08:30, UTC−05:00; all rows have status `Open`; amendments during the tender lifecycle are included. [1]
- **Complete/current CanadaBuys notices:** refreshed each morning between 07:00 and 08:30, UTC−05:00; includes records open on or after 2022-08-08 and statuses `Open`, `Cancelled`, or `Expired`, including amendments. [1]
- **Fiscal-year files:** the current fiscal year is refreshed daily in that morning window; past fiscal-year files are refreshed monthly. New records move into the relevant file after closing or cancellation. New fiscal-year files are added on April 1. [1]
- **Legacy 2009–2022 file:** monthly; historical records are transformed into the newer structure and mappings are not perfect. [1]
- Source systems are not synchronized in real time. For example, SAP Ariba notices may appear the following day; ABE award notices can lag up to a month. [5] The official search guide also says NATO notices have a 24-hour CanadaBuys delay and the NSPA portal is authoritative for those notices. [4]

For continuous sync, poll the new feed during its stated windows and the open/complete feed daily, retain the prior snapshot, and treat changed amendment fields as updates rather than new solicitations. There is no official incremental API or webhook documented in the sources reviewed.

## Schema and mapping

The downloaded open CSV is UTF-8 CSV with **67 columns** and bilingual columns in one row. The official dictionary is the schema authority: [6]

- **Identity:** `solicitationNumber-numeroSollicitation` (preferred cross-file key per the official guide), `referenceNumber-numeroReference`, and `amendmentNumber-numeroModification`.
- **Human-facing content:** `title-titre-eng`, `title-titre-fra`, `tenderDescription-descriptionAppelOffres-eng/fra`.
- **Dates:** `publicationDate-datePublication`, `tenderClosingDate-appelOffresDateCloture`, `amendmentDate-dateModification`, `expectedContractStartDate-dateDebutContratPrevue`, `expectedContractEndDate-dateFinContratPrevue`. Closing timestamps are UTC−05:00 in the new datasets. [5]
- **Lifecycle:** `tenderStatus-appelOffresStatut-eng/fra` (`Open`, `Cancelled`, `Expired`), `amendmentType-typeModification-eng/fra` where present, and `amendmentNumber`/`amendmentDate`.
- **RFP/RFI classification:** `noticeType-avisType-eng/fra`. The dictionary explicitly defines `Request for Information` and `Request for Proposal`; the portal’s public notice-type filter additionally exposes Future Business Opportunities, Notifications of Intent, Request for Supply Arrangement, Request for Standing Offer, RFP against Supply Arrangement, Invitation to Qualify, Directed Contract, Advance Contract Award Notice, and Other. [3] [6]
- **Category/classification:** `procurementCategory-categorieApprovisionnement` (`CNST`, `GD`, `SRV`, `SRVTGD`), `gsin-nibs`, `gsinDescription-nibsDescription-eng/fra`, `unspsc`, `unspscDescription-eng/fra`.
- **Organization and geography:** bilingual contracting entity name/address fields, `endUserEntitiesName-nomEntitesUtilisateurFinal-eng/fra`, `regionsOfOpportunity-regionAppelOffres-eng/fra`, and `regionsOfDelivery-regionsLivraison-eng/fra`.
- **Contact:** `contactInfoName-informationsContactNom`, `contactInfoEmail-informationsContactCourriel`, `contactInfoPhone-contactInfoTelephone`, `contactInfoFax`, and bilingual address fields.
- **External/details:** `noticeURL-URLavis-eng/fra`, `attachment-piecesJointes-eng/fra`, and bilingual tender description.

The official guidance says to link records across datasets using the solicitation number, because reference numbers are not consistent in all historical records. [5]

## Attachments and amendments

Attachments are available in the feed when supplied through `attachment-piecesJointes-eng/fra`; the dictionary defines this as a link to extra material such as charts, tables, or diagrams. `noticeURL-URLavis-eng/fra` may link to another procurement system and can be blank; the description or attachment field may contain additional URLs. [6]

The public detail page is a useful fallback/read-only enrichment endpoint:

```text
GET https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/{notice-id}
```

A public test succeeded for `cb-731-64131569` and returned HTTP 200 without login. It exposed solicitation number, publication/closing/last-amendment dates, status, notice type, description, contracting authority, and a document table with amendment number, language, date added, and direct PDF/XLSX attachment links. [7] The page explicitly says tender/award notices, solicitation documents, and attachments are free and fully accessible without registering. [7]

Important legal distinction: the notice data carry the Open Government Licence, but related solicitation documents and tender attachments are copyright-protected and governed by the Government of Canada terms. Do not assume the data licence permits republishing attachment contents. [7]

## Access, terms, and limits

No credential is needed for the CSV, CKAN metadata, HTML search, detail pages, or publicly linked files in the read-only checks performed. No registration was attempted. The dataset is published under the Open Government Licence – Canada, which allows copying, modification, publication, translation, adaptation, distribution, and commercial use with source attribution. The licence excludes personal information, third-party rights the provider cannot license, official names/crests/logos/symbols, and other rights such as trademarks; it provides no warranty and does not permit implying government endorsement. [2]

The official dataset warns that long descriptions can create apparent spill-over rows in spreadsheet software; parsers should use a real CSV parser and not Excel’s visual rendering. [1] The CSV files are full snapshots and can be large; no official rate limit, SLA, conditional-request guarantee, or API quota is documented in the reviewed primary sources. Respect normal HTTP caching/backoff and avoid high-frequency polling. The portal’s displayed search corpus includes multiple government levels, while this open-data collection is federal-only. [1]

## Observed read-only HTTP results

Checked without authentication and without mutating any external system:

- `GET https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv` → **HTTP 200**, `application/octet-stream` (observed download 2,904 bytes at check time).
- `GET https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv` → **HTTP 200**, `application/octet-stream` (observed download 6,360,099 bytes; parsed as 67-column CSV).
- `GET https://donnees-data.tpsgc-pwgsc.gc.ca/ba2/ac-cb/achatscanada-canadabuys-dd.xml` → **HTTP 200**, `text/xml` (observed 60,478 bytes).
- CKAN `package_show` endpoint → **HTTP 200**, JSON.
- Public tender detail page above → **HTTP 200**, HTML.

## References

[1]: https://open.canada.ca/data/en/dataset/6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2 "CanadaBuys tender notices — Open Government Portal dataset record"
[2]: https://open.canada.ca/en/open-government-licence-canada "Open Government Licence – Canada"
[3]: https://canadabuys.canada.ca/en/tender-opportunities "Tender opportunities — CanadaBuys"
[4]: https://canadabuys.canada.ca/en/support/searching-tender-opportunities "Searching for tender opportunities on CanadaBuys"
[5]: https://donnees-data.tpsgc-pwgsc.gc.ca/ba2/ac-cb/soutien-support-eng.html "Supporting documentation — Understanding the new CanadaBuys tender and award notices datasets"
[6]: https://donnees-data.tpsgc-pwgsc.gc.ca/ba2/ac-cb/achatscanada-canadabuys-dd.xml "CanadaBuys data dictionary XML"
[7]: https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/cb-731-64131569 "Public CanadaBuys tender notice example — Long Term Interpreter Agency - IRB"
