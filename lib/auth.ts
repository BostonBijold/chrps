import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import { cookies } from "next/headers";
import clientPromise from "@/lib/mongodb-client";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import NativeSignInHandoff from "@/models/NativeSignInHandoff";
import authConfig from "@/lib/auth.config";
import { verifyPassword } from "@/lib/password";

// Set (as a cookie, SameSite=None in production — same treatment as
// auth.config.ts's state/nonce cookies, since it must survive Apple's
// cross-site form_post callback) by app/api/native-apple-signin/route.ts
// before the sheet ever navigates to Apple, and read back by the jwt
// callback below. See that callback for why this can't just be threaded
// through as a query param the way callbackUrl is.
export const NATIVE_HANDOFF_COOKIE = "native_handoff_id";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // Credentials lives only here (the Node-runtime config), not in
  // auth.config.ts — its authorize() needs Mongoose + bcrypt, neither of
  // which can run in middleware.ts's Edge runtime. middleware only ever
  // validates an existing session, never calls authorize(), so it doesn't
  // need this provider registered.
  providers: [
    ...authConfig.providers,
    Credentials({
      credentials: { email: {}, password: {}, handoffId: {} },
      async authorize(credentials) {
        // Native Sign in with Apple handoff (see
        // app/api/native-handoff/status/route.ts, models/NativeSignInHandoff.ts)
        // — not a real password check, a one-time, expiring, server-issued
        // token proving a session already exists for this user inside the
        // in-app browser sheet.
        const handoffId = String(credentials?.handoffId ?? "");
        if (handoffId) {
          await connectDB();
          const record = await NativeSignInHandoff.findOneAndUpdate(
            { handoffId, consumed: false, expiresAt: { $gt: new Date() } },
            { $set: { consumed: true } }
          );
          if (!record) return null;
          const user = await User.findById(record.userId);
          if (!user || user.deletedAt) return null;
          return { id: user._id.toString(), email: user.email, name: user.name };
        }

        const email = String(credentials?.email ?? "").toLowerCase().trim();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        await connectDB();
        const user = await User.findOne({ email });
        // Same null return for "no such user" and "Google-only account, no
        // password set yet" — never reveal which case it was.
        if (!user?.passwordHash) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return { id: user._id.toString(), email: user.email, name: user.name };
      },
    }),
  ],
  adapter: MongoDBAdapter(clientPromise),
  callbacks: {
    // authConfig's own redirect callback (the chrps:// passthrough native
    // Apple sign-in depends on) must be spread in explicitly — this whole
    // object literal REPLACES, not merges with, authConfig.callbacks in
    // the ...authConfig spread above, since `callbacks` is a top-level key
    // in both.
    ...authConfig.callbacks,
    async jwt({ token, user, account }) {
      console.log("[auth] jwt callback — user:", user?.id, "token sub:", token?.sub);
      if (user) {
        token.id = user.id;
        // Native Sign in with Apple handoff: write the NativeSignInHandoff
        // row right here, inline, as part of the SAME request that
        // processes Apple's callback — not via a later redirect to a
        // dedicated route the way this used to work. That earlier design
        // (app/api/native-handoff/complete, now removed) required the
        // @capacitor/browser sheet to still be open and connected for a
        // SECOND round trip after the callback, and a live device trace
        // showed the callback POST itself getting cut off (Status: 0) the
        // moment a user tapped the sheet's own "Done" button mid-request
        // — so that second request, and the handoff row it was supposed
        // to write, simply never happened. Writing it here means it's
        // already done by the time the jwt callback returns, which is
        // strictly before NextAuth computes any response at all — so it
        // survives the sheet closing at literally any point afterward.
        if (account?.provider === "apple") {
          try {
            const cookieStore = cookies();
            const handoffId = cookieStore.get(NATIVE_HANDOFF_COOKIE)?.value;
            console.log("[auth] apple jwt callback — handoffId cookie present:", Boolean(handoffId));
            if (handoffId) {
              await connectDB();
              const record = await NativeSignInHandoff.create({
                handoffId,
                userId: user.id,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
              });
              console.log("[auth] wrote NativeSignInHandoff row:", record._id.toString(), "for handoffId:", handoffId);
              cookieStore.delete(NATIVE_HANDOFF_COOKIE);
            }
          } catch (err) {
            // Never let a handoff-write hiccup break ordinary sign-in —
            // the button's own timeout/error state is the fallback here.
            console.log("[auth] native handoff write failed:", err);
          }
        }
      }
      // JWT sessions carry no server-side revocation by default — a token
      // issued before DELETE /api/account scrubbed this user stays
      // cryptographically valid until its own expiry otherwise. Returning
      // null here is the documented way to force that session invalid on
      // its very next read, same request-freshness guarantee
      // resolveSessionUser() already gives companyId/role. See
      // docs/features/account-deletion.md.
      if (token.id) {
        await connectDB();
        const dbUser = await User.findById(token.id, "deletedAt").lean<{ deletedAt?: Date | null }>();
        if (!dbUser || dbUser.deletedAt) return null;
      }
      return token;
    },
    session({ session, token }) {
      console.log("[auth] session callback — token:", token?.id, "session:", session?.user?.email);
      if (token?.id) session.user.id = token.id as string;
      return session;
    },
  },
  events: {
    async signIn({ user, account, isNewUser }) {
      console.log("[auth] signIn event — user:", user?.email, "provider:", account?.provider, "isNewUser:", isNewUser);
    },
    async createUser({ user }) {
      console.log("[auth] createUser event — user:", user?.id, user?.email);
      await connectDB();
      // The adapter writes the new user doc directly via its own MongoDB
      // driver, bypassing Mongoose — schema defaults never apply to that
      // insert. Stamp role explicitly so it's visible (and hand-editable) in
      // MongoDB right away. companyId stays unset: v1 has no self-serve
      // company creation — a developer manually attaches a pre-created
      // Company doc by hand. Task list seeding now happens per-company (see
      // the Tasks page's first-visit seed check), not per-user at
      // signup, since there's no company to seed against yet.
      await User.updateOne({ _id: user.id }, { $set: { role: "manager" } });
    },
    async session({ session }) {
      console.log("[auth] session event — email:", session?.user?.email);
    },
  },
});
