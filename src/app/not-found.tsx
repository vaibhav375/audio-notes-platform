import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty card" style={{ marginTop: "3rem" }}>
      <p className="empty__title">That page does not exist</p>
      <p className="empty__body">
        The recording may have been deleted, or the link may be wrong.{" "}
        <Link href="/">Back to the library</Link>.
      </p>
    </div>
  );
}
