import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import MiniSearch from "minisearch";
import { embed, cosineSim } from "@ternlight/mini";
import { getEmbeddedMessages, type StoredMessage } from "./db.ts";
import { safeText } from "./utils.ts";

interface Props {
  convoId: string;
}

type SearchMode = "semantic" | "fuzzy";

interface SearchResult {
  msg: StoredMessage;
  score: number;
  matchTerms?: string[];
}

export function MessageSearch({ convoId }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [mode, setMode] = useState<SearchMode>("fuzzy");
  const [fuzzyLevel, setFuzzyLevel] = useState(0.2);

  const miniSearchRef = useRef<MiniSearch | null>(null);
  const msgCacheRef = useRef<Map<string, StoredMessage>>(new Map());
  const indexReady = useRef(false);

  // Build MiniSearch index once
  useEffect(() => {
    if (indexReady.current) return;
    indexReady.current = true;

    getEmbeddedMessages(convoId).then((msgs) => {
      const cache = new Map<string, StoredMessage>();
      for (const m of msgs) cache.set(m.id, m);
      msgCacheRef.current = cache;

      const mini = new MiniSearch({
        fields: ["text", "senderDisplayName", "senderHandle"],
        storeFields: ["id"],
        searchOptions: {
          boost: { text: 2, senderDisplayName: 1 },
          fuzzy: 0.2,
          prefix: true,
        },
      });
      mini.addAll(
        msgs.map((m) => ({
          id: m.id,
          text: m.text,
          senderDisplayName: m.senderDisplayName ?? "",
          senderHandle: m.senderHandle ?? "",
        })),
      );
      miniSearchRef.current = mini;
    });
  }, [convoId]);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);

    try {
      if (mode === "fuzzy") {
        const mini = miniSearchRef.current;
        if (!mini) return;
        const raw = mini.search(q, { fuzzy: fuzzyLevel, prefix: true });
        const scored: SearchResult[] = raw.slice(0, 20).map((r) => {
          const msg = msgCacheRef.current.get(r.id);
          return {
            msg: msg!,
            score: r.score,
            matchTerms: Object.keys(r.match).filter((k) => r.match[k].length > 0),
          };
        });
        setResults(scored);
      } else {
        const queryVec = embed(q);
        const msgs = await getEmbeddedMessages(convoId);
        const scored: SearchResult[] = msgs
          .map((msg) => ({
            msg,
            score: cosineSim(queryVec, new Float32Array(msg.embedding!)),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
        setResults(scored);
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }, [query, mode, fuzzyLevel, convoId]);

  return (
    <div class="message-search">
      <h3>🔍 Search Messages</h3>

      <div class="search-mode-bar">
        <label class="search-mode-label">
          <input
            type="radio"
            name="search-mode"
            checked={mode === "fuzzy"}
            onChange={() => setMode("fuzzy")}
          />
          Fuzzy text
        </label>
        <label class="search-mode-label">
          <input
            type="radio"
            name="search-mode"
            checked={mode === "semantic"}
            onChange={() => setMode("semantic")}
          />
          Semantic
        </label>
        {mode === "fuzzy" && (
          <label class="fuzzy-slider">
            <span>Fuzziness: {fuzzyLevel.toFixed(2)}</span>
            <input
              type="range"
              min="0"
              max="0.4"
              step="0.05"
              value={fuzzyLevel}
              onInput={(e) => setFuzzyLevel(Number(e.currentTarget.value))}
            />
          </label>
        )}
      </div>

      <div class="message-search-bar">
        <input
          type="text"
          placeholder={
            mode === "fuzzy"
              ? 'e.g. "cookin" (typos OK)'
              : 'e.g. "cooking" (meaning match)'
          }
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button onClick={handleSearch} disabled={searching}>
          {searching ? "…" : "Search"}
        </button>
      </div>

      {searched && results.length === 0 && !searching && (
        <p class="search-empty">No matching messages found.</p>
      )}

      {results.length > 0 && (
        <div class="search-results">
          <p class="search-count">Top {results.length} matches</p>
          <ul class="search-result-list">
            {results.map((r) => (
              <li key={r.msg.id} class="search-result-item">
                <div class="search-result-header">
                  <span class="search-result-sender">
                    {r.msg.senderDisplayName || r.msg.senderHandle || "unknown"}
                  </span>
                  <span class="search-result-score">
                    {mode === "semantic"
                      ? `${(r.score * 100).toFixed(0)}%`
                      : `score ${r.score.toFixed(1)}`}
                    {r.matchTerms && r.matchTerms.length > 0 && (
                      <span class="match-terms">
                        {" — "}
                        {r.matchTerms.slice(0, 3).join(", ")}
                      </span>
                    )}
                  </span>
                </div>
                <div class="search-result-text">{safeText(r.msg.text)}</div>
                <div class="search-result-time">
                  {new Date(r.msg.sentAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
