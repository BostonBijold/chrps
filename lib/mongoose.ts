import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI!;

interface Cached {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

const g = global as typeof globalThis & { __mongoose?: Cached };
const cached: Cached = g.__mongoose ?? { conn: null, promise: null };
g.__mongoose = cached;

export async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, { bufferCommands: false }).catch((err) => {
      // A rejected connect must not stay cached on `global` — otherwise every
      // later request on this same warm container re-throws this same stale
      // error forever, with no new attempt ever made, until a cold start
      // rebuilds `global` from scratch.
      cached.promise = null;
      throw err;
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
