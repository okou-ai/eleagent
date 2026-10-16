import neo4j from 'neo4j-driver';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Labels and relationship types are deliberately fixed. All property names,
// values, IDs, limits, and cursors remain query parameters.
const CANDIDATES = `
  MATCH (e:Entity)
  WHERE e.id IS NOT NULL AND e.id IS :: STRING AND e.id <> ''
    AND all(key IN keys($filter) WHERE
      CASE WHEN $filter[key] IS NULL THEN e[key] IS NULL
           ELSE e[key] = $filter[key] END)
    AND ($search = '' OR any(key IN keys(e) WHERE
      CASE WHEN e[key] IS :: STRING
           THEN toLower(e[key]) CONTAINS $search ELSE false END))
  WITH e, e[$sort] AS raw
  WITH e, raw, CASE
    WHEN raw IS NULL THEN 3
    WHEN raw IS :: BOOLEAN THEN 0
    WHEN raw IS :: INTEGER OR raw IS :: FLOAT THEN 1
    WHEN raw IS :: STRING THEN 2
    ELSE 4 END AS rank
`;

const CHECK_SORT = `${CANDIDATES}
  WHERE rank = 4 OR CASE WHEN rank = 1
    THEN raw <> raw OR raw > $maxFinite OR raw < -$maxFinite
    ELSE false END
  RETURN e.id AS id LIMIT 1
`;

function entityPageQuery(order) {
  // Callers cannot supply syntax: there are exactly two fixed query variants.
  const descending = order === 'desc';
  return `${CANDIDATES}
    WITH e, rank, CASE WHEN rank = 0
      THEN CASE WHEN raw THEN 1 ELSE 0 END ELSE raw END AS value
    WHERE rank <> 4 AND ($afterId IS NULL OR rank > $afterRank
      OR (rank = $afterRank AND (
        (rank = 3 AND e.id > $afterId)
        OR (rank <> 3 AND (value ${descending ? '<' : '>'} $afterValue
          OR (value = $afterValue AND e.id > $afterId))))))
    RETURN properties(e) AS p, rank, value
    ORDER BY rank ASC, value ${descending ? 'DESC' : 'ASC'}, e.id ASC
    LIMIT $take
  `;
}

const ENTITY_PAGES = { asc: entityPageQuery('asc'), desc: entityPageQuery('desc') };

const GET_ENTITY = `
  MATCH (e:Entity {id: $id}) WHERE e.id IS :: STRING AND e.id <> ''
  RETURN properties(e) AS p LIMIT 2
`;

const LINK_PAGE = `
  MATCH (root:Entity {id: $id})-[:LINK]-(neighbor:Entity)
  WHERE neighbor.id IS NOT NULL AND neighbor.id IS :: STRING AND neighbor.id <> ''
    AND ($after IS NULL OR neighbor.id > $after)
  WITH DISTINCT neighbor ORDER BY neighbor.id ASC LIMIT $take
  MATCH (:Entity {id: $id})-[link:LINK]-(neighbor)
  WITH neighbor, link ORDER BY elementId(link) ASC
  WITH neighbor, head(collect(properties(link))) AS linkProperties
  RETURN properties(neighbor) AS p, linkProperties AS link
  ORDER BY neighbor.id ASC
`;

const GET_SEEDS = `
  MATCH (e:Entity) WHERE e.id IN $ids AND e.id IS :: STRING AND e.id <> ''
  RETURN properties(e) AS p ORDER BY e.id ASC
`;

const EXPAND_LAYER = `
  MATCH (source:Entity)-[:LINK]-(neighbor:Entity)
  WHERE source.id IN $frontier
    AND neighbor.id IS NOT NULL AND neighbor.id IS :: STRING AND neighbor.id <> ''
    AND NOT neighbor.id IN $seen
  WITH DISTINCT neighbor ORDER BY neighbor.id ASC
  RETURN properties(neighbor) AS p LIMIT $take
`;

const INDUCED_LINKS = `
  MATCH (a:Entity)-[link:LINK]-(b:Entity)
  WHERE a.id IN $ids AND b.id IN $ids AND a.id <= b.id
  WITH a, b, link ORDER BY elementId(link) ASC
  WITH a, b, head(collect(properties(link))) AS p
  RETURN a.id AS a, b.id AS b, p
  ORDER BY a.id ASC, b.id ASC LIMIT $take
`;

function jsonValue(value) {
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value) : value.toString();
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, jsonValue);
  if (value instanceof Date) return value.toISOString();
  // Neo4j temporal and spatial values have canonical string representations.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
      && typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
    return value.toString();
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
}

function entity(properties) {
  const { id, ...rest } = properties;
  return { id, properties: jsonValue(rest) };
}

function link(a, b, properties) {
  return a <= b
    ? { a, b, properties: jsonValue(properties) }
    : { a: b, b: a, properties: jsonValue(properties) };
}

function cursorValue(value) {
  if (neo4j.isInt(value)) return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') return { type: 'float', value };
  return value;
}

function parseCursor(after) {
  if (after === null) return { afterId: null, afterRank: null, afterValue: null };
  if (!after || typeof after.id !== 'string' || !Number.isInteger(after.rank)
      || after.rank < 0 || after.rank > 3) {
    throw new ApiError(400, 'invalid_cursor', 'The entity cursor is invalid.');
  }
  const { rank, value } = after;
  let decoded;
  if (rank === 3) {
    if (value !== null) throw new ApiError(400, 'invalid_cursor', 'The entity cursor is invalid.');
    decoded = null;
  } else if (rank === 2) {
    if (typeof value !== 'string') throw new ApiError(400, 'invalid_cursor', 'The entity cursor is invalid.');
    decoded = value;
  } else if (value?.type === 'integer' && typeof value.value === 'string'
      && /^-?(0|[1-9][0-9]*)$/.test(value.value) && value.value.length <= 20) {
    const integer = BigInt(value.value);
    if (integer < -9223372036854775808n || integer > 9223372036854775807n) {
      throw new ApiError(400, 'invalid_cursor', 'The entity cursor is invalid.');
    }
    if (rank === 0 && integer !== 0n && integer !== 1n) {
      throw new ApiError(400, 'invalid_cursor', 'The entity cursor is invalid.');
    }
    decoded = neo4j.int(value.value);
  } else if (rank === 1 && value?.type === 'float' && typeof value.value === 'number'
      && Number.isFinite(value.value)) {
    decoded = value.value;
  } else {
    throw new ApiError(400, 'invalid_cursor', 'The entity cursor is invalid.');
  }
  return { afterId: after.id, afterRank: neo4j.int(rank), afterValue: decoded };
}

async function getEntityIn(tx, id) {
  const result = await tx.run(GET_ENTITY, { id });
  if (!result.records.length) throw new ApiError(404, 'not_found', 'Entity not found.');
  if (result.records.length > 1) throw new ApiError(500, 'duplicate_entity_id', 'Entity IDs are not unique.');
  return entity(result.records[0].get('p'));
}

export class GraphStore {
  constructor(driver, { timeoutMs = 5000 } = {}) {
    this.driver = driver;
    this.timeoutMs = timeoutMs;
  }

  async read(callback) {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      return await session.executeRead(callback, { timeout: this.timeoutMs });
    } finally {
      await session.close();
    }
  }

  async getEntity(id) {
    return this.read((tx) => getEntityIn(tx, id));
  }

  async listEntities({ search = '', filter = {}, sort = 'id', order = 'asc', limit = 50, after = null } = {}) {
    if (!Object.hasOwn(ENTITY_PAGES, order)) throw new ApiError(400, 'invalid_order', 'Order must be asc or desc.');
    const params = {
      search: search.toLowerCase(), filter, sort, maxFinite: Number.MAX_VALUE,
      take: neo4j.int(limit + 1), ...parseCursor(after),
    };
    return this.read(async (tx) => {
      const invalid = await tx.run(CHECK_SORT, params);
      if (invalid.records.length) {
        throw new ApiError(400, 'unsupported_sort', 'Sorting requires finite scalar values; lists, temporal, and spatial values cannot be sorted.');
      }
      const result = await tx.run(ENTITY_PAGES[order], params);
      const hasMore = result.records.length > limit;
      const page = result.records.slice(0, limit);
      const last = page.at(-1);
      return {
        entities: page.map((record) => entity(record.get('p'))),
        after: hasMore && last ? {
          id: last.get('p').id,
          rank: Number(last.get('rank')),
          value: cursorValue(last.get('value')),
        } : null,
      };
    });
  }

  async listLinks(id, { limit = 100, after = null } = {}) {
    return this.read(async (tx) => {
      const root = await getEntityIn(tx, id);
      const result = await tx.run(LINK_PAGE, { id, after, take: neo4j.int(limit + 1) });
      const page = result.records.slice(0, limit);
      const entities = new Map([[root.id, root]]);
      const links = [];
      for (const record of page) {
        const neighbor = entity(record.get('p'));
        entities.set(neighbor.id, neighbor);
        links.push(link(id, neighbor.id, record.get('link')));
      }
      return {
        entities: [...entities.values()], links,
        after: result.records.length > limit && page.length ? page.at(-1).get('p').id : null,
      };
    });
  }

  async subgraph({ ids, depth = 1, max_entities = 100, max_links = 200 }) {
    return this.read(async (tx) => {
      const seeds = [...new Set(ids)];
      const initial = await tx.run(GET_SEEDS, { ids: seeds });
      const entities = new Map(initial.records.map((record) => {
        const item = entity(record.get('p'));
        return [item.id, item];
      }));
      if (seeds.some((id) => !entities.has(id))) throw new ApiError(404, 'not_found', 'One or more seed entities were not found.');
      let frontier = [...entities.keys()];
      let truncated = false;
      for (let hop = 0; hop < depth && frontier.length; hop++) {
        const remaining = max_entities - entities.size;
        const expanded = await tx.run(EXPAND_LAYER, {
          frontier, seen: [...entities.keys()], take: neo4j.int(remaining + 1),
        });
        const next = expanded.records.slice(0, remaining).map((record) => entity(record.get('p')));
        for (const item of next) entities.set(item.id, item);
        if (expanded.records.length > remaining) {
          truncated = true;
          break;
        }
        frontier = next.map((item) => item.id);
      }
      const edges = await tx.run(INDUCED_LINKS, {
        ids: [...entities.keys()], take: neo4j.int(max_links + 1),
      });
      if (edges.records.length > max_links) truncated = true;
      const links = edges.records.slice(0, max_links).map((record) =>
        link(record.get('a'), record.get('b'), record.get('p')));
      return {
        entities: [...entities.values()], links, truncated,
        limits: { depth, max_entities, max_links },
      };
    });
  }
}
