import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import clientPromise from "@/lib/mongodb-client";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import authConfig from "@/lib/auth.config";
import { verifyPassword } from "@/lib/password";

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
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
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
    async jwt({ token, user }) {
      console.log("[auth] jwt callback — user:", user?.id, "token sub:", token?.sub);
      if (user) token.id = user.id;
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
