"use client";

import { useState, type FormEvent } from "react";

/**
 * Minimal upload form (skeleton). Selects a client and one-or-more photos,
 * POSTs them to /api/upload, and shows the persisted row statuses.
 */
export default function UploadForm() {
  const [clientId, setClientId] = useState("");
  const [feedback, setFeedback] = useState<string>("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFeedback("Uploading…");
    const data = new FormData(e.currentTarget);
    const res = await fetch("/api/upload", { method: "POST", body: data });
    const json = (await res.json()) as unknown;
    setFeedback(
      res.ok
        ? `Uploaded: ${JSON.stringify(json)}`
        : `Error: ${JSON.stringify(json)}`,
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        Client ID
        <input
          name="clientId"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </label>
      <label>
        Photos
        <input name="photos" type="file" multiple />
      </label>
      <button type="submit">Upload</button>
      {feedback ? <p>{feedback}</p> : null}
    </form>
  );
}
