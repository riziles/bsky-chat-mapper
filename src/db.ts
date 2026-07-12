import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "bsky-chat-mapper";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("messages")) {
          db.createObjectStore("messages", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "did" });
        }
      },
    });
  }
  return dbPromise;
}

export interface StoredMessage {
  id: string;
  text: string;
  senderDid: string;
  sentAt: string;
  embedding?: Float32Array;
}

export async function storeMessages(
  messages: StoredMessage[],
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messages", "readwrite");
  for (const msg of messages) {
    tx.store.put(msg);
  }
  await tx.done;
}

export async function getMessagesForConvo(
  convoId: string,
): Promise<StoredMessage[]> {
  const db = await getDB();
  // We prefix message IDs with convo ID for namespacing
  const prefix = `${convoId}:`;
  const all = await db.getAll("messages");
  return all.filter((m) => m.id.startsWith(prefix));
}

export async function clearMessages(): Promise<void> {
  const db = await getDB();
  await db.clear("messages");
}
