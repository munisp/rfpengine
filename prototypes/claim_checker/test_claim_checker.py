import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import claim_checker as cc


HERE = Path(__file__).resolve().parent


def document(assertion, **overrides):
    result = {
        "id": "e1",
        "approved": True,
        "reference_only": False,
        "assertions": [dict({"id": "a1", "text": "evidence"}, **assertion)],
    }
    result.update(overrides)
    return result


def request(text="We provide support.", docs=None, constraints=None, bindings=None):
    return {
        "draft": {"text": text},
        "evidence_documents": docs if docs is not None else [],
        "bindings": bindings if bindings is not None else ([{"claim_index": 0, "evidence_id": "e1", "assertion_id": "a1"}] if docs else []),
        "constraints": constraints if constraints is not None else [],
    }


def one_check(data, as_of="2026-06-01"):
    result = cc.check_request(data, as_of)
    return result["checks"][0]


class AtomicParsingTests(unittest.TestCase):
    def test_decimal_and_limited_abbreviation_do_not_create_false_sentence(self):
        text = "Dr. Ada guarantees 99.99% uptime. We monitor systems."
        claims = cc.parse_claims(text)
        self.assertEqual(2, len(claims))
        self.assertEqual("Dr. Ada guarantees 99.99% uptime.", claims[0]["source_text"])
        self.assertEqual("numeric", claims[0]["type"])

    def test_offsets_are_exact_original_slices(self):
        text = "  We monitor systems.\nWe provide support. "
        for claim in cc.parse_claims(text):
            span = claim["source_span"]
            self.assertEqual(text[span["start"]:span["end"]], claim["source_text"])

    def test_shared_subject_predicates_split_and_inherit_only_normalized_text(self):
        text = "We provide monitoring and guarantee 99.99% uptime."
        claims = cc.parse_claims(text)
        self.assertEqual(2, len(claims))
        self.assertEqual("We provide monitoring", claims[0]["source_text"])
        self.assertEqual("guarantee 99.99% uptime.", claims[1]["source_text"])
        self.assertTrue(claims[1]["inherited_subject"])
        self.assertEqual("We guarantee 99.99% uptime.", claims[1]["normalized_text"])
        self.assertEqual("numeric", claims[1]["type"])

    def test_research_and_development_is_not_split(self):
        claims = cc.parse_claims("We provide research and development.")
        self.assertEqual(1, len(claims))
        self.assertNotIn("shared_subject_coordination", claims[0]["flags"])

    def test_clear_three_item_list_is_split(self):
        claims = cc.parse_claims("We provide monitoring, reporting, and alerts.")
        self.assertEqual(3, len(claims))
        self.assertEqual(["We provide monitoring", "reporting", "alerts."], [c["source_text"] for c in claims])
        self.assertEqual("We provide reporting", claims[1]["normalized_text"])

    def test_ambiguous_coordination_is_unsplit_and_flagged(self):
        claims = cc.parse_claims("We provide support and ensure resilience.")
        self.assertEqual(1, len(claims))
        self.assertTrue(claims[0]["needs_human_review"])
        self.assertIn("ambiguous_coordination_unsplit", claims[0]["flags"])

    def test_conditional_commitment_and_certification_classification(self):
        claims = cc.parse_claims("We will provide reports if approved. We are ISO 9001 certified.")
        self.assertEqual("commitment", claims[0]["type"])
        self.assertIn("conditional", claims[0]["flags"])
        self.assertEqual("certification", claims[1]["type"])

    def test_ids_are_deterministic(self):
        text = "We provide support."
        self.assertEqual(cc.parse_claims(text)[0]["id"], cc.parse_claims(text)[0]["id"])


class DeterministicCheckTests(unittest.TestCase):
    def test_exact_quote_passes_only_byte_for_byte(self):
        doc = document({"quote": "We provide support."}, text="Source evidence: We provide support.")
        check = one_check(request(docs=[doc], constraints=[{"type": "exact_quote", "claim_index": 0}]))
        self.assertEqual("PASS", check["status"])

    def test_exact_quote_absence_is_unknown_not_semantic_pass(self):
        doc = document({"quote": "We provide similar support."}, text="Source evidence: We provide similar support.")
        check = one_check(request(docs=[doc], constraints=[{"type": "exact_quote", "claim_index": 0}]))
        self.assertEqual("UNKNOWN", check["status"])

    def test_exact_quote_requires_bound_document_full_text_provenance(self):
        no_source_text = document({"quote": "We provide support."})
        self.assertEqual("UNKNOWN", one_check(request(docs=[no_source_text], constraints=[{"type": "exact_quote", "claim_index": 0}]))["status"])
        wrong_source_text = document({"quote": "We provide support."}, text="A different source statement.")
        self.assertEqual("UNKNOWN", one_check(request(docs=[wrong_source_text], constraints=[{"type": "exact_quote", "claim_index": 0}]))["status"])

    def test_reference_only_or_unapproved_evidence_fails(self):
        doc = document({}, reference_only=True)
        check = one_check(request(docs=[doc], constraints=[{"type": "evidence_approved", "claim_index": 0}]))
        self.assertEqual("FAIL", check["status"])

    def test_entity_scope_is_exact_normalized_not_semantic(self):
        doc = document({"entity": "  BIDFORGE ", "scope": "Production"})
        passed = one_check(request(docs=[doc], constraints=[{"type": "entity_scope", "claim_index": 0, "entity": "bidforge", "scope": " production "}]))
        self.assertEqual("PASS", passed["status"])
        failed = one_check(request(docs=[doc], constraints=[{"type": "entity_scope", "claim_index": 0, "scope": "business hours"}]))
        self.assertEqual("FAIL", failed["status"])

    def test_expired_and_current_dates_are_distinguished(self):
        expired_doc = document({}, valid_from="2024-01-01", valid_until="2025-12-31")
        expired = one_check(request(docs=[expired_doc], constraints=[{"type": "date_valid", "claim_index": 0}]))
        self.assertEqual("FAIL", expired["status"])
        current_doc = document({}, valid_from="2024-01-01", valid_until="2027-12-31")
        current = one_check(request(docs=[current_doc], constraints=[{"type": "date_valid", "claim_index": 0}]))
        self.assertEqual("PASS", current["status"])

    def test_start_only_validity_is_unknown(self):
        start_only_doc = document({}, valid_from="2024-01-01")
        check = one_check(request(docs=[start_only_doc], constraints=[{"type": "date_valid", "claim_index": 0}]))
        self.assertEqual("UNKNOWN", check["status"])

    def test_end_only_validity_is_unknown(self):
        doc = document({}, valid_until="2027-12-31")
        check = one_check(request(docs=[doc], constraints=[{"type": "date_valid", "claim_index": 0}]))
        self.assertEqual("UNKNOWN", check["status"])

    def test_numeric_uses_decimal_and_same_metric_scope_period(self):
        good = document({"metrics": [{"metric": "uptime", "value": "99.99", "unit": "%", "scope": "production", "period": "monthly"}]})
        constraint = {"type": "numeric", "claim_index": 0, "metric": "uptime", "value": "99.99", "unit": "%", "scope": "production", "period": "monthly"}
        self.assertEqual("PASS", one_check(request(docs=[good], constraints=[constraint]))["status"])
        irrelevant = document({"metrics": [{"metric": "availability", "value": "99.99", "unit": "%", "scope": "production", "period": "monthly"}]})
        self.assertEqual("UNKNOWN", one_check(request(docs=[irrelevant], constraints=[constraint]))["status"])

    def test_numeric_comparator_failure_is_fail(self):
        doc = document({"metrics": [{"metric": "uptime", "value": "99.9", "unit": "%", "scope": "production", "period": "monthly"}]})
        constraint = {"type": "numeric", "claim_index": 0, "metric": "uptime", "value": "99.99", "unit": "%", "scope": "production", "period": "monthly", "comparator": "ge"}
        self.assertEqual("FAIL", one_check(request(docs=[doc], constraints=[constraint]))["status"])

    def test_weaker_or_conditional_modality_fails(self):
        text = "We will provide reports."
        doc = document({"text": "We may provide reports if funds are available."})
        check = one_check(request(text, [doc], [{"type": "negation_modality", "claim_index": 0}]))
        self.assertEqual("FAIL", check["status"])

    def test_authorized_commitment_true_false_and_missing(self):
        passed = one_check(request(docs=[document({}, authorized_commitment=True)], constraints=[{"type": "authorized_commitment", "claim_index": 0}]))
        self.assertEqual("PASS", passed["status"])
        failed = one_check(request(docs=[document({}, authorized_commitment=False)], constraints=[{"type": "authorized_commitment", "claim_index": 0}]))
        self.assertEqual("FAIL", failed["status"])
        unknown = one_check(request(docs=[document({})], constraints=[{"type": "authorized_commitment", "claim_index": 0}]))
        self.assertEqual("UNKNOWN", unknown["status"])

    def test_minimum_projects_requires_distinct_ids_dates_and_context(self):
        one = document({"projects": [{"id": "P1", "date": "2025-01-01", "contexts": ["similar"]}, {"id": "P1", "date": "2025-02-01", "contexts": ["similar"]}]})
        constraint = {"type": "minimum_projects", "claim_index": 0, "min_count": 2, "after": "2024-01-01", "required_contexts": ["similar"]}
        self.assertEqual("FAIL", one_check(request(docs=[one], constraints=[constraint]))["status"])
        two = document({"projects": [{"id": "P1", "date": "2025-01-01", "contexts": ["similar"]}, {"id": "P2", "date": "2025-02-01", "contexts": ["similar", "production"]}]})
        self.assertEqual("PASS", one_check(request(docs=[two], constraints=[constraint]))["status"])


class ValidationAndCliTests(unittest.TestCase):
    def test_string_boolean_is_rejected(self):
        bad_doc = document({}, approved="true")
        with self.assertRaises(cc.ValidationError):
            cc.check_request(request(docs=[bad_doc]), "2026-06-01")

    def test_every_binding_claim_selector_is_validated_without_constraints(self):
        for binding in (
            {"claim_index": 1, "evidence_id": "e1", "assertion_id": "a1"},
            {"claim_id": "claim_missing", "evidence_id": "e1", "assertion_id": "a1"},
        ):
            with self.subTest(binding=binding), self.assertRaises(cc.ValidationError):
                cc.check_request(request(docs=[document({})], bindings=[binding]), "2026-06-01")

    def test_invalid_validity_ranges_and_project_range_are_rejected(self):
        invalid_documents = [
            document({}, valid_from="2027-01-01", valid_until="2026-01-01"),
            document({"valid_from": "2027-01-01", "valid_until": "2026-01-01"}),
            document({}, metadata={"valid_from": "2027-01-01", "valid_until": "2026-01-01"}),
        ]
        for bad_doc in invalid_documents:
            with self.subTest(document=bad_doc), self.assertRaises(cc.ValidationError):
                cc.check_request(request(docs=[bad_doc]), "2026-06-01")
        invalid_constraint = {"type": "minimum_projects", "claim_index": 0, "min_count": 1, "after": "2027-01-01", "before": "2026-01-01"}
        with self.assertRaises(cc.ValidationError):
            cc.check_request(request(constraints=[invalid_constraint]), "2026-06-01")

    def test_non_string_decimal_is_rejected(self):
        bad_doc = document({"metrics": [{"metric": "uptime", "value": 99.99, "unit": "%", "scope": "production", "period": "monthly"}]})
        with self.assertRaises(cc.ValidationError):
            cc.check_request(request(docs=[bad_doc]), "2026-06-01")

    def test_invalid_as_of_is_rejected(self):
        with self.assertRaises(cc.ValidationError):
            cc.check_request(request(), "2026-02-30")

    def test_strict_cli_is_one_for_unknown_and_invalid_input_is_two(self):
        payload = request(docs=[document({})], constraints=[{"type": "exact_quote", "claim_index": 0}])
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.json"
            output_path = Path(directory) / "output.json"
            input_path.write_text(json.dumps(payload), encoding="utf-8")
            strict = subprocess.run([sys.executable, str(HERE / "claim_checker.py"), "--input", str(input_path), "--output", str(output_path), "--as-of", "2026-06-01", "--strict"], capture_output=True, text=True)
            self.assertEqual(1, strict.returncode)
            self.assertEqual("UNKNOWN", json.loads(output_path.read_text(encoding="utf-8"))["checks"][0]["status"])
            invalid = subprocess.run([sys.executable, str(HERE / "claim_checker.py"), "--input", str(input_path), "--output", str(output_path), "--as-of", "2026-99-01"], capture_output=True, text=True)
            self.assertEqual(2, invalid.returncode)
            self.assertEqual("INVALID_INPUT", json.loads(output_path.read_text(encoding="utf-8"))["error"])

    def test_text_mode_has_no_constraints_and_is_not_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            text_path = Path(directory) / "draft.txt"
            text_path.write_text("We provide support.", encoding="utf-8")
            result = subprocess.run([sys.executable, str(HERE / "claim_checker.py"), "--text", str(text_path), "--as-of", "2026-06-01"], capture_output=True, text=True, check=False)
            self.assertEqual(0, result.returncode)
            payload = json.loads(result.stdout)
            self.assertEqual("NOT_VERIFIED", payload["overall"])
            self.assertEqual("NOT_EVALUATED", payload["semantic_verdict"])

    def test_unchecked_and_review_needed_claims_prevent_verified_overall_and_strict(self):
        text = "We provide support. We provide support and ensure resilience."
        support_doc = document({"quote": "We provide support."}, text="We provide support.")
        data = request(text, [support_doc], [{"type": "exact_quote", "claim_index": 0}])
        result = cc.check_request(data, "2026-06-01")
        self.assertEqual("NOT_VERIFIED", result["overall"])
        self.assertEqual(1, result["summary"]["claims_without_checks"])
        self.assertEqual(1, result["summary"]["review_needed"])
        self.assertEqual([result["claims"][1]["id"]], result["unverified_claim_ids"])
        with tempfile.TemporaryDirectory() as directory:
            text_path = Path(directory) / "draft.txt"
            text_path.write_text("We provide support.", encoding="utf-8")
            strict = subprocess.run([sys.executable, str(HERE / "claim_checker.py"), "--text", str(text_path), "--as-of", "2026-06-01", "--strict"], capture_output=True, text=True)
            self.assertEqual(1, strict.returncode)


if __name__ == "__main__":
    unittest.main()
