#!/usr/bin/env python3
import copy
import json
import tempfile
import unittest
from pathlib import Path

import engine

ROOT = Path(__file__).resolve().parent
BASE = json.loads((ROOT / "sample_scenario.json").read_text())


def scenario():
    return copy.deepcopy(BASE)


def result(data, **kwargs):
    return engine.run(data, "2026-10-12", **kwargs)


class CertificateAndClaimTests(unittest.TestCase):
    def test_scoped_multisite_certificate_is_verified_input(self):
        r = result(scenario())
        cert = next(x for x in r["certifications"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cert["status"], "APPLICABLE_VERIFIED_INPUT")
        self.assertIn("organization management-system certificate", cert["statement"])
        self.assertNotIn("independently certified", cert["statement"].split("does not")[0])

    def test_uncertified_subsidiary_is_review_not_inherited(self):
        r = result(scenario())
        cert = next(x for x in r["certifications"] if x["entityID"] == "AtlasEurope")
        self.assertEqual(cert["status"], "REVIEW_REQUIRED")
        self.assertIn("NO_EXPLICIT_ENTITY_SCOPE_COVERAGE", cert["reasonCodes"])

    def test_expired_certificate_returns_not_applicable(self):
        d = scenario(); d["certifications"][0]["expiryDate"] = "2026-10-17"
        cert = next(x for x in result(d)["certifications"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cert["status"], "NOT_APPLICABLE")

    def test_future_required_period_must_be_covered(self):
        d = scenario(); d["entities"][0]["certificationRequirement"]["requiredThrough"] = "2028-01-01"
        cert = next(x for x in result(d)["certifications"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cert["status"], "NOT_APPLICABLE")

    def test_issuer_freshness_is_limited_to_thirty_days(self):
        d = scenario(); d["certifications"][0]["checkedDate"] = "2026-09-11"
        cert = next(x for x in result(d)["certifications"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cert["status"], "REVIEW_REQUIRED")
        self.assertIn("ISSUER_VERIFICATION_NOT_FRESH_30_DAYS", cert["reasonCodes"])

    def test_unknown_credential_scheme_is_review_required(self):
        d = scenario(); d["entities"][0]["certificationRequirement"]["scheme"] = "UNLISTED_SCHEME"
        cert = next(x for x in result(d)["certifications"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cert["status"], "REVIEW_REQUIRED")
        self.assertIn("UNKNOWN_POLICY_SCHEME", cert["reasonCodes"])

    def test_duplicate_claims_are_collapsed_but_ids_preserved(self):
        claims = engine.assess_claims(scenario(), {}, {})
        self.assertEqual(len(claims["duplicates"]), 1)
        self.assertEqual(set(claims["duplicates"][0]), {"CLAIM-1", "CLAIM-1-DUPLICATE-EVIDENCE"})

    def test_unit_difference_is_not_a_conflict_or_conversion(self):
        d = scenario(); d["claims"] = [
            {"claimID": "A", "entityID": "AtlasCloud", "predicate": "capacity", "scope": {}, "unit": "HOURS", "value": 8, "validFrom": "2026-01-01", "validThrough": "2026-12-31"},
            {"claimID": "B", "entityID": "AtlasCloud", "predicate": "capacity", "scope": {}, "unit": "PERSONS", "value": 2, "validFrom": "2026-01-01", "validThrough": "2026-12-31"}]
        self.assertEqual(engine.assess_claims(d, {}, {})["status"], "CLEAR")

    def test_nonoverlapping_scope_is_not_a_conflict(self):
        d = scenario(); d["claims"] = [
            {"claimID": "A", "entityID": "AtlasCloud", "predicate": "scope", "scope": {"siteIDs": ["US-VA-1"]}, "unit": "scope", "value": "YES", "validFrom": "2026-01-01", "validThrough": "2026-12-31"},
            {"claimID": "B", "entityID": "AtlasCloud", "predicate": "scope", "scope": {"siteIDs": ["US-TX-1"]}, "unit": "scope", "value": "NO", "validFrom": "2026-01-01", "validThrough": "2026-12-31"}]
        self.assertEqual(engine.assess_claims(d, {}, {})["status"], "CLEAR")

    def test_malformed_claim_date_holds_affected_candidate(self):
        d = scenario(); d["claims"] = [{"claimID": "BAD", "entityID": "AtlasCloud", "predicate": "scope", "scope": {}, "unit": "x", "value": "yes", "validFrom": "not-a-date", "validThrough": "2026-12-31"}]
        cloud = next(x for x in result(d)["candidates"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cloud["status"], "HOLD")

    def test_explicit_trusted_complete_supersession_resolves(self):
        d = scenario(); d["policy"]["trustedAuthorities"].append("Trusted")
        d["sources"] += [{"sourceID": "OLD", "authority": "Trusted", "signedIssuer": True}, {"sourceID": "NEW", "authority": "Trusted", "signedIssuer": True}]
        d["claims"] = [
            {"claimID": "OLD-C", "entityID": "AtlasCloud", "predicate": "scope", "scope": {"siteIDs": ["US-VA-1"]}, "unit": "scope", "value": "YES", "validFrom": "2026-01-01", "validThrough": "2026-12-31", "sourceID": "OLD"},
            {"claimID": "NEW-C", "entityID": "AtlasCloud", "predicate": "scope", "scope": {"siteIDs": ["US-VA-1"]}, "unit": "scope", "value": "NO", "validFrom": "2026-01-01", "validThrough": "2026-12-31", "sourceID": "NEW", "supersedesClaimID": "OLD-C", "supersededSourceID": "OLD"}]
        sc, originals = engine.source_catalog(d)
        assessed = engine.assess_claims(d, sc, d["policy"])
        self.assertEqual(assessed["status"], "CLEAR")
        self.assertEqual(assessed["suppressedClaimIDs"], ["OLD-C"])

    def test_confidence_never_resolves_conflicting_claims(self):
        d = scenario(); d["claims"] = [
            {"claimID": "A", "entityID": "AtlasCloud", "predicate": "scope", "scope": {}, "unit": "scope", "value": "YES", "validFrom": "2026-01-01", "validThrough": "2026-12-31", "confidence": 0.99},
            {"claimID": "B", "entityID": "AtlasCloud", "predicate": "scope", "scope": {}, "unit": "scope", "value": "NO", "validFrom": "2026-01-01", "validThrough": "2026-12-31", "confidence": 0.01}]
        self.assertEqual(engine.assess_claims(d, {}, {})["status"], "HOLD")


class AllocationAndLeadTests(unittest.TestCase):
    def test_alternative_explicit_resource_resolves_shared_hours(self):
        plan = result(scenario())["resourcePlan"]
        self.assertEqual(plan["status"], "TENTATIVE_PROPOSAL")
        chosen = {x["requestID"]: x["resourceID"] for x in plan["allocations"]}
        self.assertEqual(chosen, {"REQ-ALPHA": "main-team", "REQ-BETA": "alt-team"})

    def test_insufficient_capacity_is_atomic_hold_not_partial_approval(self):
        d = scenario(); d["resources"] = d["resources"][:1]
        plan = result(d)["resourcePlan"]
        self.assertEqual(plan["status"], "HOLD")
        self.assertEqual(plan["allocations"], [])
        self.assertEqual(set(plan["proposedUnallocatedRequestIDs"]), {"REQ-ALPHA", "REQ-BETA"})

    def test_precommitted_reservation_is_enforced_even_same_entity(self):
        d = scenario(); d["existingReservations"] = [{"assignmentID": "COMMITTED-1", "requestID": "OLD", "resourceID": "main-team", "startDate": "2026-10-13", "endDate": "2026-10-15", "quantityHoursPerDay": 3}]
        plan = result(d)["resourcePlan"]
        self.assertEqual(plan["status"], "HOLD")
        self.assertEqual(plan["allocations"], [])

    def test_cross_entity_without_explicit_access_is_denied(self):
        d = scenario(); d["resources"] = d["resources"][1:]
        d["resources"][0]["entityAccess"] = []
        for q in d["requests"]: q["allowedResourceIDs"] = ["alt-team"]
        plan = result(d)["resourcePlan"]
        self.assertEqual(plan["status"], "HOLD")
        self.assertEqual(plan["reasonCode"], "INSUFFICIENT_ELIGIBLE_CAPACITY_OR_ACCESS")

    def test_conflicting_duplicate_assignment_id_rejected(self):
        d = scenario(); d["existingReservations"] = [
            {"assignmentID": "X", "requestID": "A", "resourceID": "main-team", "startDate": "2026-10-13", "endDate": "2026-10-14", "quantityHoursPerDay": 1},
            {"assignmentID": "X", "requestID": "B", "resourceID": "main-team", "startDate": "2026-10-13", "endDate": "2026-10-14", "quantityHoursPerDay": 2}]
        plan = result(d)["resourcePlan"]
        self.assertIn("CONFLICTING_DUPLICATE_ASSIGNMENT_ID:X", plan["errors"])

    def test_search_bound_hold_never_claims_insufficiency(self):
        d = scenario(); d["entities"] = []
        d["resources"] = [{"resourceID": "R" + str(i), "entityID": "E", "capacityHoursPerDay": 2, "skills": ["x"]} for i in range(5)]
        d["requests"] = [{"requestID": "Q" + str(i), "entityID": "E", "startDate": "2026-10-13", "endDate": "2026-10-14", "quantityHoursPerDay": 1, "requiredSkills": ["x"], "allowedResourceIDs": ["R0", "R1", "R2", "R3", "R4"]} for i in range(12)]
        plan = engine.plan_resources(d)
        self.assertEqual(plan["reasonCode"], "SEARCH_LIMIT")
        self.assertEqual(plan["allocations"], [])

    def test_stale_expected_hash_cannot_select_lead(self):
        d = scenario()
        r = result(d, lead="AtlasCloud", expected_hash="wrong")
        self.assertEqual(r["leadSelection"]["status"], "HOLD_STALE_OR_MISMATCHED_ASSESSMENT_HASH")

    def test_valid_manual_hash_selection_is_not_automatic(self):
        d = scenario(); first = result(d); h = first["metadata"]["assessmentHash"]
        second = result(d, lead="AtlasCloud", expected_hash=h)
        self.assertEqual(second["leadSelection"]["status"], "MANUAL_SELECTION_VALIDATED")
        self.assertEqual(second["leadSelection"]["actualLead"], "AtlasCloud")
        self.assertEqual(second["leadSelection"]["authentication"], "OFFLINE_UNAUTHENTICATED_SIMULATED")

    def test_unknown_eligibility_holds_candidate(self):
        d = scenario(); d["entities"][0]["eligibility"] = "UNKNOWN"
        cloud = next(x for x in result(d)["candidates"] if x["entityID"] == "AtlasCloud")
        self.assertEqual(cloud["status"], "HOLD")

    def test_review_role_fixture_is_checked_not_authenticated(self):
        d = scenario(); h = result(d)["metadata"]["assessmentHash"]
        with tempfile.TemporaryDirectory() as td:
            review = Path(td) / "review.json"
            review.write_text(json.dumps({"reviews": [{"type": "LEAD_SELECTION", "leadEntityID": "AtlasCloud", "assessmentHash": h, "reviewerRole": "NotAllowed", "signed": True}]}))
            r = engine.run(d, "2026-10-12", "AtlasCloud", h, str(review))
        self.assertEqual(r["leadSelection"]["status"], "HOLD_REVIEWER_ROLE_NOT_ALLOWED_FIXTURE")




class HardenedBoundaryTests(unittest.TestCase):
    def test_future_effective_certificate_cannot_pass(self):
        d=scenario(); d['certifications'][0]['effectiveDate']='2026-11-01'
        self.assertEqual(result(d)['certifications'][0]['status'], 'REVIEW_REQUIRED')

    def test_future_membership_verification_cannot_pass(self):
        d=scenario(); d['certifications'][0]['certifiedSystemMembershipVerifiedDate']='2027-01-01'
        self.assertEqual(result(d)['certifications'][0]['status'], 'REVIEW_REQUIRED')

    def test_entity_site_mapping_cannot_cross_join_parent_annex(self):
        d=scenario(); c=d['certifications'][0]
        c['scopeBindings']=[{'legalEntityID':'LE-ATLAS-CLOUD','siteIDs':['OTHER-SITE'],'activityScope':['CLOUD_HOSTING']}]
        self.assertEqual(result(d)['certifications'][0]['status'], 'REVIEW_REQUIRED')

    def test_unsupported_scheme_cannot_be_enabled_just_by_input_allowlist(self):
        d=scenario(); d['policy']['allowedCertificateSchemes'].append('SMALL_BUSINESS_STATUS')
        d['entities'][0]['certificationRequirement']['scheme']='SMALL_BUSINESS_STATUS'
        d['certifications'][0]['scheme']='SMALL_BUSINESS_STATUS'
        self.assertEqual(result(d)['certifications'][0]['status'], 'REVIEW_REQUIRED')

    def test_conflicting_source_ids_are_rejected(self):
        d=scenario(); d['sources'].append(dict(d['sources'][0], authority='Other'))
        with self.assertRaises(ValueError): result(d)

    def test_signed_flag_without_catalogued_source_cannot_supersede(self):
        d=scenario(); base=dict(d['claims'][0]); newer=dict(base, claimID='NEW', value='NOT-COVERED', sourceID='MISSING', authority='Accredited Certification Authority', signedIssuer=True, supersedesClaimID=base['claimID'], supersededSourceID=base['sourceID'])
        d['claims']=[base,newer]
        r=result(d)['claims']; self.assertEqual(r['status'],'HOLD'); self.assertEqual(r['suppressedClaimIDs'],[])

    def test_cyclic_supersession_cannot_suppress_every_source(self):
        d=scenario(); a=dict(d['claims'][0],claimID='A',sourceID='SRC-CERT-ATLAS',supersedesClaimID='B',supersededSourceID='SRC-ANNEX-ATLAS'); b=dict(a,claimID='B',value='NOT-COVERED',sourceID='SRC-ANNEX-ATLAS',supersedesClaimID='A',supersededSourceID='SRC-CERT-ATLAS')
        d['claims']=[a,b]; r=result(d)['claims']
        self.assertEqual(r['status'],'HOLD');self.assertEqual(r['suppressedClaimIDs'],[])

    def test_automatic_duplicate_link_is_audited(self):
        r=result(scenario()); self.assertTrue(any(x['record']['type']=='AUTO_LINK_EQUIVALENT_RECORDS' for x in r['audit']['auditChain']))

    def test_input_is_not_mutated_by_solver(self):
        d=scenario(); before=copy.deepcopy(d);result(d); self.assertEqual(d,before)

    def test_resource_interval_bound_returns_hold(self):
        d=scenario();d['requests'][0]['endDate']='2099-12-31'
        self.assertEqual(result(d)['resourcePlan']['status'],'HOLD')

if __name__ == '__main__':
    unittest.main(verbosity=2)
