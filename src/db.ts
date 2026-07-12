import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "bsky-chat-mapper";
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains("messages")) {
            db.createObjectStore("messages", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("sessions")) {
            db.createObjectStore("sessions", { keyPath: "did" });
          }
        }
        if (oldVersion < 2) {
          // Recreate messages store with convoId index
          if (db.objectStoreNames.contains("messages")) {
            db.deleteObjectStore("messages");
          }
          const store = db.createObjectStore("messages", { keyPath: "id" });
          store.createIndex("convoId", "convoId");
        }
      },
    });
  }
  return dbPromise;
}

export interface StoredMessage {
  id: string;
  convoId: string;
  text: string;
  senderDid: string;
  senderHandle?: string;
  senderDisplayName?: string;
  sentAt: string;
  embedding?: number[];
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
  return db.getAllFromIndex("messages", "convoId", convoId);
}

export async function getMessageCount(convoId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex("messages", "convoId", convoId);
}

export async function clearConvo(convoId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messages", "readwrite");
  const keys = await tx.store.index("convoId").getAllKeys(convoId);
  for (const key of keys) {
    tx.store.delete(key);
  }
  await tx.done;
}

export async function storeEmbeddings(
  updates: { id: string; embedding: number[] }[],
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messages", "readwrite");
  for (const { id, embedding } of updates) {
    const existing = await tx.store.get(id);
    if (existing) {
      tx.store.put({ ...existing, embedding });
    }
  }
  await tx.done;
}

export async function getEmbeddedMessages(
  convoId: string,
): Promise<StoredMessage[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("messages", "convoId", convoId);
  return all.filter((m) => m.embedding != null && m.embedding.length > 0);
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  await db.clear("messages");
}
