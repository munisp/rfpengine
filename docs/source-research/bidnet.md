# BidNet Direct procurement opportunity source

**Research date:** 2026-10-12. **Source ID:** `bidnet-direct`
**Source name:** BidNet Direct (SOVRA / formerly MDF Commerce)

## Finding

BidNet Direct does **not publicly document a read API, data-feed endpoint, OpenAPI specification, webhook, or export schema for opportunity discovery**. The official public surface is an HTML search/listing website. Search results and individual solicitation pages can be read without an account in the browser-facing public pages, but the accessible data is incomplete for some opportunities and access is package/account-gated. Do not infer an API from third-party scrapers or from solicitation titles containing “API.”

The official website advertises over 25,000 daily open bids and over 90,000 government agencies, but it also says that “thousands of additional open solicitations are delivered to registered suppliers daily.” [1] The vendor-plan page makes the commercial boundary explicit: Basic ($0) covers **Member Agency** bids; aggregated State & Local opportunities require paid Local/Regional/National plans, and Federal is an add-on. [2]

## Public endpoint that was verified

The implementable, credential-free endpoint is an HTML page, not an API:

```text
GET https://www.bidnetdirect.com/public/solicitations/open
GET https://www.bidnetdirect.com/public/solicitations/open?keywords=Construction
GET https://www.bidnetdirect.com/solicitations/open-bids/page2?keywords=Construction
```

Observed in the official browser-readable page [3]: `?keywords=Construction` returned **4,581 results**; the page exposed numbered pagination and a next-page link `.../solicitations/open-bids/page2?keywords=Construction`. The unfiltered listing exposed **24,735 results** and pages 1–400. The filter/search URL is the only documented public query parameter found. The page exposes no published page-size, cursor, offset, rate-limit, or JSON response contract. The page's visible result links are canonical solicitation URLs, for example:

```text
https://www.bidnetdirect.com/{state-or-buying-group}/solicitations/open-bids/{slug}/{numeric-id}?origin=0&target=view
```

Some member-agency records use a shorter path and an agency-local number, e.g. `/.../solicitations/open-bids/{slug}/0000439919?origin=0`.[3]

**Observed direct HTTP test from this sandbox (no credentials, no cookies):** Python `requests.get` to all five public URLs (listing, page 2, keyword search, terms, and an attachment URL) returned `403 Forbidden`, `Content-Type: text/html`, `Content-Length: 118`, server `awselb/2.0`. The browser-readable/fetch view could render the same public pages, so a production sync must treat direct automated HTTP access as blocked/unstable and must not bypass it. No public JSON endpoint or credential-free API test was observed.

## Mapping available from public HTML

A parser for the public listing can map each result row as follows:

- **`title`**: linked solicitation title.
- **`location`**: location text immediately following the title (state/territory or buying-group label).
- **`published_at`**: “Published” date shown in the row.
- **`closing_at`**: “Closing” date shown in the row; rows also show a human-readable days-left value.
- **`source_record_id`**: trailing numeric identifier shown in the row and embedded in the detail URL. Member-agency records may show a separate `0000...` local identifier.
- **`detail_url`**: the result hyperlink; retain it as the stable source URL.
- **`status`**: derive `open` from the open-list route; use the separate official closed-list route for closed records: `https://www.bidnetdirect.com/solicitations/closed-bids`.[1]
- **`description`**, **`issuing_organization`**, and **`solicitation_number`**: detail-page fields where exposed. On the verified detail page, `Location`, `Publication Date`, `Closing Date`, `Issuing Organization`, `Solicitation Number`, `Description`, and `Source` were present.[4]
- **`type`**: do not assume RFP/RFI/Sources Sought from the route; classify from title/description/solicitation text only. No official normalized procurement-type field or schema was published.

The verified detail page [4] had a concrete example: title “Invitation for Bid: Army National Guard Military Construction, Engineering/Housing Maintenance Shop, Camp Santiago, Salinas, PR,” publication `05/12/2026 11:30 AM EDT`, closing `06/25/2026 02:00 PM EDT`, and an issuing organization displayed as **“Locked Registered members only.”** Its source linked to SAM.gov, demonstrating that BidNet may mirror/link an upstream federal notice rather than own the authoritative record.

## Attachments, amendments, and communications

Attachments are visibly available for at least some public/member-agency records through a URL pattern such as:

```text
GET https://www.bidnetdirect.com/public/attachments/{attachment-group-id}/view-attachment?id={attachment-id}
```

A credential-free browser fetch of an official attachment URL returned the full 13-page procurement PDF text (Town of Brookhaven “Street Sweeper Parts,” Bid 24031), proving that **some** attachment objects are publicly readable.[5] This is not a documented API: the response is a rendered/downloadable document and there is no published attachment-list endpoint or schema.

The official Electronic Bid Submission guide says BidNet distributes “solicitations, documents, and addendum.” It instructs suppliers to review the solicitation’s **addendum and communication tab**, download existing documents/addenda, and follow a solicitation to be alerted to “ANY addendum or communication.” It also says vendors must be registered to participate in electronic bid submission.[6] Therefore, a sync data model should support `attachments[]`, `amendments[]`, `communications[]`, and document URLs, but the public pages do not guarantee those collections are exposed without registration.

The verified detail page [4] displayed multiple amendment/update narratives, including RFI-driven changes, revised attachments, and an “Abstract of Bidders” attachment update, but it also showed access gating (“Locked Registered members only”) for issuing organization and solicitation number. The page linked the official SAM.gov source and stated that amendments for that federal notice would be posted on SAM.gov. Treat upstream links as authoritative when present.

## Access, terms, and practical limits

- **No account / public read:** public listing, selected detail pages, and some attachment URLs rendered in the browser/fetch test. This is read-only observation; no registration, login, download automation at scale, or mutation was performed.
- **Account / paid access:** official plan page says Basic is free but limited to Member Agency opportunities; Local, Regional, and National plans are paid for aggregated State & Local coverage; Federal is separately priced. [2]
- **Registration required for response:** the official EBS guide states vendors “must be registered” to participate in EBS, and re-enter their password to submit.[6]
- **Terms:** official Terms & Conditions page exists at [7] and lists acceptance, registration/member information, renewal/cancellation, service fees, username/password protection, limited copyright license, member-information use, warranties/disclaimers, and member obligations. The page did not expose a public API/feed license or an automated-crawling allowance in the content available to this research; obtain written permission/contract terms before operating a continuous scraper.
- **HTTP protection:** direct no-cookie requests in this environment returned 403 from the AWS load balancer for all tested public URLs. Do not circumvent CAPTCHA, WAF, authentication, or rate controls. A continuously syncing product cannot safely promise coverage from this surface without an approved commercial data-access arrangement or first-party feed.
- **Coverage/authority:** BidNet aggregates member, state/local, and federal opportunities. Coverage is plan-dependent; some records point to an upstream source (e.g., SAM.gov). Closed/open listings are separate HTML pages, and no incremental “updated since” or change-feed parameter was documented.
- **No published limits:** no official requests-per-minute, page-size, pagination contract, retention, attachment size, or API quota was found. The visible listing has roughly 25 rows per page and numbered pages, but page size should not be treated as contractual.

## Official URLs

[1]: https://www.bidnetdirect.com/ "BidNet Direct homepage and public bid-search links"
[2]: https://www.bidnetdirect.com/vendor-solutions "BidNet Direct vendor plans and access tiers"
[3]: https://www.bidnetdirect.com/public/solicitations/open?keywords=Construction "BidNet Direct public keyword search and pagination"
[4]: https://www.bidnetdirect.com/puerto-rico/solicitations/closed-bids/statewide/Invitation-for-Bid-Army-National-Guard-Military-Construction-Engineering-Housing-Maintenance-Shop-Camp-Santiago-Salinas-PR/2690237552 "BidNet Direct public solicitation detail with gated fields, amendments, and source link"
[5]: https://www.bidnetdirect.com/public/attachments/9233428497/view-attachment?id=9233559693 "BidNet Direct public attachment viewer"
[6]: https://communications.bidnet.com/electronic-bid-submission-user-guide "BidNet Direct Electronic Bid Submission User Guide"
[7]: https://www.bidnetdirect.com/tsandcs "BidNet Direct Terms and Conditions"
