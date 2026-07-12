/**
 * Lightweight flat clustering for message embeddings.
 *
 * Uses a single-pass greedy approach:
 * 1. For each message, find the nearest existing cluster centroid
 * 2. If similarity > threshold, add to that cluster; else start a new one
 * 3. Recompute centroids
 * 4. Repeat for a few refinement passes
 *
 * Clusters are labeled by their most frequent bigrams.
 */

import { cosineSim } from "@ternlight/mini";
import type { StoredMessage } from "./db.ts";

export interface TopicCluster {
  id: number;
  label: string;
  messageIds: string[];
  size: number;
  /** Centroid embedding (mean of member embeddings) */
  centroid: number[];
}

export interface ClusterResult {
  clusters: TopicCluster[];
  /** Similarity between each pair of clusters for edge drawing */
  similarities: { from: number; to: number; sim: number }[];
}

/**
 * Cluster messages by embedding similarity.
 *
 * @param messages - Messages with embeddings
 * @param minSimilarity - Threshold for adding to an existing cluster (default 0.65)
 * @param maxClusters - Maximum number of clusters (default 40)
 * @param passes - Number of refinement passes (default 3)
 */
export function clusterMessages(
  messages: StoredMessage[],
  opts: {
    minSimilarity?: number;
    maxClusters?: number;
    passes?: number;
    onProgress?: (pass: number, clusters: number) => void;
  } = {},
): ClusterResult {
  const minSim = opts.minSimilarity ?? 0.65;
  const maxClusters = opts.maxClusters ?? 40;
  const numPasses = opts.passes ?? 3;

  // Only use messages that have embeddings
  const embedded = messages.filter(
    (m) => m.embedding != null && m.embedding.length > 0,
  );
  if (embedded.length === 0) {
    return { clusters: [], similarities: [] };
  }

  // Helper: L2-normalize a vector (ternlight already normalizes, but be safe)
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

  // Initial assignment: first pass
  let clusters: { ids: string[]; centroid: Float32Array }[] = [];

  for (const msg of embedded) {
    const vec = norm(msg.embedding!);
    let bestIdx = -1;
    let bestSim = -1;

    for (let i = 0; i < clusters.length; i++) {
      const sim = cosineSim(vec, clusters[i].centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= minSim) {
      clusters[bestIdx].ids.push(msg.id);
    } else if (clusters.length < maxClusters) {
      clusters.push({ ids: [msg.id], centroid: vec });
    } else {
      // All clusters full, add to best match anyway
      if (bestIdx >= 0) {
        clusters[bestIdx].ids.push(msg.id);
      }
    }
  }

  // Refinement passes
  for (let pass = 0; pass < numPasses; pass++) {
    opts.onProgress?.(pass + 1, clusters.length);

    // Recompute centroids
    const msgMap = new Map(embedded.map((m) => [m.id, m]));
    for (const c of clusters) {
      const vectors = c.ids
        .map((id) => msgMap.get(id)?.embedding)
        .filter((e): e is number[] => e != null)
        .map((e) => norm(e));
      if (vectors.length > 0) {
        c.centroid = meanVec(vectors);
      }
    }

    // Reassign messages
    const newClusters: { ids: string[]; centroid: Float32Array }[] = [];
    for (const c of clusters) {
      if (c.ids.length === 0) continue;
      newClusters.push({ ids: [], centroid: c.centroid });
    }

    for (const msg of embedded) {
      let bestIdx = -1;
      let bestSim = -1;

      for (let i = 0; i < newClusters.length; i++) {
        const sim = cosineSim(norm(msg.embedding!), newClusters[i].centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        newClusters[bestIdx].ids.push(msg.id);
      }
    }

    // Remove empty clusters
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

  // Label clusters by top bigrams
  const result: TopicCluster[] = clusters.map((c, idx) => ({
    id: idx,
    label: topBigramLabel(c.ids, embedded),
    messageIds: c.ids,
    size: c.ids.length,
    centroid: Array.from(c.centroid),
  }));

  // Sort by size descending
  result.sort((a, b) => b.size - a.size);

  return { clusters: result, similarities };
}

/**
 * Extract the most frequent meaningful bigram from a set of message texts.
 */
function topBigramLabel(
  ids: string[],
  messages: StoredMessage[],
): string {
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

  // Find top bigram, excluding pairs where both are stopwords
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
