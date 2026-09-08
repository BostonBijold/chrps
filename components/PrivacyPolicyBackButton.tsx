"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

// /privacy is a single shared page reached from three different places
// (Profile's in-app link, and the public Login/Signup pages) — there's no
// one fixed "parent" route to hardcode a Link to, unlike most other
// back-button call sites in this app. router.back() returns to whichever
// of those actually brought the user here. Falls back to "/" only when
// there's no history to go back to (e.g. the page was opened directly from
// a shared link or bookmark), so the button always does something.
export default function PrivacyPolicyBackButton() {
  const router = useRouter();

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px] -ml-1 pr-2"
      aria-label="Back"
    >
      <ChevronLeft size={18} strokeWidth={1.75} />
      Back
    </button>
  );
}
