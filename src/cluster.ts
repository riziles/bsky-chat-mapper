/**
 * Clustering for message embeddings with temporal proximity and reply-chain awareness.
 *
 * Algorithm:
 *   1. Preprocess: resolve reply chains into forced same-cluster groups
 *   2. Compute combined score: w_sem * cosineSim + w_temp * temporalProximity
 *   3. Single-pass greedy assignment using combined score
 *   4. Refinement passes with recomputed centroids
 */

import { cosineSim } from "@ternlight/mini";
import type { StoredMessage } from "./db.ts";

export interface TopicCluster {
  id: number;
  label: string;
  messageIds: string[];
  size: number;
  centroid: number[];
}

export interface ClusterResult {
  clusters: TopicCluster[];
  similarities: { from: number; to: number; sim: number }[];
  /** Clusters that were forced together by reply chains */
  replyChains?: { fromId: string; toId: string }[];
}

const HALF_LIFE = 10; // half-life in message-position distance
const W_SEMANTIC = 0.7;
const W_CHRONO = 0.3;

/**
 * Chronological proximity: messages closer in the conversation's
 * sequence order are more likely related. Uses position index, not
 * wall-clock time — two messages back-to-back at midnight get the
 * same boost as two back-to-back at noon.
 */
function chronoProximity(posA: number, posB: number): number {
  const delta = Math.abs(posA - posB);
  return Math.pow(0.5, delta / HALF_LIFE);
}

/**
 * Combined score: weighted blend of semantic and chronological proximity.
 */
function combinedScore(
  vecA: Float32Array,
  vecB: Float32Array,
  posA: number,
  posB: number,
): number {
  const sem = Math.max(0, cosineSim(vecA, vecB));
  const chrono = chronoProximity(posA, posB);
  return W_SEMANTIC * sem + W_CHRONO * chrono;
}

// Helper: L2-normalize a vector
function norm(v: number[]): Float32Array {
  const arr = new Float32Array(v);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += arr[i] * arr[i];
  const mag = Math.sqrt(sumSq);
  if (mag > 0.001) {
    for (let i = 0; i < arr.length; i++) arr[i] /= mag;
  }
  return arr;
}

function meanVec(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const result = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) result[i] += v[i];
  }
  for (let i = 0; i < dim; i++) result[i] /= vectors.length;
  return norm(Array.from(result));
}

/**
 * Resolve reply chains using Union-Find.
 * Returns a map: messageId → rootId of its reply-chain group.
 */
function resolveReplyChains(
  messages: StoredMessage[],
): Map<string, string> {
  const parent = new Map<string, string>();
  const idSet = new Set(messages.map((m) => m.id));

  function find(x: string): string {
    const p = parent.get(x);
    if (!p || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Initialize each message as its own set
  for (const m of messages) {
    parent.set(m.id, m.id);
  }

  // For each message with a replyTo, union them
  const replyChains: { fromId: string; toId: string }[] = [];
  for (const m of messages) {
    if (m.replyTo && idSet.has(m.replyTo)) {
      union(m.id, m.replyTo);
      replyChains.push({ fromId: m.id, toId: m.replyTo });
    }
  }

  return parent;
}

/**
 * Pre-cluster messages that belong to reply chains.
 * Returns:
 *   forcedGroups: array of pre-formed groups (each group is a set of messageIds)
 *   remaining: messages that are NOT in any reply chain
 *   replyChains: the reply edges found
 */
function preClusterReplyChains(
  messages: StoredMessage[],
): {
  forcedGroups: Set<string>[];
  remaining: StoredMessage[];
  replyChains: { fromId: string; toId: string }[];
} {
  const parent = resolveReplyChains(messages);

  // Collect groups (by root)
  const groups = new Map<string, Set<string>>();
  for (const m of messages) {
    const root = parent.get(m.id)!;
    // Only form groups for messages that actually have replies
    const hasReplies = messages.some(
      (o) => o.replyTo === m.id || (o.id !== m.id && parent.get(o.id) === root),
    );
    if (parent.get(m.id) !== m.id || hasReplies) {
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root)!.add(m.id);
    }
  }

  const forcedGroups: Set<string>[] = [];
  const groupedIds = new Set<string>();
  for (const g of groups.values()) {
    if (g.size > 1) {
      forcedGroups.push(g);
      for (const id of g) groupedIds.add(id);
    }
  }

  const remaining = messages.filter((m) => !groupedIds.has(m.id));

  // Collect reply edges
  const replyChains: { fromId: string; toId: string }[] = [];
  for (const m of messages) {
    if (m.replyTo && groupedIds.has(m.id)) {
      replyChains.push({ fromId: m.id, toId: m.replyTo });
    }
  }

  return { forcedGroups, remaining, replyChains };
}

/**
 * Cluster messages using combined semantic + temporal score,
 * with reply chains as hard constraints.
 */
export function clusterMessages(
  messages: StoredMessage[],
  opts: {
    minSimilarity?: number;
    maxClusters?: number;
    passes?: number;
    wSemantic?: number;
    wChrono?: number;
    chronoHalfLife?: number; // position-distance half-life
    onProgress?: (pass: number, clusters: number) => void;
  } = {},
): ClusterResult {
  const minSim = opts.minSimilarity ?? 0.4; // lowered from 0.65 because temporal adds
  const maxClusters = opts.maxClusters ?? 50;
  const numPasses = opts.passes ?? 3;

  const embedded = messages.filter(
    (m) => m.embedding != null && m.embedding.length > 0,
  );
  if (embedded.length === 0) {
    return { clusters: [], similarities: [] };
  }

  // Preprocess reply chains
  const { forcedGroups, remaining, replyChains } =
    preClusterReplyChains(embedded);

  // Sort by sentAt ascending to build chronological position index
  const sorted = [...embedded].sort(
    (a, b) => a.sentAt.localeCompare(b.sentAt),
  );
  const position = new Map<string, number>();
  sorted.forEach((m, i) => position.set(m.id, i));

  // Pre-compute normalized vectors and positions
  const msgMap = new Map(embedded.map((m) => [m.id, m]));
  const getVec = (id: string) => {
    const m = msgMap.get(id);
    return m ? norm(m.embedding!) : new Float32Array(384);
  };
  const getPos = (id: string) => position.get(id) ?? 0;

  // Initialize clusters from forced groups
  let clusters: { ids: string[]; centroid: Float32Array }[] = [];
  for (const group of forcedGroups) {
    const ids = [...group];
    const vecs = ids.map(getVec);
    clusters.push({ ids, centroid: meanVec(vecs) });
  }

  // Greedy assignment for remaining messages
  for (const msg of remaining) {
    const vec = getVec(msg.id);
    const pos = getPos(msg.id);

    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < clusters.length; i++) {
      const cPos = clusters[i].ids.length > 0
        ? getPos(clusters[i].ids[0])
        : pos;
      const score = combinedScore(vec, clusters[i].centroid, pos, cPos);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore >= minSim) {
      clusters[bestIdx].ids.push(msg.id);
    } else if (clusters.length < maxClusters) {
      clusters.push({ ids: [msg.id], centroid: vec });
    } else if (bestIdx >= 0) {
      clusters[bestIdx].ids.push(msg.id);
    }
  }

  // Refinement passes
  for (let pass = 0; pass < numPasses; pass++) {
    opts.onProgress?.(pass + 1, clusters.length);

    // Recompute centroids
    for (const c of clusters) {
      const vecs = c.ids.map(getVec);
      if (vecs.length > 0) c.centroid = meanVec(vecs);
    }

    // Reassign (but don't split forced groups)
    const newClusters: { ids: string[]; centroid: Float32Array }[] =
      clusters.map((c) => ({ ids: [] as string[], centroid: c.centroid }));

    for (const c of clusters) {
      for (const id of c.ids) {
        const vec = getVec(id);
        const pos = getPos(id);
        const isForced = forcedGroups.some((g) => g.has(id));
        const forcedIdx = clusters.findIndex((cl) => cl.ids.includes(id));

        let bestIdx = forcedIdx >= 0 ? forcedIdx : -1;
        let bestScore = forcedIdx >= 0
          ? combinedScore(vec, clusters[forcedIdx].centroid, pos, getPos(clusters[forcedIdx].ids[0]))
          : -1;

        // Only consider reassignment if not in a forced group
        if (!isForced) {
          for (let i = 0; i < newClusters.length; i++) {
            const cPos = newClusters[i].ids.length > 0
              ? getPos(newClusters[i].ids[0])
              : pos;
            const score = combinedScore(vec, newClusters[i].centroid, pos, cPos);
            if (score > bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }
        }

        // Don't reassign forced group members outside their group
        if (bestIdx >= 0 && (!isForced || bestIdx === forcedIdx)) {
          newClusters[bestIdx].ids.push(id);
        }
      }
    }

    clusters = newClusters.filter((c) => c.ids.length > 0);
  }

  // Compute similarities between clusters
  const similarities: { from: number; to: number; sim: number }[] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const sim = cosineSim(clusters[i].centroid, clusters[j].centroid);
      if (sim >= 0.3) {
        similarities.push({ from: i, to: j, sim: Math.round(sim * 1000) / 1000 });
      }
    }
  }

  // Label clusters
  const result: TopicCluster[] = clusters.map((c, idx) => ({
    id: idx,
    label: topBigramLabel(c.ids, embedded),
    messageIds: c.ids,
    size: c.ids.length,
    centroid: Array.from(c.centroid),
  }));

  result.sort((a, b) => b.size - a.size);

  return { clusters: result, similarities, replyChains };
}

function topBigramLabel(ids: string[], messages: StoredMessage[]): string {
  const idSet = new Set(ids);
  const texts = messages
    .filter((m) => idSet.has(m.id))
    .map((m) => m.text);

  const bigramCounts = new Map<string, number>();
  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "you", "are", "not", "was",
    "but", "have", "from", "they", "all", "can", "had", "has", "been", "were",
    "will", "would", "what", "when", "your", "how", "said", "there", "their",
    "its", "just", "like", "more", "some", "than", "then", "very", "also",
    "into", "only", "other", "over", "such", "than", "that", "them", "these",
    "which", "who", "about", "after", "could", "should", "because", "i'm",
    "it's", "don't", "i", "me", "my", "we", "our", "he", "she", "him", "her",
    "his", "do", "does", "did", "is", "am", "be", "or", "if", "to", "of",
    "in", "on", "at", "a", "an", "by", "up", "so", "no", "out", "now", "one",
    "get", "got", "as", "it", "de", "la", "el", "en", "un", "que", "los",
  ]);

  for (const text of texts) {
    const words = text
      .toLowerCase()
      .replace(/[^a-záéíóúñü0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (!stopWords.has(words[i]) || !stopWords.has(words[i + 1])) {
        bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
      }
    }
  }

  let topBigram = "unnamed cluster";
  let topCount = 0;
  for (const [bg, count] of bigramCounts) {
    if (count > topCount && bg.length >= 5) {
      topBigram = bg;
      topCount = count;
    }
  }

  return topBigram;
}
