import { newId } from "../lib/crypto.ts";
import { blocksFromText, chunkBlocks, contentHash, decodeEntities } from "./chunk.ts";
import { embed } from "./embeddings.ts";
import { extractPage } from "./extract.ts";
import { isExcluded, normalizeUrl } from "./urls.ts";

// Knowledge sources: websites (crawled through a Queue) and snippets (indexed directly).

export type CrawlJob =
  | { type: "sync"; sourceId: string }
  | { type: "page"; sourceId: string; syncToken: string; url: string; depth: number; follow: boolean };

export const DEFAULT_MAX_PAGES = 200;
const MAX_DEPTH = 3;
const MAX_PAGE_BYTES = 2_000_000;
const USER_AGENT = "JunDeskBot/0.1 (+https://github.com/samarsheikh001/jun-desk-2)";
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|csv)$/i;

interface SourceRow {
  id: string;
  workspace_id: string;
  kind: "website" | "snippet";
  url: string | null;
  title: string;
  body: string | null;
  settings: string;
}

export interface SourceSettings {
  maxPages?: number;
  syncToken?: string;
  disallow?: string[];
  /** K-04: pages the admin left out. Full URLs match exactly; "/path" entries are path prefixes ("*" = any). */
  exclude?: string[];
}

const index = (env: Env, workspaceId: string) => env.KNOWLEDGE_INDEX.getByName(workspaceId);

async function loadSource(env: Env, sourceId: string): Promise<SourceRow | null> {
  return env.DB.prepare("SELECT id, workspace_id, kind, url, title, body, settings FROM kb_sources WHERE id = ?").bind(sourceId).first<SourceRow>();
}

/** Chunk, embed and store text for one document (or snippet), replacing its old chunks. */
async function indexText(
  env: Env,
  target: { workspaceId: string; sourceId: string; documentId: string | null; url: string | null; title: string },
  blocks: ReturnType<typeof blocksFromText>,
): Promise<number> {
  const chunks = chunkBlocks(blocks).slice(0, 200);
  const vectors = chunks.length ? await embed(env, chunks.map((c) => `${target.title}\n${c.heading}\n${c.text}`)) : [];

  const old = await env.DB.prepare(target.documentId ? "SELECT id FROM kb_chunks WHERE document_id = ?" : "SELECT id FROM kb_chunks WHERE source_id = ? AND document_id IS NULL")
    .bind(target.documentId ?? target.sourceId)
    .all<{ id: string }>();
  if (old.results.length) await index(env, target.workspaceId).deleteChunks(old.results.map((r) => r.id));

  const rows = chunks.map((c, position) => ({ id: newId("chk"), ...c, position }));
  await env.DB.batch([
    target.documentId
      ? env.DB.prepare("DELETE FROM kb_chunks WHERE document_id = ?").bind(target.documentId)
      : env.DB.prepare("DELETE FROM kb_chunks WHERE source_id = ? AND document_id IS NULL").bind(target.sourceId),
    ...rows.map((r) =>
      env.DB.prepare(
        "INSERT INTO kb_chunks (id, workspace_id, source_id, document_id, url, title, heading, text, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(r.id, target.workspaceId, target.sourceId, target.documentId, target.url, target.title, r.heading, r.text, r.position),
    ),
  ]);
  if (rows.length) {
    await index(env, target.workspaceId).upsert(rows.map((r, i) => ({ chunkId: r.id, sourceId: target.sourceId, vector: vectors[i]! })));
  }
  return rows.length;
}

export async function indexSnippet(env: Env, sourceId: string): Promise<void> {
  const source = await loadSource(env, sourceId);
  if (!source || source.kind !== "snippet") return;
  await indexText(env, { workspaceId: source.workspace_id, sourceId, documentId: null, url: null, title: source.title }, blocksFromText(source.body ?? ""));
  await env.DB.prepare("UPDATE kb_sources SET status = 'ready', page_count = 1, last_synced_at = ?, error = NULL WHERE id = ?").bind(Date.now(), sourceId).run();
}

/** K-04: takes one page out of the knowledge base, and keeps it out of future crawls. */
export async function removeDocument(env: Env, workspaceId: string, sourceId: string, documentId: string): Promise<boolean> {
  const doc = await env.DB.prepare("SELECT d.url, s.settings FROM kb_documents d JOIN kb_sources s ON s.id = d.source_id WHERE d.id = ? AND d.source_id = ? AND s.workspace_id = ?")
    .bind(documentId, sourceId, workspaceId)
    .first<{ url: string; settings: string }>();
  if (!doc) return false;
  const chunks = await env.DB.prepare("SELECT id FROM kb_chunks WHERE document_id = ?").bind(documentId).all<{ id: string }>();
  if (chunks.results.length) await index(env, workspaceId).deleteChunks(chunks.results.map((r) => r.id));
  const settings = JSON.parse(doc.settings) as SourceSettings;
  settings.exclude = [...new Set([...(settings.exclude ?? []), doc.url])].slice(0, 500);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_documents WHERE id = ?").bind(documentId),
    env.DB.prepare(
      "UPDATE kb_sources SET settings = ?, page_count = (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL) WHERE id = ?2",
    ).bind(JSON.stringify(settings), sourceId),
  ]);
  return true;
}

export async function deleteSource(env: Env, workspaceId: string, sourceId: string): Promise<void> {
  await index(env, workspaceId).deleteSource(sourceId);
  await env.DB.prepare("DELETE FROM kb_sources WHERE id = ? AND workspace_id = ?").bind(sourceId, workspaceId).run();
}

// ---------- website crawling ----------

function inScope(url: URL, start: URL): boolean {
  if (url.origin !== start.origin) return false;
  const dir = start.pathname.endsWith("/") ? start.pathname : start.pathname.slice(0, start.pathname.lastIndexOf("/") + 1);
  return url.pathname.startsWith(dir) && !SKIP_EXTENSIONS.test(url.pathname);
}

function allowedByRobots(url: URL, disallow: string[]): boolean {
  return !disallow.some((rule) => {
    const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`);
    return pattern.test(url.pathname + url.search);
  });
}

/** Disallow rules for `*` (or us) and any Sitemap: lines. */
async function readRobots(origin: string): Promise<{ disallow: string[]; sitemaps: string[] }> {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { disallow, sitemaps };
    let applies = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const [field, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      const key = field?.toLowerCase();
      if (key === "user-agent") applies = value === "*" || /jundeskbot/i.test(value);
      else if (key === "disallow" && applies && value) disallow.push(value);
      else if (key === "sitemap" && value) sitemaps.push(value);
    }
  } catch {
    // no robots.txt: everything allowed
  }
  return { disallow, sitemaps };
}

/** URLs from a sitemap (follows one level of sitemap index). */
async function readSitemap(url: string, depth = 0): Promise<string[]> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!));
    if (/<sitemapindex/i.test(xml) && depth === 0) {
      const nested = await Promise.all(locs.slice(0, 20).map((l) => readSitemap(l, 1)));
      return nested.flat();
    }
    return locs;
  } catch {
    return [];
  }
}

/**
 * Claims URLs for this sync (dedupes across jobs via UNIQUE(source_id, url)), respecting
 * the page cap, and enqueues a page job for each newly claimed URL.
 */
async function claimAndEnqueue(env: Env, source: SourceRow, settings: SourceSettings, urls: URL[], depth: number, follow: boolean): Promise<number> {
  const syncToken = settings.syncToken!;
  const maxPages = settings.maxPages ?? DEFAULT_MAX_PAGES;
  const { claimed } = (await env.DB.prepare("SELECT COUNT(*) AS claimed FROM kb_documents WHERE source_id = ? AND sync_token = ?")
    .bind(source.id, syncToken)
    .first<{ claimed: number }>())!;
  let budget = maxPages - claimed;
  const jobs: CrawlJob[] = [];
  for (const url of urls) {
    if (budget <= 0) break;
    if (isExcluded(url, settings.exclude)) continue;
    const href = url.toString();
    const row = await env.DB.prepare(
      `INSERT INTO kb_documents (id, workspace_id, source_id, url, sync_token, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, url) DO UPDATE SET sync_token = excluded.sync_token
       WHERE kb_documents.sync_token IS NOT excluded.sync_token
       RETURNING id`,
    )
      .bind(newId("doc"), source.workspace_id, source.id, href, syncToken, Date.now())
      .first();
    if (!row) continue; // already claimed in this sync
    budget--;
    jobs.push({ type: "page", sourceId: source.id, syncToken, url: href, depth, follow });
  }
  if (jobs.length === 0) return 0;
  await env.DB.prepare("UPDATE kb_sources SET pending_jobs = pending_jobs + ? WHERE id = ?").bind(jobs.length, source.id).run();
  for (let i = 0; i < jobs.length; i += 100) await env.CRAWL_QUEUE.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
  return jobs.length;
}

/** Starts (or restarts) a crawl of a website source. */
export async function startSync(env: Env, sourceId: string): Promise<void> {
  await env.CRAWL_QUEUE.send({ type: "sync", sourceId } satisfies CrawlJob);
}

async function runSync(env: Env, sourceId: string): Promise<void> {
  const source = await loadSource(env, sourceId);
  if (!source || source.kind !== "website" || !source.url) return;
  const start = normalizeUrl(source.url);
  if (!start) {
    await env.DB.prepare("UPDATE kb_sources SET status = 'error', error = 'Invalid URL' WHERE id = ?").bind(sourceId).run();
    return;
  }

  const robots = await readRobots(start.origin);
  const settings: SourceSettings = { ...(JSON.parse(source.settings) as SourceSettings), syncToken: newId("sync"), disallow: robots.disallow };
  await env.DB.prepare("UPDATE kb_sources SET status = 'syncing', error = NULL, pending_jobs = 0, settings = ? WHERE id = ?")
    .bind(JSON.stringify(settings), sourceId)
    .run();

  // Prefer the sitemap; fall back to following links from the start page.
  const fromSitemaps = (await Promise.all([...new Set([...robots.sitemaps, `${start.origin}/sitemap.xml`])].map((s) => readSitemap(s)))).flat();
  const sitemapUrls = fromSitemaps
    .map(normalizeUrl)
    .filter((u): u is URL => u !== null && inScope(u, start) && allowedByRobots(u, robots.disallow));

  const enqueued = sitemapUrls.length
    ? await claimAndEnqueue(env, source, settings, [start, ...sitemapUrls], 0, false)
    : await claimAndEnqueue(env, source, settings, [start], 0, true);
  if (enqueued === 0) await finishSync(env, source, settings);
}

async function runPage(env: Env, job: Extract<CrawlJob, { type: "page" }>): Promise<void> {
  const source = await loadSource(env, job.sourceId);
  if (!source) return;
  const settings = JSON.parse(source.settings) as SourceSettings;
  if (settings.syncToken !== job.syncToken) return; // superseded by a newer sync

  try {
    const url = new URL(job.url);
    if (!allowedByRobots(url, settings.disallow ?? []) || isExcluded(url, settings.exclude)) return;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES) return;

    const page = await extractPage(res, res.url || job.url);
    const text = page.blocks.map((b) => b.text).join("\n");
    const hash = await contentHash(`${page.title}\n${text}`);
    const doc = await env.DB.prepare("SELECT id, content_hash FROM kb_documents WHERE source_id = ? AND url = ?")
      .bind(source.id, job.url)
      .first<{ id: string; content_hash: string | null }>();

    if (doc && doc.content_hash !== hash && text.length > 50) {
      const title = page.title || url.pathname;
      await indexText(env, { workspaceId: source.workspace_id, sourceId: source.id, documentId: doc.id, url: job.url, title }, page.blocks);
      await env.DB.prepare("UPDATE kb_documents SET title = ?, content_hash = ?, updated_at = ? WHERE id = ?").bind(title, hash, Date.now(), doc.id).run();
    }

    if (job.follow && job.depth < MAX_DEPTH) {
      const start = normalizeUrl(source.url!)!;
      const links = page.links
        .map(normalizeUrl)
        .filter((u): u is URL => u !== null && inScope(u, start) && allowedByRobots(u, settings.disallow ?? []));
      await claimAndEnqueue(env, source, settings, links, job.depth + 1, true);
    }
  } catch (error) {
    console.error(`crawl ${job.url}:`, error);
    // Remembered so a crawl that reads nothing can say why.
    await env.DB.prepare("UPDATE kb_sources SET error = ? WHERE id = ?").bind(`${job.url}: ${(error as Error).message}`.slice(0, 300), source.id).run();
  } finally {
    const row = await env.DB.prepare("UPDATE kb_sources SET pending_jobs = pending_jobs - 1 WHERE id = ? RETURNING pending_jobs")
      .bind(source.id)
      .first<{ pending_jobs: number }>();
    if (row && row.pending_jobs <= 0) await finishSync(env, source, settings);
  }
}

/** After the last page: drop pages that disappeared from the site and mark the source ready. */
async function finishSync(env: Env, source: SourceRow, settings: SourceSettings): Promise<void> {
  const stale = await env.DB.prepare("SELECT c.id FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id WHERE d.source_id = ? AND d.sync_token IS NOT ?")
    .bind(source.id, settings.syncToken)
    .all<{ id: string }>();
  if (stale.results.length) await index(env, source.workspace_id).deleteChunks(stale.results.map((r) => r.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_documents WHERE source_id = ? AND sync_token IS NOT ?").bind(source.id, settings.syncToken),
    // A crawl that indexed nothing is an error the admin should see, not "ready, 0 pages".
    env.DB.prepare(
      `UPDATE kb_sources SET last_synced_at = ?1,
         page_count = (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL),
         status = CASE WHEN (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL) > 0 THEN 'ready' ELSE 'error' END,
         error = CASE WHEN (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL) > 0 THEN NULL
                      ELSE COALESCE('No readable pages. Last error: ' || error, 'No readable pages found at this URL.') END
       WHERE id = ?2`,
    ).bind(Date.now(), source.id),
  ]);
}

/** Queue consumer. Every job is acknowledged; failures are logged, not retried forever. */
export async function handleCrawlBatch(batch: MessageBatch<CrawlJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.type === "sync") await runSync(env, message.body.sourceId);
      else await runPage(env, message.body);
    } catch (error) {
      console.error("crawl job failed:", error);
    }
    message.ack();
  }
}

/** Daily re-sync of website sources (cron). Unchanged pages are skipped by content hash. */
export async function resyncAll(env: Env): Promise<void> {
  const due = await env.DB.prepare("SELECT id FROM kb_sources WHERE kind = 'website' AND status != 'syncing' AND (last_synced_at IS NULL OR last_synced_at < ?)")
    .bind(Date.now() - 20 * 60 * 60 * 1000)
    .all<{ id: string }>();
  for (const { id } of due.results) await startSync(env, id);
}
