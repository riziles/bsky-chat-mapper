/**
 * Web Worker: loads @ternlight/mini WASM and embeds batches of text.
 *
 * Message format (from main thread):
 *   { type: "embed", id: number, texts: string[] }
 *   { type: "info" }
 */

let ready = false;
let embedFn: ((text: string) => Float32Array) | null = null;
let engineInfoFn: (() => string) | null = null;

async function init() {
  if (ready) return;
  const tern = await import("@ternlight/mini");
  embedFn = tern.embed;
  engineInfoFn = tern.engineInfo;
  ready = true;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  // Always init first
  if (!ready) {
    try {
      await init();
    } catch (err) {
      self.postMessage({
        type: "error",
        id: msg.id ?? 0,
        message: "Failed to load embeddings engine: " + (err as Error).message,
      });
      return;
    }
  }

  if (msg.type === "info") {
    try {
      const info = engineInfoFn!();
      self.postMessage({ type: "info", info });
    } catch (err) {
      self.postMessage({
        type: "error",
        id: 0,
        message: (err as Error).message,
      });
    }
    return;
  }

  if (msg.type === "embed") {
    const embeddings: number[][] = [];
    try {
      for (let i = 0; i < msg.texts.length; i++) {
        const vec = embedFn!(msg.texts[i]);
        embeddings.push(Array.from(vec));
        if (i % 50 === 0 || i === msg.texts.length - 1) {
          self.postMessage({
            type: "progress",
            done: i + 1,
            total: msg.texts.length,
          });
        }
      }
      self.postMessage({ type: "embeddings", id: msg.id, embeddings });
    } catch (err) {
      self.postMessage({
        type: "error",
        id: msg.id,
        message: (err as Error).message,
      });
    }
  }
};
