"use client";

import { useState } from "react";
import { Uploader } from "@/components/Uploader";
import { NoteList } from "@/components/NoteList";
import { SearchBar } from "@/components/SearchBar";

export default function HomePage() {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="stack">
      <Uploader onStarted={() => setRefreshToken((value) => value + 1)} />
      <SearchBar />
      <NoteList refreshToken={refreshToken} />
    </div>
  );
}
