import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/lib/auth";
import AppleSignInButton from "@/components/AppleSignInButton";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Incorrect email or password.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string; error?: string };
}) {
  const session = await auth();
  const destination = searchParams.callbackUrl || "/welcome";
  if (session) redirect(searchParams.callbackUrl || "/tasks");

  async function credentialsSignIn(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: destination,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        redirect(`/login?error=invalid&callbackUrl=${encodeURIComponent(destination)}`);
      }
      throw error;
    }
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-mobile">
        <div className="flex justify-center ">
          <Image
            src="/logo.jpeg"
            alt="Ch'rps logo"
            width={120}
            height={120}
            priority
          />
        </div>
        <div className="mb-16 text-center">
          <h1 className="font-brand font-extrabold text-5xl text-olive leading-tight mb-3">
            Ch&apos;rps
          </h1>
          <p className="text-muted font-brand font-bold text-base">
            Checklists Trusted Every Time.
          </p>
        </div>


        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: destination });
          }}
        >
          <button
            type="submit"
            className="w-full flex items-center justify-center gap-3 bg-card border-2 border-olive text-text py-4 rounded-xl font-body font-medium hover:bg-card-hover transition-colors"
          >
            <GoogleIcon />
            Continue with Google
          </button>
        </form>

        <div className="mt-3">
          <AppleSignInButton destination={destination} />
        </div>

        <div className="flex items-center gap-3 my-6">
          <div className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-dim">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {searchParams.error && (
          <p className="text-burgundy-light text-xs text-center mb-4">
            {ERROR_MESSAGES[searchParams.error] ?? "Something went wrong. Please try again."}
          </p>
        )}

        <form action={credentialsSignIn} className="space-y-3">
          <input
            type="email"
            name="email"
            placeholder="Email"
            required
            autoComplete="email"
            className="w-full bg-card border border-border rounded-xl px-4 py-3.5 font-body text-sm text-text placeholder:text-dim focus:outline-none focus:border-olive"
          />
          <input
            type="password"
            name="password"
            placeholder="Password"
            required
            autoComplete="current-password"
            className="w-full bg-card border border-border rounded-xl px-4 py-3.5 font-body text-sm text-text placeholder:text-dim focus:outline-none focus:border-olive"
          />
          <button
            type="submit"
            className="w-full bg-olive text-white py-4 rounded-xl font-body font-medium hover:bg-olive-light transition-colors"
          >
            Sign in
          </button>
        </form>

        <p className="text-muted text-sm text-center mt-6">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-olive font-medium">
            Sign up
          </Link>
        </p>

        <p className="text-muted text-xs text-center mt-10">
          Your data is private to your account.{" "}
          <Link href="/privacy" className="text-olive">
            Privacy Policy
          </Link>
        </p>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
