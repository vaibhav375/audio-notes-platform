import type { Metadata } from "next";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Architecture · Audio Notes",
  description:
    "How this app takes an audio file from the browser to a stored transcript and summary.",
};

type Lane = "browser" | "server" | "gnani" | "llm" | "store";

type Step = {
  lane: Lane;
  timing: "sync" | "background";
  title: string;
  body: string;
};

const LANE_LABEL: Record<Lane, string> = {
  browser: "Browser",
  server: "App server",
  gnani: "Gnani",
  llm: "LLM",
  store: "Storage",
};

/**
 * The flow, with the lane and the sync/background split encoded per step —
 * requirements 1 and 4 of the brief read directly off this list.
 */
const FLOW: Step[] = [
  {
    lane: "browser",
    timing: "sync",
    title: "The file is decoded before it leaves the machine",
    body:
      "The Web Audio API decodes the file at 16 kHz. This doubles as validation: anything the browser cannot decode is corrupt or not audio, and it is rejected here — before any bytes are uploaded and before a paid API call is made.",
  },
  {
    lane: "browser",
    timing: "sync",
    title: "Audio over the size limit is re-encoded in the browser",
    body:
      "Files already under the cap in a compressed format pass through untouched. Anything larger is downmixed to mono and encoded to MP3 at a bitrate chosen so the whole recording fits. See long-audio handling below.",
  },
  {
    lane: "store",
    timing: "sync",
    title: "The browser uploads straight to blob storage",
    body:
      "The app server only issues a short-lived upload token; the audio itself never passes through it. Serverless functions cap request bodies well below 10 MB, so routing the file through an API route would break the very uploads this app exists to handle.",
  },
  {
    lane: "server",
    timing: "sync",
    title: "A note row is written, then a Gnani batch job is created and started",
    body:
      "Both happen inside the upload request. That is deliberate: by the time the browser gets a response, the user knows whether the file was accepted by the ASR provider, instead of discovering a rejection minutes later from a background poll.",
  },
  {
    lane: "gnani",
    timing: "background",
    title: "Gnani pulls the audio and transcribes it",
    body:
      "The job references the object's public HTTPS URL, so Gnani fetches the bytes directly rather than having them re-uploaded through this app. The job moves through CREATED → STARTING → QUEUED → IN_PROGRESS → COMPLETED.",
  },
  {
    lane: "server",
    timing: "background",
    title: "Completion arrives by webhook, with polling as the fallback",
    body:
      "Gnani calls back to /api/gnani/webhook when the job finishes. The callback is treated as a signal only — the handler re-reads the job from the API through the same reconcile function the poller uses, so a forged callback cannot write results into the database.",
  },
  {
    lane: "server",
    timing: "background",
    title: "The transcript is downloaded and persisted immediately",
    body:
      "Gnani returns a pre-signed transcript URL that expires after one hour. It is fetched and stored on the note row at once, so reopening a recording weeks later reads from this database and never from the provider.",
  },
  {
    lane: "llm",
    timing: "background",
    title: "The stored transcript is summarised",
    body:
      "A single call to an OpenAI-compatible chat endpoint. The transcript is already durable at this point, so a summary failure marks only that stage failed and offers a retry of just the LLM call — it never costs the transcription again.",
  },
  {
    lane: "browser",
    timing: "sync",
    title: "The page polls a status endpoint and renders real state",
    body:
      "Polling runs every four seconds and stops as soon as the note reaches a terminal state. The progress readout comes from the job's actual lifecycle status, not a timer.",
  },
];

const IMPROVEMENTS: { title: string; body: string }[] = [
  {
    title: "A real job queue instead of reconcile-on-request",
    body:
      "State is advanced by whoever asks about it — the upload request, the webhook, or a poll. It is idempotent and self-healing, but a durable queue with dedicated workers, visibility timeouts and dead-lettering is the right shape once traffic is not one user at a time.",
  },
  {
    title: "Chunked transcription for very long recordings",
    body:
      "Beyond roughly 90 minutes, browser-side decoding becomes a memory problem and the bitrate needed to fit 10 MB starts to hurt accuracy. Splitting audio on silence into overlapping segments, transcribing them as a multi-file batch job and stitching the results would remove the ceiling entirely.",
  },
  {
    title: "Map-reduce summarisation",
    body:
      "Transcripts are truncated at 48,000 characters before summarising. Summarising per-segment and then summarising the summaries would handle arbitrarily long recordings and give better coverage of the middle of a long meeting.",
  },
  {
    title: "Accounts and per-user isolation",
    body:
      "Every visitor currently sees one shared library. Real multi-tenancy means authentication, a user_id on every row, and signed rather than public blob URLs — the current public URLs exist because Gnani fetches them directly.",
  },
  {
    title: "Retention and cleanup",
    body:
      "Audio objects are never deleted today. A scheduled job dropping blobs past a retention window — keeping the transcript and summary, which are what people come back for — would bound storage cost.",
  },
  {
    title: "Tests and observability",
    body:
      "The pipeline's state machine is the part most worth testing, with the Gnani client faked at the HTTP boundary. Structured logs keyed by note id, plus alerting on the failed-note rate, would replace reading the database to find out what broke.",
  },
  {
    title: "Server-side transcoding as a fallback",
    body:
      "Decoding in the browser costs nothing to run and validates the file early, but it inherits the browser's codec support. An ffmpeg worker behind the upload would cover exotic formats and free the client entirely.",
  },
];

export default function ArchitecturePage() {
  return (
    <article className="doc">
      <header className="doc__head">
        <p className="eyebrow">Engineering notes</p>
        <h1 className="doc__title">How this works</h1>
        <p className="doc__lede">
          An audio file goes in, a transcript and a summary come out, and the
          interesting parts are all in between: a 10 MB per-file limit on the
          transcription API, a 60-second limit on its synchronous endpoint, and a
          hosting model with no long-running process to poll from.
        </p>
      </header>

      <section className="doc__section" aria-labelledby="flow">
        <h2 id="flow" className="doc__h2">
          <span className="doc__num">01</span> Upload to transcript, end to end
        </h2>
        <p className="doc__p">
          Each step below is tagged with where it runs and whether the user is
          waiting on it.
        </p>

        <ol className="flow">
          {FLOW.map((step, index) => (
            <li key={index} className={`flow__step flow__step--${step.timing}`}>
              <div className="flow__rail" aria-hidden="true">
                <span className="flow__dot" />
              </div>
              <div className="flow__body">
                <div className="flow__tags">
                  <span className={`tag tag--${step.lane}`}>{LANE_LABEL[step.lane]}</span>
                  <span className={`tag tag--${step.timing}`}>
                    {step.timing === "sync" ? "user is waiting" : "background"}
                  </span>
                </div>
                <h3 className="flow__title">{step.title}</h3>
                <p className="flow__text">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="doc__section" aria-labelledby="storage">
        <h2 id="storage" className="doc__h2">
          <span className="doc__num">02</span> Where the audio actually lives
        </h2>
        <p className="doc__p">
          Audio bytes go to <strong>Vercel Blob</strong>, an S3-backed object store,
          and nowhere else. The database holds only a reference: the object&apos;s
          public HTTPS URL and its pathname, alongside the original filename, the
          original and uploaded byte counts, and whether the file was re-encoded.
          Audio blobs are never written into Postgres.
        </p>
        <p className="doc__p">
          The objects are publicly readable, with unguessable random suffixes in
          their paths. That is a deliberate trade: Gnani&apos;s batch API fetches the
          audio itself from the URL it is given, so the object has to be reachable
          without our credentials. With accounts in place the right answer is
          short-lived signed URLs minted per job instead.
        </p>
        <p className="doc__p">
          <strong>Retention is not implemented.</strong> Objects persist
          indefinitely. Transcripts and summaries are the durable artifacts worth
          keeping; the audio is the expensive part to store, and a scheduled sweep
          deleting blobs past a retention window is the obvious next step.
        </p>
        <p className="doc__p">
          Metadata and results live in <strong>Neon Postgres</strong> — a managed
          instance, not a file on the server&apos;s disk. Serverless filesystems are
          ephemeral, so a SQLite file would quietly lose every past upload on the
          next deploy, and &ldquo;past uploads are reopenable&rdquo; would break in a
          way nothing visibly reports.
        </p>
      </section>

      <section className="doc__section" aria-labelledby="long-audio">
        <h2 id="long-audio" className="doc__h2">
          <span className="doc__num">03</span> Long audio: two limits, two answers
        </h2>

        <h3 className="doc__h3">The 60-second limit — solved by not using that endpoint</h3>
        <p className="doc__p">
          Gnani&apos;s synchronous <code>POST /stt/v3</code> endpoint returns a
          transcript in one response, but caps at 60 seconds of audio. This app
          must handle recordings of two minutes and up, so that endpoint cannot
          carry the requirement.
        </p>
        <p className="doc__p">
          It would have been possible to route short files through the sync
          endpoint for lower latency and long files through the batch API.{" "}
          <strong>Everything goes through the batch API instead.</strong> One code
          path means one failure model, one progress representation and one set of
          states to test — and no cliff where a 61-second file behaves completely
          differently from a 59-second one for reasons no user could predict.
        </p>

        <h3 className="doc__h3">The 10 MB limit — solved in the browser</h3>
        <p className="doc__p">
          The batch API accepts at most 10 MB per file. That is roomy for
          compressed audio and useless for uncompressed: two minutes of 44.1 kHz
          stereo WAV is already about 21 MB, so the assignment&apos;s own
          two-minute requirement fails on a plain WAV without intervention.
        </p>
        <p className="doc__p">
          Before uploading, the browser decodes the file at 16 kHz, downmixes to
          mono, and encodes to MP3 at a bitrate computed from the actual duration —
          the highest rate between 24 and 64 kbps that still fits the whole
          recording under the cap. A short file keeps good fidelity; a long one
          degrades gracefully instead of being rejected. Mono at 16 kHz is not a
          compromise for speech recognition: it is what ASR models consume anyway.
        </p>

        <div className="figures">
          <Figure value="~1 min" label="of 44.1 kHz stereo WAV fits in 10 MB" muted />
          <Figure value="~40 min" label="fits after re-encoding, at 32 kbps mono" />
          <Figure value="90 min" label="hard ceiling this app will accept" muted />
        </div>

        <p className="doc__p">
          Doing this client-side costs no server CPU, needs no ffmpeg binary in a
          serverless bundle, and gives the user a real progress phase to watch
          instead of an opaque wait. It also catches corrupt files at the earliest
          possible moment. The cost is a dependency on the browser&apos;s codec
          support, and a hard ceiling where decoding a very long file would exhaust
          browser memory — hence the 90-minute limit, with a clear error rather
          than a crash.
        </p>
      </section>

      <section className="doc__section" aria-labelledby="sync">
        <h2 id="sync" className="doc__h2">
          <span className="doc__num">04</span> Synchronous versus background
        </h2>
        <div className="split">
          <div className="split__col">
            <h3 className="doc__h3">Inside the request the user waits on</h3>
            <ul className="doc__list">
              <li>Decoding, validation and re-encoding, in the browser</li>
              <li>The upload itself, browser to blob storage</li>
              <li>Writing the note row</li>
              <li>Creating and starting the Gnani batch job</li>
            </ul>
            <p className="doc__p doc__p--tight">
              All of it is fast, and all of it can fail in ways worth telling the
              user about immediately. A rejected file should never look like a
              successful upload.
            </p>
          </div>
          <div className="split__col">
            <h3 className="doc__h3">After the response</h3>
            <ul className="doc__list">
              <li>Transcription, entirely on Gnani&apos;s side</li>
              <li>Downloading and persisting the transcript</li>
              <li>Summarising the transcript</li>
            </ul>
            <p className="doc__p doc__p--tight">
              The browser finds out by polling <code>/api/notes/[id]</code> every
              four seconds, and stops the moment the note is terminal.
            </p>
          </div>
        </div>

        <h3 className="doc__h3">There is no worker process — and that is the design</h3>
        <p className="doc__p">
          Serverless functions cannot hold a background loop open, so instead of
          pretending to have a worker, one idempotent{" "}
          <code>reconcileNote()</code> function advances a note by one step, and it
          is called from three directions: the upload request, Gnani&apos;s webhook,
          and every status poll. Loading the library sweeps any note that has not
          been polled in the last minute.
        </p>
        <p className="doc__p">
          The practical result is that a note is never stranded because someone
          closed their tab: the webhook finishes it, and if the webhook never
          arrives, the next person to open the app does. A job that stays
          non-terminal for thirty minutes is marked failed with a reason, so the UI
          stops polling something that will never finish.
        </p>
      </section>

      <section className="doc__section" aria-labelledby="failure">
        <h2 id="failure" className="doc__h2">
          <span className="doc__num">05</span> How failure is surfaced
        </h2>
        <p className="doc__p">
          Every note carries a persisted status and, when it fails, the stage that
          failed and the provider&apos;s own message. Failed uploads stay in the
          library rather than disappearing, because &ldquo;it vanished&rdquo; is a
          worse outcome than &ldquo;it failed, and here is why&rdquo;.
        </p>
        <ul className="doc__list">
          <li>
            <strong>Unreadable or corrupt files</strong> are caught by the browser
            decode step, named as such, and never uploaded.
          </li>
          <li>
            <strong>Files too large even after re-encoding</strong> are rejected
            with the actual size and the actual limit, and a suggestion to split
            the recording.
          </li>
          <li>
            <strong>Transient Gnani failures</strong> — 429s and 5xx — are retried
            with exponential backoff inside the API client, and do not fail a job
            that is still healthy.
          </li>
          <li>
            <strong>Slow jobs</strong> get a distinct &ldquo;taking longer than
            usual&rdquo; state after five minutes, so waiting is visibly different
            from broken.
          </li>
          <li>
            <strong>A failed summary</strong> keeps the transcript and offers a
            retry of only the LLM call.
          </li>
          <li>
            <strong>A dropped connection</strong> pauses polling with a notice
            saying processing continues server-side, then resumes on its own.
          </li>
        </ul>
      </section>

      <section className="doc__section" aria-labelledby="stack">
        <h2 id="stack" className="doc__h2">
          <span className="doc__num">06</span> Stack, and why
        </h2>
        <dl className="stack-list">
          <StackItem
            name="Next.js on Vercel"
            why="One deployable for UI and API. Chosen over a container host mainly for cold starts: free-tier containers sleep and can take the better part of a minute to answer the first request, which is the wrong first impression for a link someone opens once."
          />
          <StackItem
            name="Neon Postgres"
            why="Managed, always-on, and survives redeploys — which is the entire requirement behind reopenable past uploads."
          />
          <StackItem
            name="Vercel Blob"
            why="Direct browser-to-storage uploads sidestep the serverless request body limit, and public object URLs are what Gnani's cloud-storage job source needs."
          />
          <StackItem
            name="Gnani STT Batch"
            why="The only one of the two speech endpoints that handles audio longer than 60 seconds, and its per-job status is what drives the progress UI."
          />
          <StackItem
            name="Qwen over an OpenAI-compatible endpoint"
            why="Summarisation is three environment variables, so the deployed app and a local Ollama instance run identical code. No provider is baked into the source."
          />
        </dl>
      </section>

      <section className="doc__section" aria-labelledby="improve">
        <h2 id="improve" className="doc__h2">
          <span className="doc__num">07</span> What I would do with more time
        </h2>
        <ul className="improvements">
          {IMPROVEMENTS.map((item) => (
            <li key={item.title} className="improvements__item">
              <h3 className="improvements__title">{item.title}</h3>
              <p className="improvements__body">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="doc__section" aria-labelledby="source">
        <h2 id="source" className="doc__h2">
          <span className="doc__num">08</span> Source
        </h2>
        <p className="doc__p">
          The full source, including local setup instructions and the environment
          variables this app needs, is on GitHub.
        </p>
        <a className="repo-link" href={env.repoUrl} target="_blank" rel="noreferrer">
          <span className="repo-link__label">Repository</span>
          <span className="repo-link__url">{env.repoUrl.replace(/^https:\/\//, "")}</span>
        </a>
      </section>
    </article>
  );
}

function Figure({
  value,
  label,
  muted,
}: {
  value: string;
  label: string;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "figure figure--muted" : "figure"}>
      <span className="figure__value">{value}</span>
      <span className="figure__label">{label}</span>
    </div>
  );
}

function StackItem({ name, why }: { name: string; why: string }) {
  return (
    <div className="stack-list__item">
      <dt className="stack-list__name">{name}</dt>
      <dd className="stack-list__why">{why}</dd>
    </div>
  );
}
