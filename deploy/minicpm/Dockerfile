# Build context: the pinned upstream checkout prepared by build.sh.
ARG MINICPM_BASE_IMAGE
FROM ${MINICPM_BASE_IMAGE}
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONPATH=/app \
    TORCHINDUCTOR_CACHE_DIR=/app/torch_compile_cache
WORKDIR /app
RUN python3 -c 'import platform, sys, torch; assert platform.machine() == "aarch64"; assert sys.version_info[:2] == (3, 12); assert torch.version.cuda and torch.version.cuda.startswith("13.")' \
    && command -v ffmpeg && command -v curl \
    && { test -x /opt/minicpm-venv/bin/python || python3 -m venv --system-site-packages /opt/minicpm-venv; }
ENV PATH=/opt/minicpm-venv/bin:$PATH
COPY eleagent-build-requirements.lock /tmp/build-requirements.lock
COPY eleagent-requirements.lock /tmp/requirements.lock
COPY eleagent-install-locked.py /tmp/install-locked.py
RUN --mount=type=cache,target=/root/.cache/pip \
    --mount=type=bind,from=wheelhouse,target=/opt/eleagent-wheelhouse \
    python /tmp/install-locked.py /tmp/build-requirements.lock /opt/eleagent-wheelhouse \
    && python /tmp/install-locked.py /tmp/requirements.lock /opt/eleagent-wheelhouse --no-build-isolation --force-reinstall
COPY . .
RUN chmod +x /app/eleagent-entrypoint.sh \
    && mkdir -p /app/data /app/tmp /app/torch_compile_cache
EXPOSE 22400
ENTRYPOINT ["/app/eleagent-entrypoint.sh"]
