### 1. System Topology, Service Boundaries, and Runtime Component Architecture

The safety reporting and query platform implements a modular asynchronous topology anchored by a `FastAPI` application server running under `uvicorn` workers, fronted by an `Envoy` edge ingress proxy terminating TLS and enforcing IP-level rate limits. Core service boundaries isolate synchronous user-facing request routing from asynchronous vector generation and geospatial batch aggregations. The synchronous path handles read and write requests directly through `asyncpg` connection pools managed by `PgBouncer` in transaction-pooling mode on port 6432, routing into a single `PostgreSQL 16` database instance with native `PostGIS 3.4` and `pgvector 0.7.0` extensions installed. This eliminates distributed transaction coordination across segregated databases, ensuring ACID guarantees when synchronizing relational incident metadata in `safety_incidents` with spatial points and vector embeddings.

```
[React Native Client] 
   │ (HTTPS / WSS via Envoy Ingress)
   ▼
[FastAPI / uvicorn Pods] ──── (asyncpg / 6432) ────► [PgBouncer] ──► [PostgreSQL 16: PostGIS + pgvector]
   │                                                                           ▲
   ├─► (redis-py / Task Push) ──► [Redis 7.2 Broker]                           │
   │                                     │                                     │
   │                                     ▼                                     │
   │                           [Celery Workers (PyTorch)] ─────────────────────┘
   │                              (all-MiniLM-L6-v2)
   │
   └─► (redis.asyncio / Read-Through) ──► [Redis 7.2 Cache]
```

Background execution decouples compute-intensive machine learning workloads from client-facing latency budgets. A dedicated pool of `Celery 5.3` workers, orchestrated by `Docker Compose` in development and a `Kubernetes Deployment` in production, consumes queue events from a `Redis 7.2` broker instance. These workers execute embedding generation via `PyTorch` and `sentence-transformers`, perform reverse geocoding via `geopy` and the Mapbox Geocoding API, and execute batch incident clustering routines. The `FastAPI` service exposes health, readiness, and metrics scrapers via `prometheus-fastapi-instrumentator`, which are collected by a `Prometheus` daemon and visualized in `Grafana` dashboards monitoring endpoint latencies, worker queue depths, and PostgreSQL query execution times.

### 2. Data Storage Strategy, Spatial-Vector Schema Design, and Indexing Topography

The persistence layer relies on a normalized relational schema within `PostgreSQL 16` centered around the `safety_incidents`, `incident_embeddings`, and `safety_zones` tables managed by `Alembic` migration scripts. The primary table, `safety_incidents`, stores the primary key `id UUID`, title `title VARCHAR(255)`, body text `description TEXT`, categorization `category VARCHAR(64)`, severity rating `severity SMALLINT`, verification flag `is_verified BOOLEAN`, submission timestamp `reported_at TIMESTAMPTZ`, exact coordinates `coordinates GEOMETRY(Point, 4326)`, obfuscated coordinates `geom_obfuscated GEOMETRY(Point, 4326)`, and precomputed lexical tokens `search_vector TSVECTOR`. A PostgreSQL trigger function executing `tsvector_update_trigger()` automatically updates `search_vector` on any `INSERT` or `UPDATE` targeting `title` and `description` using the `'english'` text search configuration.

```sql
-- DDL definition for the primary safety incident storage engine
CREATE TABLE safety_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(64) NOT NULL,
    severity SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
    is_verified BOOLEAN DEFAULT FALSE,
    reported_at TIMESTAMPTZ DEFAULT clock_timestamp(),
    coordinates GEOMETRY(Point, 4326) NOT NULL,
    geom_obfuscated GEOMETRY(Point, 4326) NOT NULL,
    search_vector TSVECTOR
);

CREATE TABLE incident_embeddings (
    incident_id UUID PRIMARY KEY REFERENCES safety_incidents(id) ON DELETE CASCADE,
    embedding VECTOR(384) NOT NULL,
    model_version VARCHAR(32) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT clock_timestamp()
);

CREATE TABLE safety_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    boundary GEOMETRY(Polygon, 4326) NOT NULL,
    base_safety_score FLOAT NOT NULL DEFAULT 5.0
);
```

High-throughput retrieval across three orthogonal dimensions requires three specialized index structures. First, a Generalized Search Tree (`GiST`) index named `idx_safety_incidents_coordinates` is created on `safety_incidents USING GIST (coordinates)` to accelerate `ST_DWithin` bounding-box range calculations. Second, a Generalized Inverted Index (`GIN`) named `idx_safety_incidents_search_vector` is provisioned on `safety_incidents USING GIN (search_vector)` to evaluate `@@ websearch_to_tsquery()` matches in sub-millisecond durations. Third, dense semantic search is enabled by isolating 384-dimensional vector data into `incident_embeddings`, indexed by a Hierarchical Navigable Small World (`HNSW`) index named `idx_incident_embeddings_hnsw` constructed with `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`. The spatial zones defined in `safety_zones` utilize an additional GiST index on `boundary` for `ST_Contains` spatial intersection joins.

### 3. Hybrid Search Retrieval Pipeline: Tri-Modal Fusion of Vector, Lexical, and Spatial Queries

The platform executes queries via `hybrid_search.sql`, an SQL script executed by `asyncpg` within `FastAPI`'s `SearchService.execute_hybrid_search` method. The query combines lexical full-text matching, dense semantic similarity, and geospatial distance decay into a single ranked score using Reciprocal Rank Fusion (RRF). When a user submits a textual search query like "harassment near 3rd street" with explicit device latitude, longitude, and radius parameters, the query parses the input into text tokens and passes the 384-dimensional vector generated by `sentence-transformers/all-MiniLM-L6-v2` alongside the target coordinate geometry `ST_SetSRID(ST_MakePoint(:target_lon, :target_lat), 4326)`.

```sql
-- Implementation of hybrid_search.sql via Reciprocal Rank Fusion (RRF)
WITH spatial_scope AS (
    SELECT id, title, description, category, severity, reported_at, coordinates,
           ST_Distance(coordinates::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography) AS distance_meters
    FROM safety_incidents
    WHERE ST_DWithin(coordinates::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :radius_meters)
),
lexical_ranking AS (
    SELECT s.id,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(s.search_vector, websearch_to_tsquery('english', :query_text)) DESC) AS rank_lex
    FROM spatial_scope s
    WHERE s.search_vector @@ websearch_to_tsquery('english', :query_text)
),
semantic_ranking AS (
    SELECT s.id,
           ROW_NUMBER() OVER (ORDER BY (e.embedding <=> :query_vector) ASC) AS rank_sem
    FROM spatial_scope s
    JOIN incident_embeddings e ON s.id = e.incident_id
),
proximity_ranking AS (
    SELECT s.id,
           ROW_NUMBER() OVER (ORDER BY s.distance_meters ASC) AS rank_geo
    FROM spatial_scope s
)
SELECT s.id, s.title, s.description, s.category, s.severity, s.reported_at, s.coordinates, s.distance_meters,
       (COALESCE(1.0 / (60 + l.rank_lex), 0.0) * :weight_lex +
        COALESCE(1.0 / (60 + m.rank_sem), 0.0) * :weight_sem +
        COALESCE(1.0 / (60 + p.rank_geo), 0.0) * :weight_geo) AS rrf_score
FROM spatial_scope s
LEFT JOIN lexical_ranking l ON s.id = l.id
LEFT JOIN semantic_ranking m ON s.id = m.id
LEFT JOIN proximity_ranking p ON s.id = p.id
ORDER BY rrf_score DESC
LIMIT :limit_count OFFSET :offset_count;
```

The Common Table Expression (CTE) `spatial_scope` applies PostGIS `ST_DWithin` using indexed geography casts to constrain candidate retrieval to a strict spatial envelope (such as 1,500 meters), pruning the active working set prior to calculating vector dot products or document ranks. Next, `lexical_ranking` scores matches against `search_vector` using `ts_rank_cd`, assigning integer row numbers (`rank_lex`). Concurrently, `semantic_ranking` joins `incident_embeddings` and computes cosine distances using the `pgvector` operator `<=>`, producing `rank_sem`. Finally, `proximity_ranking` assigns integer ranks based on metric distance from the search centroid (`rank_geo`). The outer `SELECT` fuses these ordinal ranks using the formula `1.0 / (60 + rank)`, applying dynamic weighting factors (`:weight_lex`, `:weight_sem`, `:weight_geo`) to prioritize exact street names during lexical matches while falling back to semantic vector embeddings when colloquial expressions like "sketchy alleyway" appear in user input.

### 4. Event Ingestion, Background Processing, and Asynchronous Embedding Generation Pipeline

The write path initiates when an authenticated client dispatches a JSON payload to the `POST /api/v1/incidents` endpoint defined in `api/v1/endpoints/incidents.py`. The `FastAPI` route validates incoming payloads via `Pydantic` models (`IncidentCreateSchema`), verifying latitude, longitude, category enums, and description length. The handler executes an `INSERT` statement through `asyncpg` to create a record in `safety_incidents` with `is_verified` set to `FALSE` and `geom_obfuscated` computed by applying the `location_obfuscator` spatial jitter function. Upon successful commit, `FastAPI` publishes a task message containing the newly generated incident UUID to the `Redis 7.2` broker queue named `celery_ingestion_queue` using `redis.asyncio`.

```
[IncidentReportModal]
       │
       ▼ (POST /api/v1/incidents)
[FastAPI / Pydantic Validation] ────► [PostgreSQL: safety_incidents (INSERT)]
       │
       ▼ (LPUSH celery_ingestion_queue)
[Redis 7.2 Broker]
       │
       ▼ (BRPOP Task)
[Celery Worker: generate_incident_embedding]
       ├──► (sentence-transformers: all-MiniLM-L6-v2) ──► [incident_embeddings (INSERT)]
       ├──► (geopy / Mapbox Geocoding) ──────────────────► [safety_incidents (UPDATE street/neighborhood)]
       └──► (Redis PUBLISH ws:incidents:spatial_cell) ────► [FastAPI WebSocket Endpoint] 
                                                                   │
                                                                   ▼
                                                       [Client: Mapbox Invalidation]
```

A distributed `Celery` worker process running `tasks/embedding_worker.py` consumes the task via `brpop`. The worker invokes `sentence_transformers.SentenceTransformer('all-MiniLM-L6-v2')` within a cached `PyTorch` context to embed the concatenated `title` and `description` into a 384-dimensional floating-point array, normalizing the vector to unit length. The worker executes an upsert into `incident_embeddings` using `psycopg2` or `SQLAlchemy 2.0`. Simultaneously, a chained Celery task, `reverse_geocode_incident`, passes the un-obfuscated latitude and longitude to `geopy.geocoders.Nominatim` or the Mapbox Search SDK, extracting canonical street names, postal codes, and neighborhood polygons, writing these back to `safety_incidents.street_name` and `safety_incidents.neighborhood_id`. Once completed, the task publishes an invalidation notification to Redis Pub/Sub channel `ws:incidents:spatial_cell`, prompting connected `FastAPI` WebSocket handlers to push real-time alerts to nearby mobile devices.

### 5. Client Application Architecture, Screen State Management, and Geospatial Rendering

The client application is built with `React Native` (targeting iOS and Android) leveraging TypeScript, `@tanstack/react-query` for server state caching, `zustand` for client-side spatial viewport controls, and `@rnmapbox/maps` for hardware-accelerated vector map rendering. The primary interface is organized into five dedicated screen components: `LocationIncidentFeedScreen`, `SafetyHeatmapView`, `IncidentReportModal`, `RadiusSearchFilterBar`, and `IncidentDetailSheet`. The `RadiusSearchFilterBar` coordinates user inputs across both map and list views, storing the active latitude, longitude, search radius (in meters), and category filter states within a centralized Zustand store named `useSpatialFilterStore`.

```tsx
// LocationIncidentFeedScreen component utilizing @tanstack/react-query
import React from 'react';
import { View, FlatList, ActivityIndicator, Text } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSpatialFilterStore } from '../stores/useSpatialFilterStore';
import { IncidentCard } from '../components/IncidentCard';
import apiClient from '../services/apiClient';

export const LocationIncidentFeedScreen: React.FC = () => {
  const { latitude, longitude, radiusMeters, searchQuery } = useSpatialFilterStore();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['hybrid_search', latitude, longitude, radiusMeters, searchQuery],
    queryFn: async ({ pageParam = 0 }) => {
      const response = await apiClient.get('/api/v1/search/hybrid', {
        params: { lat: latitude, lon: longitude, radius: radiusMeters, q: searchQuery, offset: pageParam, limit: 20 },
      });
      return response.data;
    },
    getNextPageParam: (lastPage, allPages) => lastPage.has_more ? allPages.length * 20 : undefined,
    initialPageParam: 0,
    staleTime: 30000,
  });

  if (isLoading) return <ActivityIndicator size="large" testID="loading-spinner" />;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={data?.pages.flatMap((page) => page.incidents) ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <IncidentCard incident={item} />}
        onEndReached={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage(); }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={isFetchingNextPage ? <ActivityIndicator size="small" /> : null}
      />
    </View>
  );
};
```

The `SafetyHeatmapView` embeds a `MapboxGL.MapView` rendering a dynamic `MapboxGL.HeatmapLayer` backed by a GeoJSON source hooked to `GET /api/v1/safety/heatmap-tiles/{z}/{x}/{y}.pbf` generated by `tegola` or `pg_tileserv` streaming directly from `safety_incidents`. When a user pans or zooms, the `onRegionDidChange` callback dispatches the new viewport centroid to `useSpatialFilterStore`, debounced at 250 milliseconds via `lodash.debounce`. This state change invalidates the `@tanstack/react-query` cache key `['hybrid_search', latitude, longitude, radiusMeters, searchQuery]`, triggering an automatic background refetch for `LocationIncidentFeedScreen`. Tapping an individual incident pin expands the `IncidentDetailSheet`, presenting verified municipal crime data alongside community-submitted photos managed by `react-native-fast-image`. Tapping the report button invokes `IncidentReportModal`, which accesses `react-native-geolocation-service` to lock the device coordinates before presenting input forms for incident title, category, and severity sliders.

### 6. Caching Architecture, Connection Pooling, and Query Performance Optimization

Meeting the sub-100ms P95 latency SLA across high-concurrency spatial-vector queries requires a multi-tiered caching topology combined with strict database connection pooling. `PgBouncer` operates as a sidecar container to `PostgreSQL 16`, configured with `pool_mode = transaction`, `max_client_conn = 2000`, `default_pool_size = 64`, and `reserve_pool_size = 16`. This configuration insulates PostgreSQL from connection thrashing when hundreds of concurrent `FastAPI` worker threads instantiate `asyncpg` connection pools. In the application tier, `FastAPI` routes read requests through a two-level caching strategy implemented using `redis.asyncio`.

```
[Client Query: "safety on 3rd street" @ lat, lon, r]
                       │
                       ▼
            [FastAPI Endpoint Layer]
                       │
                       ▼
        [Redis 7.2: Geohash Bounding Box Key]
        ├── Hit: Return cached JSON payload (TTL: 120s)
        └── Miss: Execute PostgreSQL Query
                       │
                       ▼
        [PgBouncer (Transaction Pool: 64 Conns)]
                       │
                       ▼
        [PostgreSQL 16 Execution Engine]
        ├── 1. ST_DWithin Index Scan (GiST on coordinates)
        ├── 2. ts_rank_cd Text Search (GIN on search_vector)
        └── 3. Vector Distance Scan (HNSW on incident_embeddings)
                       │
                       ▼
        [Write back to Redis 7.2 Cache] ──► [Return Response to Client]
```

Spatial-lexical cache keys are formatted using Uber H3 hexagonal spatial indexes or Geohashes at precision 7 (approximately 150-meter bounding boxes) paired with MD5 hashes of normalized query strings: `cache:search:geohash:{geohash7}:q:{query_hash}`. When `SearchService.execute_hybrid_search` executes, it checks `Redis 7.2` for this key; cache hits return pre-serialized JSON payloads directly, bypassing SQL execution. Cache misses fall through to `hybrid_search.sql`. The PostgreSQL database engine is tuned for hybrid spatial-vector operations by allocating `shared_buffers = 4GB`, `work_mem = 64MB` to support in-memory RRF sorting, and `maintenance_work_mem = 1GB` to expedite HNSW graph construction. Furthermore, the `ef_search` parameter for `pgvector` is dynamically set to `40` within the transaction context (`SET LOCAL hnsw.ef_search = 40;`), maintaining a balance between vector recall accuracy and index traversal time.

### 7. Geospatial Privacy, Content Moderation, and Zero-Downtime Deployment Strategy

Geospatial privacy and user anonymity are enforced prior to writing records to disk through the `location_obfuscator` module located in `core/security/geospatial.py`. To prevent tracking residential origins or identifying individual victims, any incident categorized under sensitive types (e.g., domestic disputes, stalking) or originating within designated residential zones in `safety_zones` undergoes differential privacy perturbation using `shapely.geometry.Point`. The module generates a pseudo-random displacement vector using Gaussian spatial noise bounded between 30 and 75 meters, projecting the altered coordinate onto the nearest public right-of-way using PostGIS `ST_ClosestPoint` against a road centerline dataset. The exact coordinate is stored in `safety_incidents.coordinates` restricted to administrative read permissions, while public APIs and vector tile engines read exclusively from `safety_incidents.geom_obfuscated`.

```
[Raw Incident Submission]
          │
          ├──► [better-profanity / Detoxify Model] ──► Toxic: Flags to moderation_queue (held)
          │
          └──► [location_obfuscator (shapely)] 
                    │ (Check safety_zones via ST_Contains)
                    ▼
          [Gaussian Perturbation (30m-75m)]
                    │
                    ▼
          [PostGIS ST_ClosestPoint to Road Centerline]
                    │
                    ▼
          [Write to safety_incidents.geom_obfuscated]
```

Content moderation combines automated heuristics with administrative triage. Prior to committing an incident to `safety_incidents`, text content passes through `better-profanity` for deterministic profanity masking, followed by inference through a lightweight `detoxify` BERT classifier running in a dedicated Celery task. Content with toxicity confidence exceeding 0.85 is automatically tagged with `status = 'flagged'` and diverted to the `moderation_queue` table, preventing it from appearing in `hybrid_search.sql` until cleared by an administrator using the `AdminReviewScreen`. 

Zero-downtime deployment is achieved on `Kubernetes` using blue/green rolling updates controlled by `Argo Rollouts`. Database schema updates execute through forward-compatible `Alembic` migrations: new columns are introduced as nullable, and indexes on `safety_incidents` and `incident_embeddings` are created concurrently using `CREATE INDEX CONCURRENTLY` to avoid acquiring table locks on active production databases. Feature rollout is regulated using `LaunchDarkly` feature flags (`flag-hybrid-search-v2`, `flag-strict-geofuzzing`), allowing real-time canary testing and immediate fallback without service interruption.
