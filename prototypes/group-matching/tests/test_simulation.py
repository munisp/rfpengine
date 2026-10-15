#!/usr/bin/env python3
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import simulation as sim


class SimulationTests(unittest.TestCase):
    def notice(self, source="sam", external_id="N-1"):
        return sim.make_notice(source, {
            "external_id": external_id, "title": "Cloud migration", "buyer": "Buyer",
            "country": "United States", "type": "RFP", "notice_status": "Open",
            "posted_at": "2026-10-01", "due_date": "2026-11-15",
            "description": "Cloud migration scope", "naics": ["541512"],
            "capabilities": ["cloud migration"], "value": "500000", "currency": "USD",
        })

    def profile(self, profile_id="p1"):
        return {
            "id": profile_id, "legal_entity": "One LLC", "active": True,
            "capabilities": ["cloud migration"], "naics": ["541512"], "cpv": [],
            "geographies": ["United States"], "preferred_buyers": ["Buyer"],
            "statuses": [{"name": "small business", "valid_until": "2027-01-01", "attested": True}],
            "certifications": [{"name": "ISO 27001", "valid_until": "2027-01-01", "approved": True}],
            "min_value": "0", "max_value": "0", "currency": "USD",
            "capacity": "available", "capacity_verified": True,
            "evidence": [{"id": "e1", "category": "past performance", "owner_profile_id": profile_id, "approved": True, "text": "proof"}],
        }

    def reviewed(self, notice):
        result = copy.deepcopy(notice)
        result.update({"eligibility_reviewed": True, "required_statuses": [], "required_certifications": [], "imported_attachment_names": [], "review_state": "REVIEWED_DEMO_OVERLAY"})
        return result

    def test_idempotent_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            store, events = sim.Store(Path(temp)), []
            try:
                notice = self.notice()
                self.assertEqual(store.ingest(notice, "2026-10-12", events, "initial"), "inserted")
                self.assertEqual(store.ingest(notice, "2026-10-12", events, "duplicate"), "duplicate")
                self.assertEqual(store.current()[0]["version"], 1)
                self.assertEqual([event["kind"] for event in events], ["inserted", "duplicate"])
            finally:
                store.close()

    def test_amendment_stales_manual_review(self):
        with tempfile.TemporaryDirectory() as temp:
            store, events = sim.Store(Path(temp)), []
            try:
                notice = self.notice()
                store.ingest(notice, "2026-10-12", events, "initial")
                store.apply_reviews([{"source": "sam", "external_id": "N-1", "reviewed": True}], {"sam:N-1"}, "2026-10-12", events)
                amended = copy.deepcopy(notice)
                amended["title"] = "Cloud migration amendment"
                self.assertEqual(store.ingest(amended, "2026-10-12", events, "amendment"), "amended")
                current = store.current()[0]
                self.assertEqual(current["version"], 2)
                self.assertIsNone(current["manual_review"])
                self.assertTrue(current["review_stale"])
                self.assertTrue(events[-1]["manual_eligibility_review_stale"])
            finally:
                store.close()

    def test_source_namespace_keeps_same_external_id_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            store, events = sim.Store(Path(temp)), []
            try:
                store.ingest(self.notice("sam", "same"), "2026-10-12", events, "initial")
                store.ingest(self.notice("ted", "same"), "2026-10-12", events, "initial")
                self.assertEqual([(n["source"], n["external_id"]) for n in store.current()], [("sam", "same"), ("ted", "same")])
            finally:
                store.close()

    def test_evidence_isolation_does_not_count_other_entity_evidence(self):
        profile = self.profile("p1")
        profile["evidence"][0]["owner_profile_id"] = "p2"
        result = sim.score(profile, self.reviewed(self.notice()), "2026-10-12")
        self.assertEqual(result["components"]["evidence"], 0)
        self.assertIn("No approved company-owned evidence is available for drafting.", result["unknowns"])

    def test_certification_expiry_is_fail_not_unknown(self):
        profile = self.profile()
        profile["certifications"][0]["valid_until"] = "2026-11-01"
        notice = self.reviewed(self.notice())
        notice["required_certifications"] = ["ISO 27001"]
        result = sim.score(profile, notice, "2026-10-12")
        self.assertEqual(result["eligibility"], "FAIL")
        self.assertTrue(any("does not remain valid" in item for item in result["blockers"]))

    def test_raw_stage_is_unreviewed_and_unknown(self):
        raw = sim.materialize_notice(dict(self.notice(), manual_review={"reviewed": True}), raw=True)
        result = sim.score(self.profile(), raw, "2026-10-12")
        self.assertEqual(raw["review_state"], "UNREVIEWED")
        self.assertEqual(result["eligibility"], "UNKNOWN")
        self.assertIn("Mandatory eligibility requirements have not been reviewed.", result["unknowns"])

    def test_group_conflict_requires_same_entity_predicate_and_temporal_overlap(self):
        base = {"entity_id": "vendor", "predicate": "tier", "profile_id": "p1", "value": "gold", "valid_from": "2026-10-01", "valid_to": "2026-10-31", "id": "a", "source_span": "a"}
        later = dict(base, id="b", source_span="b", profile_id="p2", value="not-approved", valid_from="2026-11-01", valid_to="2026-11-30")
        self.assertEqual(sim.group_risks({"facts": [base, later]}), [])
        later["valid_from"] = "2026-10-20"
        risks = sim.group_risks({"facts": [base, later]})
        self.assertEqual(risks[0]["code"], "CONTRADICTORY_STRUCTURED_FACT")
        self.assertEqual({source["fact_id"] for source in risks[0]["sources"]}, {"a", "b"})

    def test_overlapping_capabilities_are_not_a_group_conflict(self):
        # Capability labels can overlap legitimately. The structured guard has no
        # free-text/capability conflict inference path.
        prototype = {"capability_claims": [{"profile_id": "p1", "label": "cloud migration"}, {"profile_id": "p2", "label": "cloud migration"}]}
        self.assertEqual(sim.group_risks(prototype), [])

    def test_js_round_positive_half_up(self):
        self.assertEqual(sim.js_round_positive(12.5), 13)
        self.assertEqual(sim.js_round_positive(0.5), 1)
        profile = self.profile()
        profile["capabilities"] = ["cloud migration", "platform", "security"]
        no_structured_labels = self.reviewed(self.notice())
        no_structured_labels["capabilities"] = []
        result = sim.score(profile, no_structured_labels, "2026-10-12")
        self.assertEqual(result["components"]["capabilities"], 13)

    def test_builtin_scenario_has_group_risks_and_preserves_ids(self):
        profiles, prototype = sim.load_profiles(ROOT / "fixtures" / "profiles.json", 50)
        risks = sim.group_risks(prototype)
        self.assertEqual(len(profiles), 3)
        self.assertEqual({risk["code"] for risk in risks}, {"CONTRADICTORY_STRUCTURED_FACT", "SHARED_RESOURCE_DOUBLE_BOOKING", "EVIDENCE_OWNERSHIP_BLOCK"})
        self.assertTrue(all(risk["sources"] for risk in risks))



class NativeMappingRegressionTests(unittest.TestCase):
    notice = SimulationTests.notice
    profile = SimulationTests.profile
    reviewed = SimulationTests.reviewed
    def test_sam_psc_and_award_are_not_bid_requirements_or_estimate(self):
        rows = sim.map_sam({'opportunitiesData': [{'noticeId': 'n', 'title': 'Sample', 'type': 'Solicitation', 'active': 'Yes', 'classificationCode': 'D302', 'description': 'https://example.invalid/description', 'award': {'amount': '900000', 'currency': 'USD'}}]}, '2026-10-12', 100)
        self.assertEqual(rows[0]['notice_status'], 'Open')
        self.assertEqual(rows[0]['capabilities'], [])
        self.assertIsNone(rows[0]['value'])
        self.assertEqual(rows[0]['description'], '')

    def test_different_claim_scopes_do_not_create_contradiction(self):
        left = {'entity_id': 'entity', 'predicate': 'capacity', 'value': '12', 'scope': 'UK delivery', 'valid_from': '2026-01-01', 'valid_to': '2026-12-31'}
        right = dict(left, value='20', scope='EU delivery')
        self.assertEqual(sim.group_risks({'facts': [left, right]}), [])

    def test_long_notice_phrase_fit_is_not_silently_truncated(self):
        n = self.reviewed(self.notice()); n['capabilities'] = []; n['title'] = 'Engineering support'; n['description'] = 'Introductory context ' * 30 + 'cloud migration services'
        self.assertEqual(sim.score(self.profile(), n, '2026-10-12')['components']['capabilities'], 40)

    def test_malformed_profile_money_cannot_silently_be_unbounded(self):
        p = self.profile(); p['max_value'] = 'not money'
        result = sim.score(p, self.reviewed(self.notice()), '2026-10-12')
        self.assertEqual(result['eligibility'], 'UNKNOWN')
        self.assertTrue(any('malformed' in msg for msg in result['unknowns']))

if __name__ == "__main__":
    unittest.main()
