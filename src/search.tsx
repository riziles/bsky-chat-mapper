import { useState, useCallback } from "preact/hooks";
import { embed, cosineSim } from "@ternlight/mini";
import { getEmbeddedMessages, type StoredMessage } from "./db.ts";

interface Props {
  convoId: string;
}

interface SearchResult {
  msg: StoredMessage;
  score: number;
}

export function MessageSearch({ convoId }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    try {
      const queryVec = embed(q);
      const msgs = await getEmbeddedMessages(convoId);
      const scored = msgs.map((msg) => ({
        msg,
        score: cosineSim(queryVec, new Float32Array(msg.embedding!)),
      }));
      scored.sort((a, b) => b.score - a.score);
      setResults(scored.slice(0, 20));
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }, [query, convoId]);

  return (
    <div class="message-search">
      <h3>🔍 Search Messages</h3>
      <div class="message-search-bar">
        <input
          type="text"
          placeholder='e.g. "cooking" or "plans for weekend"'
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
          <p class="search-count">
            Top {results.length} matches (of {results.length}+)
          </p>
          <ul class="search-result-list">
            {results.map((r) => (
              <li key={r.msg.id} class="search-result-item">
                <div class="search-result-header">
                  <span class="search-result-sender">
                    {r.msg.senderDisplayName || r.msg.senderHandle || "unknown"}
                  </span>
                  <span class="search-result-score">
                    {(r.score * 100).toFixed(0)}%
                  </span>
                </div>
                <div class="search-result-text">{r.msg.text}</div>
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
