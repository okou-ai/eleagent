"""Minimal Prometheus RED metrics shared by the scene services (prometheus_client).

HTTP services: instrument_fastapi(app) -> request rate/errors by route template + latency histogram.
Workers: job(name, status, seconds) -> work-unit rate/errors + duration histogram.
Counts: register_gauges(fn) -> values computed at scrape time (fn errors never break the scrape).
The exporter listens on METRICS_PORT (unset = disabled); METRICS_SERVICE labels every series.
"""
import os
import time
from prometheus_client import REGISTRY, Counter, Histogram, start_http_server
from prometheus_client.core import GaugeMetricFamily

SERVICE = os.environ.get('METRICS_SERVICE', 'unknown')
BUCKETS = (.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120)
HTTP_REQUESTS = Counter('scene_http_requests_total', 'HTTP requests by route template and status', ['service', 'method', 'route', 'status'])
HTTP_SECONDS = Histogram('scene_http_request_duration_seconds', 'HTTP request latency until response headers', ['service', 'method', 'route'], buckets=BUCKETS)
JOBS = Counter('scene_jobs_total', 'Background work units by outcome', ['service', 'job', 'status'])
JOB_SECONDS = Histogram('scene_job_duration_seconds', 'Background work unit duration', ['service', 'job'], buckets=BUCKETS)
EVENTS = Counter('scene_events_total', 'Notable pipeline events such as drops and gaps', ['service', 'event', 'reason'])
_serving = False


def serve():
    global _serving
    port = int(os.environ.get('METRICS_PORT') or 0)
    if port and not _serving:
        start_http_server(port, addr=os.environ.get('METRICS_ADDR', '0.0.0.0'))
        _serving = True


def instrument_fastapi(app):
    @app.middleware('http')
    async def red_metrics(request, call_next):
        start, status = time.perf_counter(), 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            # Route templates (not raw paths) keep label cardinality bounded.
            route = getattr(request.scope.get('route'), 'path', None) or 'unmatched'
            HTTP_REQUESTS.labels(SERVICE, request.method, route, str(status)).inc()
            HTTP_SECONDS.labels(SERVICE, request.method, route).observe(time.perf_counter() - start)


def job(name, status, seconds=None):
    JOBS.labels(SERVICE, name, status).inc()
    if seconds is not None:
        JOB_SECONDS.labels(SERVICE, name).observe(seconds)


def event(name, reason):
    EVENTS.labels(SERVICE, name, str(reason)).inc()


def register_gauges(collect):
    """collect() yields (name, help, labelnames, [(labelvalues, value), ...]) at every scrape."""
    class Collector:
        def collect(self):
            try:
                rows = list(collect())
            except Exception:
                rows = []
            for name, help_text, labelnames, samples in rows:
                family = GaugeMetricFamily(name, help_text, labels=labelnames)
                for labels, value in samples:
                    family.add_metric([str(v) for v in labels], float(value))
                yield family
    REGISTRY.register(Collector())
