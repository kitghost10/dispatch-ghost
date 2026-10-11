"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions";
export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return <form action={action} className="grid">
    <label>Email<input name="email" type="email" autoComplete="username" required /></label>
    <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
    <button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    {state?.error ? <p role="alert" className="error">{state.error}</p> : null}
  </form>;
}
