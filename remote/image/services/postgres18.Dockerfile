# PostgreSQL 18 with PostGIS 3 and pgvector, the service kind `postgres-18` of session previews. hunt-ctl builds it at
# install as hunt-postgres18:<bundle hash>, with this folder as the build context; the base is pinned by digest.
FROM pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-18-postgis-3 postgresql-18-postgis-3-scripts \
    && rm -rf /var/lib/apt/lists/*
