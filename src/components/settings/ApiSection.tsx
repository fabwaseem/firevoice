import { useState } from "react";
import { BookOpen, Check, Copy, FileJson } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Card, CardBody, CardHeader, Segmented } from "@/components/ui";
import { useHealth } from "@/lib/api/hooks";
import { openExternal } from "@/lib/external";
import { useSettings } from "@/stores/settings";

type Example = "agent" | "curl" | "python" | "javascript";

const TABS: { value: Example; label: string }[] = [
  { value: "agent", label: "AI agent" },
  { value: "curl", label: "curl" },
  { value: "python", label: "Python" },
  { value: "javascript", label: "JavaScript" },
];

/** What to send with every request when the server asks for a token, per language. */
function examples(base: string, token: string | null): Record<Example, string> {
  const t = token ?? "";
  return {
    agent: [
      "You can make speech, clone voices and transcribe audio with FireVoice, a text-to-speech app running on this computer.",
      "",
      `Base URL: ${base}`,
      token ? `Auth: send the header "Authorization: Bearer ${t}" with every request.` : "Auth: none needed.",
      `Full reference (OpenAPI): ${base}/openapi.json. Read it before using a route that is not listed here.`,
      `The same reference as a page for people (Swagger): ${base}/docs`,
      "",
      "Main routes (JSON in, JSON out unless noted):",
      "- GET  /health                      is the server up",
      "- GET  /api/v1/voices               voices you can use (id, name, language, gender)",
      "- GET  /api/v1/styles               delivery styles (calm, excited, audiobook...)",
      "- GET  /api/v1/engines              speech models and whether each is installed",
      '- POST /api/v1/tts                  {"text", "voice", "style", "format": "mp3"} -> the audio file as bytes',
      '                                    add "response": "json" to get base64 audio with word timings instead',
      "- POST /api/v1/stt                  multipart form, field \"file\" -> text with word timings",
      '- POST /api/v1/jobs                 {"kind": "tts", "payload": {"request": {...}, "format": "mp3"}} for long scripts;',
      "                                    then GET /api/v1/jobs/{id} until done and GET /api/v1/jobs/{id}/audio",
      "- POST /v1/audio/speech             OpenAI-compatible speech; POST /v1/audio/transcriptions likewise",
      "",
      "Rules:",
      '- Use a voice id from /api/v1/voices; "default" is the user\'s default voice.',
      '- In text, "[pause 500ms]" adds a pause.',
      '- Errors are JSON: {"error": {"code", "message"}}. Show the message to the user.',
      "- Save audio to a file and tell the user where it is. The server only answers while the FireVoice app is open.",
    ].join("\n"),
    curl: [
      `curl -X POST ${base}/api/v1/tts \\`,
      ...(token ? [`  -H "Authorization: Bearer ${t}" \\`] : []),
      '  -H "Content-Type: application/json" \\',
      `  -d '{"text": "Hello from FireVoice.", "voice": "default", "style": "conversational", "format": "mp3"}' \\`,
      "  -o hello.mp3",
    ].join("\n"),
    python: [
      "import requests",
      "",
      "r = requests.post(",
      `    "${base}/api/v1/tts",`,
      ...(token ? [`    headers={"Authorization": "Bearer ${t}"},`] : []),
      '    json={"text": "Hello from FireVoice.", "voice": "default", "style": "conversational", "format": "mp3"},',
      ")",
      "r.raise_for_status()",
      'open("hello.mp3", "wb").write(r.content)',
    ].join("\n"),
    javascript: [
      `const r = await fetch("${base}/api/v1/tts", {`,
      '  method: "POST",',
      `  headers: { "Content-Type": "application/json"${token ? `, Authorization: "Bearer ${t}"` : ""} },`,
      '  body: JSON.stringify({ text: "Hello from FireVoice.", voice: "default", style: "conversational", format: "mp3" }),',
      "});",
      "if (!r.ok) throw new Error((await r.json()).error.message);",
      "const audio = await r.arrayBuffer(); // the MP3 file",
    ].join("\n"),
  };
}

function CopyButton({ text, what, label }: { text: string; what: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} aria-label={`Copy ${what.toLowerCase()}`} leading={done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
      {label ?? "Copy"}
    </Button>
  );
}

function Row({ label, value, copy }: { label: string; value: string; copy?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-[13px]">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[12.5px] text-ink-2" title={value}>
          {value}
        </span>
        {copy && <CopyButton text={value} what={copy} />}
      </dd>
    </div>
  );
}

/** Settings > API: everything another program or an AI agent needs to use FireVoice on this computer. */
export function ApiSection() {
  const base = useSettings((s) => s.serverUrl);
  const token = useSettings((s) => s.token);
  const health = useHealth();
  const [tab, setTab] = useState<Example>("agent");
  const online = health.isSuccess;
  const needsToken = !!health.data?.auth;
  const text = examples(base, needsToken ? token || "YOUR_TOKEN" : null)[tab];

  return (
    <Card>
      <CardHeader
        title="API"
        description="Use FireVoice from your own programs and AI agents. It answers on this computer while the app is open. Every route, with examples you can run, is in the API docs (Swagger)."
        action={<Badge tone={online ? "ok" : "neutral"} dot>{online ? "Running" : "Not running"}</Badge>}
      />
      <CardBody>
        <dl className="divide-y divide-line">
          <Row label="Address" value={base} copy="Address" />
          <Row label="Reference for agents (OpenAPI)" value={`${base}/openapi.json`} copy="Reference link" />
          <Row
            label="Token"
            value={!online ? "Start FireVoice's voice engine to see this" : needsToken ? "Required: send Authorization: Bearer <token>" : "Not needed on this computer"}
          />
          {health.data?.api_version != null && <Row label="API version" value={`${health.data.api_version} (FireVoice ${health.data.version})`} />}
        </dl>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <Segmented value={tab} onChange={setTab} options={TABS} size="sm" ariaLabel="Example" />
          <CopyButton text={text} what={tab === "agent" ? "Agent instructions" : "Example"} label={tab === "agent" ? "Copy instructions" : "Copy"} />
        </div>
        <p className="mt-2.5 text-[12.5px] text-muted">
          {tab === "agent"
            ? "Paste this into your AI agent (its instructions, a project file or the chat). It tells the agent how to use FireVoice."
            : "Turns a line of text into an MP3 with your default voice."}
        </p>
        <pre
          tabIndex={0}
          aria-label={tab === "agent" ? "Agent instructions" : "Example request"}
          className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-surface-2 p-3 font-mono text-[12px] leading-[1.55] text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-fire/50"
        >
          {text}
        </pre>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!online} leading={<BookOpen className="size-3.5" />} onClick={() => openExternal(`${base}/docs`)}>
            Open the API docs (Swagger)
          </Button>
          <Button variant="outline" size="sm" disabled={!online} leading={<FileJson className="size-3.5" />} onClick={() => openExternal(`${base}/openapi.json`)}>
            Open the OpenAPI file
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
