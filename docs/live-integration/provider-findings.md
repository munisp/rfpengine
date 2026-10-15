# Live provider interfaces

Verified 2026-10-13.

SAM.gov Get Opportunities Public API requires a user API key. The documented v2 search parameters include required postedFrom/postedTo (MM/dd/yyyy), limit up to 1000, and offset described as a zero-based page index. The adapter must retain the actual pagination response, use overlap windows for amendments and never treat PSC classificationCode or award.amount as an open solicitation capability/estimate. [1]

TED exposes POST /v3/notices/search for published notices and does not require authentication. Use its published OpenAPI contract for fields and pagination; a search-result description does not replace the full solicitation. [2]

IAF CertSearch offers a verifier API with keyed enterprise access. The public service page advertises it but does not supply the licensed query endpoint/schema used by a verifier account. Its public certification-body API documentation is for a different actor and cannot be assumed to be a verifier integration. Do not invent a path or use upload endpoints. This implementation supports an operator-supplied authorized verifier contract, with exact field mappings, explicit identity checks and blocked activation when credentials/contract are absent. [3] [4]

No SAM credential or contracted certificate-verifier endpoint is configured in this session. No paid access, account registration, purchase or external coordination has been performed.

## References

[1]: https://open.gsa.gov/api/get-opportunities-public-api/ "GSA — SAM.gov Get Opportunities Public API"
[2]: https://docs.ted.europa.eu/api/latest/search.html "TED — Search API"
[3]: https://www.iafcertsearch.org/services/api-certificate-search "IAF CertSearch — Verifier API/SaaS integration"
[4]: https://support.iafcertsearch.org/api-developer-guide/api-integration/certification-body-apis "IAF — Certification Body APIs (not a verifier contract)"
