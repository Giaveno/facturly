import Link from "next/link";
import UploadForm from "./upload-form";

export default function Home() {
  return (
    <main>
      <h1>Facturas ARCA</h1>
      <p>ARCA invoicing automation.</p>
      <UploadForm />
      <p>
        <Link href="/review">Review rows →</Link>
      </p>
    </main>
  );
}
