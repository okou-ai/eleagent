from fastapi import FastAPI
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY
from entity_worker import metrics


def value(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0


def test_http_red_uses_route_templates_and_status():
    app = FastAPI()
    metrics.instrument_fastapi(app)

    @app.get('/items/{item_id}')
    def item(item_id: str):
        return {'id': item_id}
    client = TestClient(app)
    before = value('scene_http_requests_total', service=metrics.SERVICE, method='GET', route='/items/{item_id}', status='200')
    client.get('/items/a'); client.get('/items/b')
    assert value('scene_http_requests_total', service=metrics.SERVICE, method='GET', route='/items/{item_id}', status='200') == before + 2
    client.get('/nope')
    assert value('scene_http_requests_total', service=metrics.SERVICE, method='GET', route='unmatched', status='404') >= 1
    assert value('scene_http_request_duration_seconds_count', service=metrics.SERVICE, method='GET', route='/items/{item_id}') >= 2


def test_jobs_and_failing_gauges_never_break_scrapes():
    metrics.job('unit_test', 'ok', 0.2)
    assert value('scene_jobs_total', service=metrics.SERVICE, job='unit_test', status='ok') >= 1
    metrics.register_gauges(lambda: iter([('scene_test_gauge', 'test', ['k'], [(('a',), 3)])]))
    def broken():
        raise RuntimeError('db down')
        yield
    metrics.register_gauges(broken)
    assert value('scene_test_gauge', k='a') == 3
