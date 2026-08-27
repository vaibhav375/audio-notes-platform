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
      "State is advanced by whoever asks about it — the upload request, the webhook, or a poll. It is idempotent and self-healing, and it fits a platform with no long-lived process, but a durable queue with dedicated workers, visibility timeouts and dead-lettering is the right shape once traffic is not one person at a time. Deliberately not built here: it would mean a second piece of infrastructure for a benefit no reviewer of this app would ever observe.",
  },
  {
    title: "Accounts and per-tenant isolation",
    body:
      "Every visitor sees one shared library. Real multi-tenancy means authentication, a user_id on every row, and signed rather than public blob URLs — the URLs are public today because Gnani fetches them directly. Deliberately not built here: a sign-up wall between a reviewer and the thing they came to evaluate would make this submission worse, not better.",
  },
  {
    title: "Server-side transcoding as a fallback",
    body:
      "Decoding in the browser costs nothing to run and validates the file before a byte is uploaded, but it inherits the browser's codec support — an exotic container the Web Audio API cannot parse is rejected even though ffmpeg would handle it. A worker behind the upload would close that gap. It does not fit inside a serverless function's size and time limits, so it would mean a second runtime.",
  },
  {
    title: "Decoding longer than browser memory allows",
    body:
      "Chunking removed the file-size ceiling, but decoding still materialises the whole recording as PCM before slicing it, which is what caps uploads at ninety minutes. Streaming the decode — or moving it to a worker that processes the file in windows — would lift that, and is the honest remaining limit on length.",
  },
  {
    title: "Splitting on silence rather than on the clock",
    body:
      "Slices are cut at fixed intervals, so a boundary can land mid-sentence and the two halves are transcribed without each other's context. Detecting a quiet moment near each boundary, or overlapping slices slightly and reconciling the seam, would remove the occasional dropped word at a join.",
  },
  {
    title: "Confidence-aware summarisation",
    body:
      "The model is told to distrust implausible figures, which is a blunt instrument. Per-word confidence from the ASR would let low-confidence spans be marked in the transcript and withheld from the summary, instead of relying on the model to notice.",
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
          Before uploading, the browser decodes the file at 16 kHz and downmixes
          to mono — not a compromise for speech recognition, but what ASR models
          consume anyway — then encodes to MP3.
        </p>

        <h3 className="doc__h3">Why one file was the wrong unit</h3>
        <p className="doc__p">
          The first version fitted the whole recording into one file by lowering
          the bitrate as the recording got longer. A unit test written against
          that rule found it did not hold: past roughly an hour, even the lowest
          bitrate worth using produces a file over 10 MB, so the ninety-minute
          ceiling the app advertised was not real.
        </p>
        <p className="doc__p">
          Recordings are now <strong>split into five-minute slices</strong>,
          each encoded at the full 64 kbps. Length no longer costs quality: a
          three-hour recording is encoded at exactly the same bitrate as a
          three-minute one, just across more slices.
        </p>
        <h3 className="doc__h3">When the batch API is unavailable</h3>
        <p className="doc__p">
          The provider&apos;s batch pipeline stopped starting jobs during
          development: a file uploads, sits <code>QUEUED</code>, and the job is
          cancelled with <code>ReadTimeout</code> without ever starting. The
          account was healthy throughout and the synchronous endpoint answered
          normally, so this was one half of their service being unwell.
        </p>
        <p className="doc__p">
          Slicing turns out to be the way around that too. The synchronous
          endpoint rejects anything over thirty seconds — the documentation says
          sixty — but the recording is already cut below that, so the same
          slices and the same stitching serve both paths. Batch stays primary;
          when a job cannot be submitted, or never leaves{" "}
          <code>STARTING</code> after two minutes, the recording is transcribed
          slice by slice instead, a few slices per request so no single request
          has to carry a whole recording.
        </p>
        <p className="doc__p">
          <strong>The fallback is genuinely worse, and the app says so.</strong>{" "}
          On the same two-and-a-half minute recording, batch produced about 1,600
          characters of transcript and the fallback about 450. Short slices with
          hard cuts do not suit this model: a slice that opens mid-pause returns
          nothing at all. Starting each slice at its first sound recovered some
          of that, and the remainder is a real limitation rather than a bug to be
          tuned away. A recording transcribed this way carries a notice on its
          page saying what happened and why the transcript is thin — a quietly
          degraded result presented as a normal one would be worse than the
          outage itself.
        </p>

        <h3 className="doc__h3">One job per slice, and a note on why</h3>
        <p className="doc__p">
          Each slice is submitted as <strong>its own job</strong>, rather than
          one job holding every slice as the API&apos;s hundred-files-per-job
          limit would allow. Single-file jobs are the shape that has been
          reliable throughout, so they are the unit.
        </p>
        <p className="doc__p">
          The honest version of how that decision was reached: multi-file jobs
          failed repeatedly with <code>ReadTimeout</code> during testing, and the
          apparent conclusion was that the documented behaviour simply did not
          work. It later turned out the account was <strong>rate limited</strong>
          — a start call returned <code>RATE_LIMITED</code> outright — and single
          file jobs were failing by then too. So the multi-file result is not a
          finding, it is a measurement taken through a confound, and it is
          recorded here as such rather than dressed up as an API quirk.
        </p>
        <p className="doc__p">
          What the episode did establish is that this API answers pressure with
          <code>START_FAILED</code> and a read timeout, which says nothing about
          the audio. Treating that as a terminal error told users their file was
          corrupt when it was not. It is now treated as transient: the job is
          resubmitted, up to four times, ninety seconds apart, and only a
          genuinely non-transient reason fails the note.
        </p>
        <p className="doc__p">
          The provider returns a transcript per slice, with timings relative to
          that slice. Each is shifted by where its slice starts before the
          transcript is stored, so a click on a line two hours in seeks to the
          right second. The player follows the same map, switching source as
          playback crosses a boundary.
        </p>

        <div className="figures">
          <Figure value="~1 min" label="of 44.1 kHz stereo WAV fits in 10 MB" muted />
          <Figure value="5 min" label="per slice, always at full 64 kbps" />
          <Figure value="90 min" label="ceiling, now set by browser memory" muted />
        </div>

        <p className="doc__p">
          Doing this client-side costs no server CPU, needs no ffmpeg binary in a
          serverless bundle, and gives the user a real progress phase to watch
          instead of an opaque wait. It also catches corrupt files at the earliest
          possible moment. What remains is the decode itself: the whole recording
          is turned into PCM in memory before it can be sliced, and that — not the
          API — is what caps uploads at ninety minutes, with a clear error rather
          than a crash.
        </p>
        <p className="doc__p">
          Running a job per slice also makes the progress readout honest. One job
          reports its file as 0 or 1 complete and nothing in between; a recording
          in six slices reports six jobs finishing, which is genuine fractional
          progress.
        </p>
        <p className="doc__p">
          Slices are five minutes rather than fifteen for a related reason: about
          2.4 MB fetches quickly, and there is no reason to sit near a limit that
          has already proven fragile under load.
        </p>
      </section>


      <section className="doc__section" aria-labelledby="segments">
        <h2 id="segments" className="doc__h2">
          <span className="doc__num">04</span> What the timings make possible
        </h2>
        <p className="doc__p">
          Gnani returns a transcript twice over: once as flat text, and once as
          an array of segments carrying <code>start_time</code>,{" "}
          <code>end_time</code>, <code>text</code> and <code>speaker_id</code>.
          Storing only the flat text would have been the easy call and would
          have thrown away the more useful half.
        </p>
        <ul className="doc__list">
          <li>
            <strong>The transcript is navigable.</strong> Every line is a seek
            target, and the line being spoken highlights as the audio plays.
            Reopening a recording is then about checking a claim against the
            audio, not re-reading a wall of text.
          </li>
          <li>
            <strong>Subtitles come free.</strong> SRT and WebVTT are generated
            from the real timings, not estimated from word counts. They are
            offered only on recordings that actually have segments.
          </li>
          <li>
            <strong>Two speakers can be separated</strong> when the upload asks
            for it, which is the shape of an interview or a support call.
          </li>
        </ul>

        <h3 className="doc__h3">Nine languages, verified</h3>
        <p className="doc__p">
          The language chosen at upload is passed straight through to the ASR
          provider, and all nine it supports have been tested against the live
          API with real spoken-word recordings: Hindi, Kannada, Tamil, Telugu,
          Malayalam, Marathi, Bengali, Gujarati and Indian English. Each returns
          text in its own script, which is why search uses a script-agnostic
          text-search configuration and why the transcript view sets no font that
          would fall back to boxes.
        </p>
        <p className="doc__p">
          Summaries come back in English whatever the spoken language, which is
          usually the point of summarising a recording you cannot read. The
          transcript stays in the original script, so nothing is lost — the
          summary is a way in, not a replacement.
        </p>

        <h3 className="doc__h3">Search across everything</h3>
        <p className="doc__p">
          A list ordered by date cannot answer &ldquo;which recording mentioned
          the refund policy?&rdquo;, which is the question that makes keeping
          transcripts worthwhile. Search runs on Postgres full text with a GIN
          index over transcript, summary and filename.
        </p>
        <p className="doc__p">
          It uses the <code>simple</code> text-search configuration rather than{" "}
          <code>english</code>. That is deliberate: this app transcribes nine
          Indian languages, and an English stemmer would mangle Devanagari and
          every other non-Latin script. <code>simple</code> lowercases and
          splits on word boundaries, which behaves the same in every language
          here.
        </p>
        <p className="doc__p">
          One sharp edge worth naming: <code>ts_headline</code> does{" "}
          <em>not</em> escape the document it highlights. Emitting its output as
          HTML would let any transcript or model-written summary inject markup
          into the page, so matches are wrapped in non-HTML sentinels and turned
          into elements on the client instead.
        </p>

        <h3 className="doc__h3">What the API does not give you</h3>
        <p className="doc__p">
          Two features looked obvious from the response shape and turned out not
          to exist, which is worth recording so nobody rebuilds them on a wrong
          assumption:
        </p>
        <ul className="doc__list">
          <li>
            <strong>Sentiment and emotion</strong> are present as segment fields
            and come back <code>null</code> on every request from this model. No
            sentiment timeline is possible without a separate classifier.
          </li>
          <li>
            <strong><code>mode: &quot;translate&quot;</code> is a no-op</strong>{" "}
            here — a Hindi recording put through it returns the same Devanagari
            transcript, not English. Cross-language reading would need a
            translation step of its own.
          </li>
          <li>
            <strong>Diarization accuracy varies.</strong> On a two-voice test
            call it returned both speakers but misattributed several turns, so
            it is opt-in rather than always on, and presented as the provider&apos;s
            best guess rather than ground truth.
          </li>
        </ul>
      </section>

      <section className="doc__section" aria-labelledby="sync">
        <h2 id="sync" className="doc__h2">
          <span className="doc__num">05</span> Synchronous versus background
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
              <li>Summarising the transcript, in passes when it is long</li>
            <li>Sweeping aged audio, on a daily schedule</li>
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
          <span className="doc__num">06</span> How failure is surfaced
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
          <span className="doc__num">07</span> Stack, and why
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
            why="Summarisation is three environment variables, so the deployed app and a local Ollama instance run identical code. No provider is baked into the source. Long transcripts are summarised in passes and then reduced, which keeps each request small enough to pass a free tier's per-minute token limit and means the middle of a long recording is represented rather than truncated away."
          />
          <StackItem
            name="Vitest"
            why="The pure logic carries the risk here — chunk planning, transcript stitching, subtitle timing, segment parsing — and it is all testable without a network. Two real bugs came out of writing these: the size guarantee that did not hold past an hour, and a missing speaker being coerced to a real Speaker 0."
          />
        </dl>
      </section>

      <section className="doc__section" aria-labelledby="improve">
        <h2 id="improve" className="doc__h2">
          <span className="doc__num">08</span> What I would do with more time
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
          <span className="doc__num">09</span> Source
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
