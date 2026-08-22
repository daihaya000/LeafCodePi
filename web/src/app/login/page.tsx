import { Suspense } from "react";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text">
          <p className="text-sm text-muted">読み込み中…</p>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
