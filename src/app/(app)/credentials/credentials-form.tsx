"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface CertificateInfo {
  subjectCn: string;
  cuit: string | null;
  notBefore: string;
  notAfter: string;
}

/**
 * Credential upload form. Pastes the accountant's X.509 certificate and private
 * key (PEM) and POSTs them to /api/credentials. On success it shows the loaded
 * certificate's PUBLIC metadata — the private key is never echoed back.
 */
export default function CredentialsForm() {
  const router = useRouter();
  const [feedback, setFeedback] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFeedback("");
    setError("");
    setSaving(true);
    const data = new FormData(e.currentTarget);
    const payload = {
      certPem: String(data.get("certPem") ?? ""),
      keyPem: String(data.get("keyPem") ?? ""),
    };

    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    const json = (await res.json()) as CertificateInfo & { error?: string };
    if (res.ok) {
      setFeedback(
        `Saved. Subject "${json.subjectCn}", CUIT ${json.cuit ?? "n/a"}, expires ${json.notAfter}.`,
      );
      router.refresh();
    } else {
      setError(json.error ?? "Failed to save credentials");
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        Certificate (PEM)
        <textarea name="certPem" rows={6} required />
      </label>
      <label>
        Private key (PEM)
        <textarea name="keyPem" rows={8} required />
      </label>
      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save credentials"}
      </button>
      {feedback ? <p>{feedback}</p> : null}
      {error ? <p>{error}</p> : null}
    </form>
  );
}
