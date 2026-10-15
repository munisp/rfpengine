FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ALERT_DB_PATH=/data/alerts.sqlite3 \
    ALERT_WEBHOOK_TOKEN_FILE=/run/secrets/alert-webhook-token

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin alertreceiver \
    && mkdir -p /data /run/secrets \
    && chown -R alertreceiver:alertreceiver /app /data
COPY alert_receiver.py ./
RUN chown alertreceiver:alertreceiver /app/alert_receiver.py

USER alertreceiver
EXPOSE 8095
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD python -c "from urllib.request import urlopen; assert urlopen('http://127.0.0.1:8095/health', timeout=2).status == 200"
CMD ["uvicorn", "alert_receiver:app", "--host", "0.0.0.0", "--port", "8095", "--proxy-headers"]
