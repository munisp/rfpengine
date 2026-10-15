from pathlib import Path


def test_prometheus_has_actual_alertmanager_delivery_target():
    text=(Path(__file__).resolve().parents[1]/'prometheus.yml').read_text()
    assert 'alerting:' in text
    assert 'alertmanagers:' in text
    assert 'alertmanager:9093' in text
    assert '/run/secrets/metrics-token' in text


def test_ci_runs_monitoring_and_full_stack_checks_on_every_pr():
    root=Path(__file__).resolve().parents[2]
    text=(root/'.github/workflows/ci.yml').read_text()
    assert 'pull_request:' in text and 'pull_request_target:' not in text
    for clause in ('contents: read','test rules','check-config','monitoring/tests','local-stack.sh test'):
        assert clause in text
