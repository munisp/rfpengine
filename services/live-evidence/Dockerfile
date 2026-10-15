FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home --uid 10001 bidforge && chown -R bidforge:bidforge /app
USER bidforge
EXPOSE 8080
CMD ["uvicorn", "main:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
